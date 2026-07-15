#!/usr/bin/env node
// =============================================================================
// verify-phase7.mjs — Phase 7(Hybrid RAG: 검색 + 출처 답변) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase7-build-spec.md §9 시나리오(1~8)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + FormData + Blob 만 사용한다(외부 의존성 없음, Node ≥18).
//
// 인증(Bearer) + Slack import 는 scripts/verify-phase6.mjs 와 동일 패턴을 재사용한다:
//   - POST /v1/auth/register → res.json.tokens.accessToken
//   - POST /v1/slack/import (multipart: 필드 먼저 + file 은 Blob 으로 마지막)
//
// 파이프라인은 2단계 비동기다.
//   (1) Slack import: BullMQ slack-import 워커가 번들을 파싱해 slack_messages/threads 적재.
//       → GET /v1/slack/workspaces/:id 를 폴링해 messageCount 도달·lastImportedAt 확인.
//   (2) RAG 인덱싱: import 성공 후 rag-index 큐가 스레드/메시지를 청킹 → chunks upsert →
//       EmbeddingProvider 로 256차원 임베딩 → embeddings upsert.
//       → POST /v1/ai/retrieval 이 결과(hasEvidence/hasFtsMatch)를 줄 때까지 ≤15s 폴링.
//
// RAG 대상 스코프는 개인 데이터 컨테이너 workspaces.id 다(= slackWorkspaceSummary.workspaceId).
//   work-query/retrieval body 의 workspaceId 는 slack_workspaces.id 가 아니라 workspaces.id 다.
//
// 근거 충분성(refused)은 앱 로직이다(스펙 §1.3): 상위 결과 중 FTS 매칭(similarity>0.1)이
//   하나도 없으면 refused=true 로 LLM 을 호출하지 않는다. Mock 환경에선 키워드(FTS) 매칭이
//   근거 판정을 지배하므로 결정적이다. LLM 은 컨텍스트 설명만 한다.
//
// 접근제어(PRD §26): RAG/Slack 데이터는 workspaces.ownerUserId == 현재 userId 인
//   **소유자 본인만** 조회할 수 있다 → 비소유자(userB)는 403.
//
// 멱등(스펙 §1.1): chunks UNIQUE(workspaceId, sourceType, sourceRefId) + onConflictDoUpdate,
//   embeddings UNIQUE(chunkId) + onConflictDoUpdate → 재import/재인덱싱해도 청크가 늘지 않는다.
//   여기서는 재import 후 retrieval 결과 수가 안정임을 관찰해 간접 확인한다.
//
// 로그 정책(PRD §11): 메시지/청크 **원문·snippet·PII·secret·임베딩값**을 출력하지 않는다.
//   개수/식별자(채널명·ts·chunkId 접두)·불리언/길이만 출력한다.
//
// 실행법:
//   1) 전체 스택 기동(진행자 사전 수행): docker compose up -d --build
//      (+ migrate 0007 chunks/embeddings + HNSW/GIN 인덱스)
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-phase7.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase7.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
// =============================================================================

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// import 파싱 폴링 상한 + RAG 인덱싱 폴링 상한(스펙 §9-2 = 15초) + 폴링 간격.
const IMPORT_TIMEOUT_MS = 15_000;
const RAG_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

// RRF score 내림차순 비교용 부동소수 허용 오차.
const EPS = 1e-9;

let passed = 0;
let failed = 0;

/* -------------------------------------------------------------------------- */
/* 요약 / assert / step 유틸(verify-phase6 스타일)                              */
/* -------------------------------------------------------------------------- */

function summary() {
  console.log('');
  console.log('────────────────────────────────────────');
  console.log(`요약: 통과 ${passed} · 실패 ${failed}`);
  console.log('────────────────────────────────────────');
}

/** 조건이 거짓이면 명확한 메시지 출력 후 즉시 process.exit(1). */
function assert(cond, msg, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ FAIL: ${msg}`);
  if (extra !== undefined) {
    // extra 는 상태코드/개수/식별자 등 비민감 정보만 전달한다(원문/snippet/secret/임베딩 금지).
    console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  summary();
  console.error('\n검증 실패. 위 항목을 확인하세요.');
  process.exit(1);
}

function step(n, title) {
  console.log(`\n[${n}] ${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* Slack ts / occurredAt 헬퍼                                                  */
/* -------------------------------------------------------------------------- */

// Slack ts = "epoch.micro" 문자열. occurredAt = new Date(Number(ts.split('.')[0])*1000)
// (스펙 §1.4 / parser / 청킹 root occurredAt). 검증도 동일 규약으로 계산한다.
function tsToIso(ts) {
  return new Date(Number(String(ts).split('.')[0]) * 1000).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Slack export 번들 — 구분되는 기술 스레드 + 일반 잡담(스펙 §9-1)              */
/* -------------------------------------------------------------------------- */
// 채널 2 / 유저 2 / 스레드 2(기술) + 단독 잡담 2.
//   C_infra(eng-infra):
//     · Route53 스레드(루트+답글2)  — work-query 정답 스레드(sourceRefId = 루트 ts)
//     · PostgreSQL 파티셔닝 스레드(루트+답글1)
//   C_random(random):
//     · 잡담 단독 메시지 2건(thread_ts 없음 → 비-스레드 청크)
//
// 청킹은 스레드 단위(스펙 §1.1): thread chunk.text = 각 메시지 "작성자명: 내용" 을 ts순 개행 결합.
//   정답 스레드는 키워드(Route53/인증서/ACM/재발급/해결)를 반복해 FTS trgm 유사도를
//   질문 "Route53 인증서 문제 어떻게 해결했어?" 대비 임계(0.1) 이상으로 확실히 넘긴다.
//   잡담·PostgreSQL 스레드는 그 질문/환율 질문과 키워드가 겹치지 않게 구분한다.
const CH = { infra: 'eng-infra', random: 'random' };

const TS = {
  r53Root: '1721300000.000100', // Route53 스레드 루트 (C_infra, U1)
  r53Reply1: '1721300060.000200', // Route53 답글1        (C_infra, U2)
  r53Reply2: '1721300120.000300', // Route53 답글2        (C_infra, U1)
  pgRoot: '1721300400.000100', // PostgreSQL 스레드 루트   (C_infra, U1)
  pgReply1: '1721300460.000200', // PostgreSQL 답글1        (C_infra, U2)
  chat1: '1721300800.000100', // 잡담1 단독               (C_random, U1)
  chat2: '1721300860.000200', // 잡담2 단독               (C_random, U2)
};

// 정답 스레드 식별자(citation 검증 기준). thread chunk 의 sourceRefId = threadTs(=루트 ts).
const ANSWER_SOURCE_REF_ID = TS.r53Root;
const ANSWER_CHANNEL_NAME = CH.infra;

// 총 메시지 수(import 파싱 완료 판정). 스레드 3+2, 잡담 2 = 7.
const TOTAL_MESSAGES = 7;

// 질의(스펙 §9-3/§9-6). retrieval 폴링/직접호출용 키워드 질의는 정답 스레드와 강하게 겹친다.
const RETRIEVAL_QUERY = 'Route53 인증서 ACM 재발급 갱신 실패';
const WORK_QUERY_Q = 'Route53 인증서 문제 어떻게 해결했어?';
const NO_EVIDENCE_Q = '다음 분기 환율 전망은?';

// 멱등 검증에서 전체 청크를 넉넉히 담기 위한 topK.
const IDEMPOTENCY_TOPK = 20;

function buildBundle() {
  return {
    workspace: { name: `RAG 검증 슬랙 ${RUN}`, slackTeamId: `T-${RUN}` },
    channels: [
      { id: 'C1', name: CH.infra },
      { id: 'C2', name: CH.random },
    ],
    users: [
      { id: 'U1', name: 'soobeen', real_name: '수빈' },
      { id: 'U2', name: 'alex', real_name: 'Alex Kim' },
    ],
    messages: [
      // ── Route53 인증서 스레드(정답) — 키워드 반복으로 FTS 매칭 확실화 ──
      {
        channel: 'C1',
        ts: TS.r53Root,
        user: 'U1',
        text: 'Route53 인증서 갱신 실패 문제가 발생했습니다',
        thread_ts: TS.r53Root,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.r53Reply1,
        user: 'U2',
        text: 'ACM 에서 인증서를 재발급하면 해결됩니다',
        thread_ts: TS.r53Root,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.r53Reply2,
        user: 'U1',
        text: 'ACM 재발급으로 Route53 인증서 갱신 실패 문제 해결 완료했습니다',
        thread_ts: TS.r53Root,
        edited_ts: null,
      },
      // ── PostgreSQL 파티셔닝 스레드(구분되는 기술 스레드) ──
      {
        channel: 'C1',
        ts: TS.pgRoot,
        user: 'U1',
        text: 'PostgreSQL 파티셔닝 도입 결정 논의를 시작합니다',
        thread_ts: TS.pgRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.pgReply1,
        user: 'U2',
        text: '월 단위 range 파티셔닝으로 도입 결정했습니다',
        thread_ts: TS.pgRoot,
        edited_ts: null,
      },
      // ── 일반 잡담(단독 메시지, thread_ts 없음) ──
      {
        channel: 'C2',
        ts: TS.chat1,
        user: 'U1',
        text: '오늘 점심 다들 뭐 드셨어요',
        edited_ts: null,
      },
      {
        channel: 'C2',
        ts: TS.chat2,
        user: 'U2',
        text: '저는 김밥 먹었어요',
        edited_ts: null,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP 헬퍼(verify-phase6 스타일)                                             */
/* -------------------------------------------------------------------------- */

/** 사용자 인증(Bearer) JSON HTTP 헬퍼. 반환: { status, json }. */
async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    assert(false, `요청 실패 ${method} ${path} — 서버 연결 불가`, err?.message);
    return; // unreachable (assert exits)
  }

  const text = await res.text();
  let json;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, json };
}

/**
 * 번들 multipart 업로드(POST /v1/slack/import). FormData 에 필드를 먼저,
 * 파일 file 을 마지막에 붙인다(서버가 필드 → 파일 순으로 스트림 파싱). 반환: { status, json }.
 */
async function importBundle(token, bundleJson, { mySlackUserId, workspaceName, kind } = {}) {
  const form = new FormData();
  if (mySlackUserId !== undefined) form.append('mySlackUserId', mySlackUserId);
  if (workspaceName !== undefined) form.append('workspaceName', workspaceName);
  if (kind !== undefined) form.append('kind', kind);
  form.append('file', new Blob([bundleJson], { type: 'application/json' }), 'bundle.json');

  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}/slack/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` }, // content-type 은 fetch 가 boundary 와 함께 설정.
      body: form,
    });
  } catch (err) {
    assert(false, 'POST /v1/slack/import 요청 실패 — 서버 연결 불가', err?.message);
    return; // unreachable
  }

  const text = await res.text();
  let json;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, json };
}

/** 서버 준비 대기(최대 ~30s). 준비 안 되면 명확 메시지 후 종료. */
async function waitForApi() {
  const deadline = Date.now() + 30_000;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}${PREFIX}/health/live`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.message ?? 'connection error';
    }
    await sleep(1000);
  }
  assert(false, `API(${BASE}) 준비되지 않음 — health/live 실패`, lastErr);
}

function email(label) {
  return `${label}-${RUN}@example.com`.toLowerCase();
}

/** 회원가입 → { token, email, name }(실패 시 종료). */
async function registerUser(label) {
  const em = email(label);
  const res = await req('POST', '/auth/register', {
    body: { email: em, password: PASSWORD, name: label },
  });
  assert(res.status === 201, `${label} 회원가입 201`, res.status);
  const token = res.json?.tokens?.accessToken;
  assert(typeof token === 'string' && token.length > 0, `${label} accessToken 수신`);
  return { token, email: em, name: label };
}

/* -------------------------------------------------------------------------- */
/* Slack workspace 폴링(import 완료·workspaceId 도출)                          */
/* -------------------------------------------------------------------------- */

/** GET /v1/slack/workspaces/:id → { status, json }. */
async function getWorkspace(token, id) {
  return req('GET', `/slack/workspaces/${id}`, { token });
}

/** 워크스페이스가 predicate 를 만족할 때까지 폴링(≤timeout). 반환: { ok, ws }(마지막 관측). */
async function pollWorkspace(token, id, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await getWorkspace(token, id);
    if (res.status === 200 && res.json) {
      last = res.json;
      try {
        if (predicate(res.json)) return { ok: true, ws: res.json };
      } catch {
        /* keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, ws: last };
}

/* -------------------------------------------------------------------------- */
/* RAG 검색/질의 헬퍼                                                          */
/* -------------------------------------------------------------------------- */

/** POST /v1/ai/retrieval → { status, json }. */
async function retrieval(token, { workspaceId, query, topK }) {
  const body = { workspaceId, query };
  if (topK !== undefined) body.topK = topK;
  return req('POST', '/ai/retrieval', { token, body });
}

/** POST /v1/ai/work-query → { status, json }. */
async function workQuery(token, { workspaceId, question }) {
  return req('POST', '/ai/work-query', { token, body: { workspaceId, question } });
}

/**
 * RAG 인덱싱이 끝나 retrieval 이 결과를 줄 때까지 폴링(≤timeout).
 * predicate(json) → boolean. 반환: { ok, json }(마지막 관측).
 */
async function pollRetrieval(token, params, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await retrieval(token, params);
    if (res.status === 200 && res.json) {
      last = res.json;
      try {
        if (predicate(res.json)) return { ok: true, json: res.json };
      } catch {
        /* keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, json: last };
}

/** score 내림차순(비증가)인지 검사(부동소수 오차 허용). */
function isScoreDescending(items) {
  for (let i = 1; i < items.length; i += 1) {
    if (Number(items[i - 1].score) + EPS < Number(items[i].score)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Phase 7 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  const bundleJson = JSON.stringify(buildBundle());

  // ── 1) userA 회원가입 + Slack import(기술 스레드 포함) ─────────────────────
  step(1, 'userA(소유자) 회원가입 + Slack export 번들 업로드(Route53/PostgreSQL 스레드 + 잡담)');
  const userA = await registerUser('rag-owner-a');
  console.log(
    `  · 번들 요약: 채널 2, 유저 2, 메시지 ${TOTAL_MESSAGES}(Route53 스레드 3, PostgreSQL 스레드 2, 잡담 2)`,
  );
  const imp1 = await importBundle(userA.token, bundleJson, {
    mySlackUserId: 'U1',
    workspaceName: `RAG 검증 슬랙 ${RUN}`,
    kind: 'company',
  });
  assert(imp1.status === 200, 'POST /v1/slack/import 200', imp1.status);
  assert(imp1.json?.status === 'queued', "import status === 'queued'", imp1.json?.status);
  const importId1 = imp1.json?.importId;
  const slackWorkspaceId = imp1.json?.slackWorkspaceId;
  assert(typeof importId1 === 'string' && importId1.length > 0, 'importId 반환');
  assert(
    typeof slackWorkspaceId === 'string' && slackWorkspaceId.length > 0,
    'slackWorkspaceId 반환',
  );

  // import 파싱 완료 폴링 → 개인 컨테이너 workspaceId(= RAG 스코프) 도출.
  step(2, 'import 파싱 완료 폴링 → workspaceId(개인 컨테이너) 도출');
  const poll1 = await pollWorkspace(
    userA.token,
    slackWorkspaceId,
    (ws) => ws.messageCount >= TOTAL_MESSAGES && ws.lastImportedAt != null,
    IMPORT_TIMEOUT_MS,
  );
  assert(poll1.ok, `import 파싱 완료(messageCount=${TOTAL_MESSAGES} 도달, 15s 내)`, {
    messageCount: poll1.ws?.messageCount,
    lastImportedAt: poll1.ws?.lastImportedAt == null ? 'null' : 'set',
  });
  const ws1 = poll1.ws;
  assert(ws1.channelCount === 2, 'channelCount === 2', ws1.channelCount);
  assert(ws1.userCount === 2, 'userCount === 2', ws1.userCount);
  const workspaceId = ws1.workspaceId;
  assert(
    typeof workspaceId === 'string' && workspaceId.length > 0,
    'workspaceId(workspaces.id — RAG/AI 스코프) 도출',
  );
  const firstImportedAt = ws1.lastImportedAt;

  // ── 2) RAG 인덱싱 폴링(≤15s): retrieval 이 결과를 줄 때까지 ────────────────
  step(3, 'RAG 인덱싱 폴링(≤15s): POST /v1/ai/retrieval 이 근거 있는 결과를 줄 때까지');
  const ragReady = await pollRetrieval(
    userA.token,
    { workspaceId, query: RETRIEVAL_QUERY, topK: 5 },
    (r) =>
      r.hasEvidence === true &&
      Array.isArray(r.items) &&
      r.items.length > 0 &&
      r.items[0]?.hasFtsMatch === true &&
      r.items.some((it) => it?.citation?.sourceRefId === ANSWER_SOURCE_REF_ID),
    RAG_TIMEOUT_MS,
  );
  assert(ragReady.ok, 'RAG 인덱싱 완료(retrieval 이 정답 청크 포함 근거 결과 반환, 15s 내)', {
    hasEvidence: ragReady.json?.hasEvidence,
    itemCount: Array.isArray(ragReady.json?.items) ? ragReady.json.items.length : 'n/a',
  });

  // ── 4) retrieval 직접 검증: hasEvidence=true, top hasFtsMatch=true, RRF 내림차순 ──
  step(4, 'retrieval 직접 호출: hasEvidence=true · top hasFtsMatch=true · RRF score 내림차순');
  const ret = await retrieval(userA.token, { workspaceId, query: RETRIEVAL_QUERY, topK: 5 });
  assert(ret.status === 200, 'POST /v1/ai/retrieval 200(소유자)', ret.status);
  assert(ret.json?.hasEvidence === true, 'hasEvidence === true(FTS 매칭 존재)', ret.json?.hasEvidence);
  const items = Array.isArray(ret.json?.items) ? ret.json.items : [];
  assert(items.length > 0, 'retrieval items 비어있지 않음', items.length);
  assert(items[0]?.hasFtsMatch === true, 'top 항목 hasFtsMatch === true', {
    topHasFtsMatch: items[0]?.hasFtsMatch,
  });
  assert(
    items.every((it) => typeof it.chunkId === 'string' && it.chunkId.length > 0),
    'retrieval 항목마다 chunkId 존재',
  );
  assert(
    items.every((it) => typeof it.hasFtsMatch === 'boolean'),
    'retrieval 항목마다 hasFtsMatch 불리언',
  );
  assert(
    items.every((it) => typeof it.score === 'number' && Number.isFinite(it.score)),
    'retrieval 항목마다 score 숫자',
  );
  assert(isScoreDescending(items), 'retrieval items 가 RRF score 내림차순 정렬', {
    scores: items.map((it) => Number(it.score).toFixed(4)),
  });
  // 정답 청크(Route53 스레드)가 결과에 포함되고 FTS 매칭이다.
  const retAnswer = items.find((it) => it?.citation?.sourceRefId === ANSWER_SOURCE_REF_ID);
  assert(!!retAnswer, '정답 스레드 청크가 retrieval 결과에 포함(sourceRefId 일치)');
  assert(retAnswer?.hasFtsMatch === true, '정답 청크 hasFtsMatch === true');
  assert(
    retAnswer?.citation?.channelName === ANSWER_CHANNEL_NAME,
    `정답 청크 channelName === '${ANSWER_CHANNEL_NAME}'`,
    retAnswer?.citation?.channelName,
  );

  // ── 3) work-query(관련 질문): refused=false, 정답 citations, answer non-empty ──
  step(5, `work-query 관련 질문 "${WORK_QUERY_Q}" → refused=false · 정답 인용 · answer non-empty`);
  const wq = await workQuery(userA.token, { workspaceId, question: WORK_QUERY_Q });
  assert(wq.status === 200, 'POST /v1/ai/work-query 200', wq.status);
  assert(wq.json?.refused === false, 'refused === false(근거 충분)', wq.json?.refused);
  assert(
    typeof wq.json?.answer === 'string' && wq.json.answer.length > 0,
    'answer 가 non-empty 문자열(LLM 컨텍스트 설명)',
    { answerLen: typeof wq.json?.answer === 'string' ? wq.json.answer.length : 'n/a' },
  );
  const citations = Array.isArray(wq.json?.citations) ? wq.json.citations : [];
  assert(citations.length > 0, 'citations 비어있지 않음', citations.length);
  assert(citations.length <= 5, 'citations 는 Top5 이내', citations.length);
  const answerCite = citations.find((c) => c?.sourceRefId === ANSWER_SOURCE_REF_ID);
  assert(!!answerCite, '정답 스레드가 citations Top5 에 포함(sourceRefId 일치)');
  assert(
    answerCite?.channelName === ANSWER_CHANNEL_NAME,
    `정답 인용 channelName === '${ANSWER_CHANNEL_NAME}'`,
    answerCite?.channelName,
  );
  assert(
    answerCite?.occurredAt === tsToIso(ANSWER_SOURCE_REF_ID),
    '정답 인용 occurredAt === 스레드 루트 ts 파생(ISO 절대시각)',
    { occurredAt: answerCite?.occurredAt, expected: tsToIso(ANSWER_SOURCE_REF_ID) },
  );
  const meta = wq.json?.meta;
  assert(
    meta != null && Number.isInteger(meta.retrievedCount) && meta.retrievedCount > 0,
    'meta.retrievedCount 양의 정수',
    { retrievedCount: meta?.retrievedCount },
  );
  assert(
    typeof meta?.model === 'string' && meta.model.length > 0,
    'meta.model non-empty(사용 모델 식별자)',
    { model: meta?.model },
  );

  // ── 5) 출처 100%: 모든 citation 이 channelName/sourceRefId/occurredAt/snippet 포함 ──
  step(6, '출처 100%: 모든 citation 이 channelName·sourceRefId·occurredAt·snippet·score 포함');
  assert(
    citations.every((c) => typeof c.sourceRefId === 'string' && c.sourceRefId.length > 0),
    '모든 citation 에 sourceRefId(문자열) 존재',
  );
  assert(
    citations.every((c) => typeof c.channelName === 'string' && c.channelName.length > 0),
    '모든 citation 에 channelName 존재(Slack 출처)',
  );
  assert(
    citations.every((c) => typeof c.occurredAt === 'string' && !Number.isNaN(Date.parse(c.occurredAt))),
    '모든 citation 에 occurredAt(ISO 파싱 가능) 존재',
  );
  assert(
    citations.every((c) => typeof c.snippet === 'string' && c.snippet.length > 0),
    '모든 citation 에 snippet(발췌) 존재',
  );
  assert(
    citations.every((c) => typeof c.score === 'number' && Number.isFinite(c.score)),
    '모든 citation 에 score(숫자) 존재',
  );

  // ── 6) 근거 없는 질문 → refused=true, citations 빈 배열, answer null(LLM 미호출) ──
  step(7, `근거 없는 질문 "${NO_EVIDENCE_Q}" → refused=true · citations 빈 배열 · answer null`);
  const noev = await workQuery(userA.token, { workspaceId, question: NO_EVIDENCE_Q });
  assert(noev.status === 200, 'POST /v1/ai/work-query 200(근거 없는 질문)', noev.status);
  assert(noev.json?.refused === true, 'refused === true(FTS 매칭 없음 → 앱 로직 거부)', noev.json?.refused);
  assert(
    Array.isArray(noev.json?.citations) && noev.json.citations.length === 0,
    'citations === 빈 배열',
    { citationsLen: Array.isArray(noev.json?.citations) ? noev.json.citations.length : 'n/a' },
  );
  assert(noev.json?.answer == null, 'answer === null(LLM 호출 안 함)', {
    answerIsNull: noev.json?.answer == null,
  });
  assert(
    typeof noev.json?.reason === 'string' && noev.json.reason.length > 0,
    'reason(거부 사유) non-empty',
  );

  // ── 7) 권한: 비소유자 userB 의 work-query/retrieval → 403 ──────────────────
  step(8, '권한: 비소유자 userB 의 userA workspace work-query/retrieval → 403(PRD §26)');
  const userB = await registerUser('rag-nonowner-b');
  const wqForbidden = await workQuery(userB.token, { workspaceId, question: WORK_QUERY_Q });
  assert(wqForbidden.status === 403, 'userB work-query 403', wqForbidden.status);
  const retForbidden = await retrieval(userB.token, { workspaceId, query: RETRIEVAL_QUERY, topK: 5 });
  assert(retForbidden.status === 403, 'userB retrieval 403', retForbidden.status);

  // ── 8) 멱등: 재import → 재인덱싱 후 retrieval 결과 수 안정(청크 중복 없음) ──
  step(9, '멱등: 재import → 재인덱싱 후 retrieval 결과 수 안정(chunks 중복 없음)');
  // 재인덱싱 전 전체 청크 수(넉넉한 topK 로 관측).
  const before = await retrieval(userA.token, {
    workspaceId,
    query: RETRIEVAL_QUERY,
    topK: IDEMPOTENCY_TOPK,
  });
  assert(before.status === 200, '재import 전 retrieval 200', before.status);
  const beforeCount = Array.isArray(before.json?.items) ? before.json.items.length : -1;
  assert(beforeCount > 0, '재import 전 청크 수(retrieval 결과) > 0', beforeCount);

  const imp2 = await importBundle(userA.token, bundleJson, {
    mySlackUserId: 'U1',
    workspaceName: `RAG 검증 슬랙 ${RUN}`,
    kind: 'company',
  });
  assert(imp2.status === 200, '재업로드 POST /v1/slack/import 200', imp2.status);
  assert(
    imp2.json?.slackWorkspaceId === slackWorkspaceId,
    '재업로드는 동일 slackWorkspaceId(소유 workspace 재사용)',
  );
  assert(imp2.json?.importId !== importId1, '재업로드는 새 importId(source_item 상이)');

  // 재import 파싱 완료(lastImportedAt 전진) → 재인덱싱 트리거됨을 확인.
  const poll2 = await pollWorkspace(
    userA.token,
    slackWorkspaceId,
    (ws) => ws.lastImportedAt !== firstImportedAt && ws.messageCount === TOTAL_MESSAGES,
    IMPORT_TIMEOUT_MS,
  );
  assert(poll2.ok, '재import 파싱 완료(lastImportedAt 전진, messageCount 불변)', {
    advanced: poll2.ok,
    messageCount: poll2.ws?.messageCount,
  });

  // 재인덱싱은 chunks/embeddings onConflictDoUpdate(멱등) — 결과 수가 안정임을 확인.
  // 재인덱싱이 반영될 시간을 짧게 폴링하되, 어느 시점에도 수가 늘지 않아야 한다.
  const stable = await pollRetrieval(
    userA.token,
    { workspaceId, query: RETRIEVAL_QUERY, topK: IDEMPOTENCY_TOPK },
    (r) => Array.isArray(r.items) && r.items.length === beforeCount,
    RAG_TIMEOUT_MS,
  );
  assert(
    stable.ok,
    `재인덱싱 후 retrieval 결과 수 안정(=${beforeCount}, 중복 없음)`,
    { before: beforeCount, after: Array.isArray(stable.json?.items) ? stable.json.items.length : 'n/a' },
  );

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). 원문/snippet/secret/임베딩 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
