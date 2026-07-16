#!/usr/bin/env node
// =============================================================================
// verify-phase8.mjs — Phase 8(장기 기억: 후보 추출 → 승인 → 수정/삭제) e2e 검증
// -----------------------------------------------------------------------------
// docs/phase8-build-spec.md §8 시나리오(1~12)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + FormData + Blob 만 사용한다(외부 의존성 없음, Node ≥18).
//
// 인증(Bearer) + Slack import 는 scripts/verify-phase7.mjs 와 동일 패턴을 재사용한다:
//   - POST /v1/auth/register → res.json.tokens.accessToken
//   - POST /v1/slack/import (multipart: 필드 먼저 + file 은 Blob 으로 마지막)
//
// 파이프라인은 3단계 비동기다.
//   (1) Slack import: BullMQ slack-import 워커가 번들을 파싱해 slack_messages/threads 적재.
//       → GET /v1/slack/workspaces/:id 를 폴링해 messageCount 도달·lastImportedAt 확인.
//   (2) RAG 인덱싱: import 성공 후 rag-index 큐가 스레드/메시지를 청킹 → chunks upsert →
//       임베딩. chunks 가 준비되어야 기억 추출이 후보를 만든다.
//       → POST /v1/ai/retrieval 이 결과(items>0)를 줄 때까지 ≤15s 폴링(= chunks 생성 확인).
//   (3) 기억 추출: POST /v1/memory/extract → memory-extract 큐가 각 chunk 텍스트를
//       규칙 추출(@family/rag extractMemoryCandidates)해 memory_candidates(pending) 적재.
//       → GET /v1/memory/candidates 를 폴링(≤15s)해 후보 등장·type 분류 확인.
//
// 추출은 결정적 규칙 함수다(packages/rag/src/extract.ts). 분류는 세그먼트(청크 텍스트를
//   "작성자: 내용" 줄 단위로 분할) 별 키워드 규칙이며 우선순위가 고정돼 있다:
//     incident(장애/에러/오류/실패/문제 + 해결/복구/조치/해소 등 해결 맥락) → task(담당/맡/…)
//     → decision(결정/하기로/선택했/…) → procedure(절차/방법/순서/단계) → preference → fact.
//   confidence 는 키워드 매칭 90, 순수 fact 60. 노이즈(키워드 없는 10자 미만 세그먼트)는 skip.
//   본 검증의 번들 문장은 각 스레드가 의도한 단일 type 으로만 분류되도록 규칙에 맞춰 작성했다.
//   incident 문장은 반드시 "해결 맥락"(예: 해결/해소)을 같은 줄에 포함한다(규칙 필수 조건).
//
// 스코프(workspaceId)는 개인 데이터 컨테이너 workspaces.id 다(= slackWorkspaceSummary.workspaceId).
//   RAG/AI 와 동일하게 memory API 의 workspaceId 도 slack_workspaces.id 가 아니라 workspaces.id 다.
//
// 접근제어(PRD §26): memory 는 workspaces.ownerUserId == 현재 userId 인 **소유자 본인만**.
//   비소유자(userB)는 목록/승인 모두 403. 후보/기억을 먼저 해석한 뒤 소유권을 재검증하므로
//   비소유자는 남의 기억을 읽거나 변경할 수 없다.
//
// 멱등(스펙 §1.1/§5): memory_candidates UNIQUE(workspaceId, sourceChunkId, type, subjectHash)
//   + onConflictDoNothing → extract 를 다시 실행해도 후보가 중복 생성되지 않는다(이미 승인/거부한
//   후보의 status 도 보존). 여기서는 재실행 후 후보 id 집합이 불변임을 관찰해 확인한다.
//
// 현재/과거(스펙 §1.3): current=true → status='approved' AND (validUntil null OR validUntil>now).
//   asOf=DATE → validFrom<=asOf AND (validUntil null OR validUntil>asOf). supersede 는 기존을
//   superseded(validUntil=now)로 만들고 새 기억(supersedesMemoryId, validFrom=now)을 만든다.
//
// 로그 정책(PRD §11): 후보/기억의 subject/content 원문·PII·secret 을 출력하지 않는다.
//   개수/식별자(candidateId·memoryId·sourceRefId(Slack ts)·type·status·불리언/길이)만 출력한다.
//
// 실행법:
//   1) 전체 스택 기동(진행자 사전 수행): docker compose up -d --build
//      (+ migrate 0008 memory_candidates/memories/memory_sources/memory_versions)
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-phase8.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase8.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
// =============================================================================

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// import 파싱 폴링 상한 + RAG 인덱싱 폴링 상한 + 기억 추출 폴링 상한(스펙 §8-3 = 15초).
const IMPORT_TIMEOUT_MS = 15_000;
const RAG_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 15_000;
// 멱등(재추출) 안정 관찰 창(재추출 잡이 처리될 시간을 주면서 후보가 늘지 않음을 확인).
const IDEMPOTENCY_WINDOW_MS = 12_000;
const POLL_INTERVAL_MS = 500;

let passed = 0;
let failed = 0;

/* -------------------------------------------------------------------------- */
/* 요약 / assert / step 유틸(verify-phase7 스타일)                              */
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
    // extra 는 상태코드/개수/식별자 등 비민감 정보만 전달한다(원문/subject/content/secret 금지).
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

/** 정렬된 문자열 배열 두 개가 동일한지(멱등 후보 집합 비교용). */
function sameStringSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Slack export 번들 — type 별 구분되는 스레드(스펙 §8-1)                        */
/* -------------------------------------------------------------------------- */
// 채널 2(eng-log/random) / 유저 2(soobeen/alex).
//   각 스레드 chunk 는 "작성자: 내용" 을 개행 결합하고, 규칙 추출은 줄(세그먼트) 단위로
//   분류하므로 아래 문장은 각각 의도한 단일 type 으로만 매칭되도록 키워드를 골랐다.
//     · decision 스레드 : '결정' / '선택했'      → decision (confidence 90)
//     · incident 스레드 : '장애'+'해결', '문제'+'해소' → incident (해결 맥락 필수)
//     · task     스레드 : '담당'                 → task
//     · procedure스레드 : '절차/단계/순서', '방법' → procedure
//     · fact     단독   : 키워드 없는 정보성 문장  → fact (confidence 60)
//     · 잡담     단독   : 10자 미만 → 노이즈 skip(후보 미생성)
const CH = { eng: 'eng-log', random: 'random' };

// Slack ts = "epoch.micro". 스레드 chunk 의 sourceRefId = threadTs(=루트 ts).
// 단독 메시지 chunk 의 sourceRefId = 메시지 ts.
const TS = {
  decRoot: '1721400000.000100', // decision 스레드 루트   (eng, U1)
  decReply: '1721400060.000200', // decision 스레드 답글    (eng, U2)
  incRoot: '1721400200.000100', // incident 스레드 루트    (eng, U1)
  incReply: '1721400260.000200', // incident 스레드 답글    (eng, U2)
  taskRoot: '1721400400.000100', // task 스레드 루트        (eng, U1)
  taskReply: '1721400460.000200', // task 스레드 답글        (eng, U2)
  procRoot: '1721400600.000100', // procedure 스레드 루트   (eng, U1)
  procReply: '1721400660.000200', // procedure 스레드 답글   (eng, U2)
  factMsg: '1721400800.000100', // fact 단독 메시지         (eng, U1)
  chat: '1721400900.000100', // 잡담 단독 메시지(skip 대상) (random, U2)
};

// 총 메시지 수(import 파싱 완료 판정). 스레드 4개(각 2) + 단독 2 = 10.
const TOTAL_MESSAGES = 10;

// 인덱싱 준비 확인용 검색 질의(decision 스레드와 강하게 겹침 → items>0 확보).
const INDEX_READY_QUERY = 'PostgreSQL 파티셔닝 도입 결정';

function buildBundle() {
  return {
    workspace: { name: `기억 검증 슬랙 ${RUN}`, slackTeamId: `T-${RUN}` },
    channels: [
      { id: 'C1', name: CH.eng },
      { id: 'C2', name: CH.random },
    ],
    users: [
      { id: 'U1', name: 'soobeen', real_name: '수빈' },
      { id: 'U2', name: 'alex', real_name: 'Alex Kim' },
    ],
    messages: [
      // ── decision 스레드(결정) ──
      {
        channel: 'C1',
        ts: TS.decRoot,
        user: 'U1',
        text: 'PostgreSQL 파티셔닝을 도입하기로 결정했습니다',
        thread_ts: TS.decRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.decReply,
        user: 'U2',
        text: '월 단위 range 파티셔닝으로 선택했습니다',
        thread_ts: TS.decRoot,
        edited_ts: null,
      },
      // ── incident 스레드(장애 + 해결 맥락) ──
      {
        channel: 'C1',
        ts: TS.incRoot,
        user: 'U1',
        text: 'Route53 인증서 만료로 장애가 발생하여 ACM 재발급으로 해결했습니다',
        thread_ts: TS.incRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.incReply,
        user: 'U2',
        text: '동일 장애 재발을 막기 위해 모니터링을 추가해 문제를 해소했습니다',
        thread_ts: TS.incRoot,
        edited_ts: null,
      },
      // ── task 스레드(담당) ──
      {
        channel: 'C1',
        ts: TS.taskRoot,
        user: 'U1',
        text: '수빈이 마이그레이션 스크립트 작성을 담당합니다',
        thread_ts: TS.taskRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.taskReply,
        user: 'U2',
        text: '인덱스 재생성 작업의 담당자도 수빈입니다',
        thread_ts: TS.taskRoot,
        edited_ts: null,
      },
      // ── procedure 스레드(절차/방법/순서/단계) ──
      {
        channel: 'C1',
        ts: TS.procRoot,
        user: 'U1',
        text: '배포 절차는 다음 단계를 순서대로 진행합니다',
        thread_ts: TS.procRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.procReply,
        user: 'U2',
        text: '롤백 방법도 동일한 순서로 문서에 정리했습니다',
        thread_ts: TS.procRoot,
        edited_ts: null,
      },
      // ── fact 단독 메시지(키워드 없는 정보성 문장) ──
      {
        channel: 'C1',
        ts: TS.factMsg,
        user: 'U1',
        text: '우리 서비스의 기본 타임존은 Asia/Seoul 이며 모든 시각은 이 기준으로 표기됩니다',
        edited_ts: null,
      },
      // ── 잡담 단독(10자 미만 → 노이즈 skip 대상) ──
      {
        channel: 'C2',
        ts: TS.chat,
        user: 'U2',
        text: '넵',
        edited_ts: null,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP 헬퍼(verify-phase7 스타일)                                             */
/* -------------------------------------------------------------------------- */

/** 쿼리스트링 직렬화(undefined 값은 생략). */
function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

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
/* Slack workspace 폴링(import 완료·workspaceId 도출) — verify-phase7 재사용     */
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
/* RAG 인덱싱 준비 폴링(chunks 생성 확인) — verify-phase7 재사용                 */
/* -------------------------------------------------------------------------- */

/** POST /v1/ai/retrieval → { status, json }. */
async function retrieval(token, { workspaceId, query, topK }) {
  const body = { workspaceId, query };
  if (topK !== undefined) body.topK = topK;
  return req('POST', '/ai/retrieval', { token, body });
}

/** retrieval 이 결과(items>0)를 줄 때까지 폴링(≤timeout) = chunks 인덱싱 완료 확인. */
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

/* -------------------------------------------------------------------------- */
/* memory API 헬퍼                                                             */
/* -------------------------------------------------------------------------- */

/** POST /v1/memory/extract → { status, json }. */
async function extractMemory(token, workspaceId) {
  return req('POST', '/memory/extract', { token, body: { workspaceId } });
}

/** GET /v1/memory/candidates?workspaceId=&status= → { status, json }. */
async function listCandidates(token, workspaceId, status) {
  return req('GET', `/memory/candidates${qs({ workspaceId, status })}`, { token });
}

/** POST /v1/memory/candidates/:id/approve → { status, json }. */
async function approveCandidate(token, id, edits = {}) {
  return req('POST', `/memory/candidates/${id}/approve`, { token, body: edits });
}

/** POST /v1/memory/candidates/:id/reject → { status, json }(본문 없음). */
async function rejectCandidate(token, id) {
  return req('POST', `/memory/candidates/${id}/reject`, { token });
}

/** GET /v1/memory/memories?workspaceId=&type=&status=&current=&asOf= → { status, json }. */
async function listMemories(token, params) {
  return req('GET', `/memory/memories${qs(params)}`, { token });
}

/** POST /v1/memory/memories → { status, json }. */
async function createMemory(token, body) {
  return req('POST', '/memory/memories', { token, body });
}

/** PATCH /v1/memory/memories/:id → { status, json }. */
async function updateMemory(token, id, body) {
  return req('PATCH', `/memory/memories/${id}`, { token, body });
}

/** POST /v1/memory/memories/:id/supersede → { status, json }. */
async function supersedeMemory(token, id, body) {
  return req('POST', `/memory/memories/${id}/supersede`, { token, body });
}

/**
 * candidates 폴링: predicate(items) 가 참일 때까지(≤timeout). 반환 { ok, items }.
 */
async function pollCandidates(token, workspaceId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const res = await listCandidates(token, workspaceId);
    if (res.status === 200 && Array.isArray(res.json?.items)) {
      last = res.json.items;
      try {
        if (predicate(last)) return { ok: true, items: last };
      } catch {
        /* keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, items: last };
}

/** sourceRefId(및 선택 type)로 후보 찾기. */
function findCandidate(items, sourceRefId, type) {
  return items.find(
    (c) => c.sourceRefId === sourceRefId && (type === undefined || c.type === type),
  );
}

/** 정렬된 candidate id 목록(멱등 비교용). */
async function collectCandidateIds(token, workspaceId) {
  const res = await listCandidates(token, workspaceId);
  assert(res.status === 200, 'GET /v1/memory/candidates 200(멱등 기준 수집)', res.status);
  const items = Array.isArray(res.json?.items) ? res.json.items : [];
  return items.map((c) => c.id).sort();
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Phase 8 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  const bundleJson = JSON.stringify(buildBundle());

  // ── 1) userA 회원가입 + Slack import(구분되는 type 스레드) ────────────────
  step(1, 'userA(소유자) 회원가입 + Slack export 번들 업로드(decision/incident/task/procedure/fact)');
  const userA = await registerUser('mem-owner-a');
  console.log(
    `  · 번들 요약: 채널 2, 유저 2, 메시지 ${TOTAL_MESSAGES}(스레드 4×2 + 단독 2)`,
  );
  const imp = await importBundle(userA.token, bundleJson, {
    mySlackUserId: 'U1',
    workspaceName: `기억 검증 슬랙 ${RUN}`,
    kind: 'company',
  });
  assert(imp.status === 200, 'POST /v1/slack/import 200', imp.status);
  assert(imp.json?.status === 'queued', "import status === 'queued'", imp.json?.status);
  const slackWorkspaceId = imp.json?.slackWorkspaceId;
  assert(
    typeof slackWorkspaceId === 'string' && slackWorkspaceId.length > 0,
    'slackWorkspaceId 반환',
  );

  // import 파싱 완료 폴링 → 개인 컨테이너 workspaceId(= memory 스코프) 도출.
  step(2, 'import 파싱 완료 폴링 → workspaceId 도출 → RAG 인덱싱(chunks) 완료 폴링(≤15s)');
  const pollWs = await pollWorkspace(
    userA.token,
    slackWorkspaceId,
    (ws) => ws.messageCount >= TOTAL_MESSAGES && ws.lastImportedAt != null,
    IMPORT_TIMEOUT_MS,
  );
  assert(pollWs.ok, `import 파싱 완료(messageCount=${TOTAL_MESSAGES} 도달, 15s 내)`, {
    messageCount: pollWs.ws?.messageCount,
    lastImportedAt: pollWs.ws?.lastImportedAt == null ? 'null' : 'set',
  });
  const workspaceId = pollWs.ws?.workspaceId;
  assert(
    typeof workspaceId === 'string' && workspaceId.length > 0,
    'workspaceId(workspaces.id — memory/RAG 스코프) 도출',
  );

  // RAG 인덱싱 완료(chunks 생성) 확인: retrieval 이 결과를 줄 때까지 폴링.
  const ragReady = await pollRetrieval(
    userA.token,
    { workspaceId, query: INDEX_READY_QUERY, topK: 5 },
    (r) => Array.isArray(r.items) && r.items.length > 0,
    RAG_TIMEOUT_MS,
  );
  assert(ragReady.ok, 'RAG 인덱싱 완료(chunks 생성 — retrieval items>0, 15s 내)', {
    itemCount: Array.isArray(ragReady.json?.items) ? ragReady.json.items.length : 'n/a',
  });

  // ── 3) 기억 추출 트리거 + 후보 등장 폴링 ──────────────────────────────────
  step(3, 'POST /v1/memory/extract → 202 queued → 후보 추출 폴링(≤15s)');
  const ext = await extractMemory(userA.token, workspaceId);
  assert(ext.status === 202, 'POST /v1/memory/extract 202 Accepted', ext.status);
  assert(ext.json?.status === 'queued', "extract status === 'queued'", ext.json?.status);
  const jobId = ext.json?.jobId;
  assert(
    jobId === `memory-extract_${workspaceId}`,
    'jobId === memory-extract_<workspaceId>(BullMQ 커스텀 jobId 규약)',
    { jobId },
  );
  assert(typeof jobId === 'string' && !jobId.includes(':'), "jobId 에 ':' 없음('_' 사용, 스펙 §0)");

  // decision/incident/task 후보가 모두 등장할 때까지 폴링(각 스레드 루트 ts 로 식별).
  const polled = await pollCandidates(
    userA.token,
    workspaceId,
    (items) =>
      items.length > 0 &&
      !!findCandidate(items, TS.decRoot, 'decision') &&
      !!findCandidate(items, TS.incRoot, 'incident') &&
      !!findCandidate(items, TS.taskRoot, 'task'),
    EXTRACT_TIMEOUT_MS,
  );
  assert(polled.ok, '후보 추출 완료(decision/incident/task 후보 등장, 15s 내)', {
    count: polled.items.length,
  });

  // ── 4) 후보 조회: type 분류 / sourceChunkId·sourceRefId 원문 연결 / confidence ──
  step(4, 'GET /candidates: type 분류(decision/incident/task/procedure/fact) · sourceChunkId 연결 · confidence');
  const candRes = await listCandidates(userA.token, workspaceId);
  assert(candRes.status === 200, 'GET /v1/memory/candidates 200(소유자)', candRes.status);
  const candidates = Array.isArray(candRes.json?.items) ? candRes.json.items : [];
  assert(candidates.length > 0, '후보 존재(candidates 비어있지 않음)', candidates.length);

  // 스펙 §8-4 필수: decision/incident/task 최소 분류 확인(스레드 루트 ts 로 역추적).
  const decCand = findCandidate(candidates, TS.decRoot, 'decision');
  const incCand = findCandidate(candidates, TS.incRoot, 'incident');
  const taskCand = findCandidate(candidates, TS.taskRoot, 'task');
  assert(!!decCand, "decision 스레드 → type 'decision' 후보 존재(sourceRefId=루트 ts)");
  assert(!!incCand, "incident 스레드 → type 'incident' 후보 존재(장애+해결 맥락)");
  assert(!!taskCand, "task 스레드 → type 'task' 후보 존재('담당')");
  // 보너스(규칙 결정적): procedure/fact 분류 + confidence 강/약 확인.
  const procCand = findCandidate(candidates, TS.procRoot, 'procedure');
  const factCand = findCandidate(candidates, TS.factMsg, 'fact');
  assert(!!procCand, "procedure 스레드 → type 'procedure' 후보 존재('절차/단계/순서')");
  assert(!!factCand, "fact 단독 메시지 → type 'fact' 후보 존재(키워드 없는 정보성 문장)");

  // 원문 연결(sourceChunkId=chunk uuid, sourceRefId=Slack ts).
  assert(
    typeof decCand.sourceChunkId === 'string' && decCand.sourceChunkId.length > 0,
    'decision 후보 sourceChunkId(chunk uuid) 연결됨',
  );
  assert(decCand.sourceRefId === TS.decRoot, 'decision 후보 sourceRefId === 스레드 루트 ts', {
    sourceRefId: decCand.sourceRefId,
  });
  // confidence 규칙(정확 키워드 90 / 순수 fact 60).
  assert(decCand.confidence === 90, 'decision 후보 confidence === 90(정확 키워드)', decCand.confidence);
  assert(incCand.confidence === 90, 'incident 후보 confidence === 90(정확 키워드)', incCand.confidence);
  assert(taskCand.confidence === 90, 'task 후보 confidence === 90(정확 키워드)', taskCand.confidence);
  assert(factCand.confidence === 60, 'fact 후보 confidence === 60(약함/fallback)', factCand.confidence);
  // 모든 후보 status='pending', extractedAt ISO 파싱 가능.
  assert(
    candidates.every((c) => c.status === 'pending'),
    '추출 직후 모든 후보 status === pending',
  );
  assert(
    candidates.every((c) => typeof c.extractedAt === 'string' && !Number.isNaN(Date.parse(c.extractedAt))),
    '모든 후보 extractedAt(ISO 파싱 가능)',
  );

  // 멱등(§12) 기준 스냅샷: 승인/거부 전 전체 후보 id 집합.
  const baselineCandidateIds = candidates.map((c) => c.id).sort();
  console.log(`  · 멱등 기준 후보 수: ${baselineCandidateIds.length}`);

  // ── 5) 승인: 후보 → memory(approved) + 원문 연결(memory_sources) ───────────
  step(5, 'approve decision 후보 → memory(approved) 생성 · GET /memories 존재 · memory_sources 원문 연결');
  const decChunkId = decCand.sourceChunkId;
  const apr = await approveCandidate(userA.token, decCand.id);
  assert(apr.status === 200, 'POST /candidates/:id/approve 200', apr.status);
  const approved = apr.json;
  assert(approved?.status === 'approved', "생성된 memory status === 'approved'", approved?.status);
  assert(approved?.type === 'decision', "memory type === 'decision'(후보 계승)", approved?.type);
  assert(approved?.isCurrent === true, 'memory isCurrent === true(validUntil null)');
  assert(approved?.subject === decCand.subject, 'memory subject === 후보 subject(편집 없음)');
  const approvedId = approved?.id;
  assert(typeof approvedId === 'string' && approvedId.length > 0, 'approved memory id 반환');
  // memory_sources: chunk 참조(sourceRefId=chunk uuid) + 원본 Slack 스레드(threadTs) 역추적.
  const sources = Array.isArray(approved?.sources) ? approved.sources : [];
  assert(sources.length > 0, 'memory.sources 비어있지 않음(원문 연결됨)', sources.length);
  const chunkSrc = sources.find((s) => s.sourceType === 'chunk');
  assert(!!chunkSrc, "memory.sources 에 sourceType 'chunk' 존재");
  assert(chunkSrc?.sourceRefId === decChunkId, 'chunk source sourceRefId === 후보 sourceChunkId', {
    got: chunkSrc?.sourceRefId,
  });
  // GET /memories 에 존재하는지 재확인.
  const memList = await listMemories(userA.token, { workspaceId });
  assert(memList.status === 200, 'GET /v1/memory/memories 200(소유자)', memList.status);
  const memItems = Array.isArray(memList.json?.items) ? memList.json.items : [];
  assert(
    memItems.some((m) => m.id === approvedId && m.status === 'approved'),
    'GET /memories 에 승인된 memory 존재(approved)',
  );

  // ── 6) 거부: 다른 후보 → rejected ─────────────────────────────────────────
  step(6, 'reject incident 후보 → status rejected');
  const rej = await rejectCandidate(userA.token, incCand.id);
  assert(rej.status === 200, 'POST /candidates/:id/reject 200', rej.status);
  assert(rej.json?.status === 'rejected', "거부된 후보 status === 'rejected'", rej.json?.status);
  assert(rej.json?.id === incCand.id, '거부 응답 id === 대상 후보 id');
  const rejectedList = await listCandidates(userA.token, workspaceId, 'rejected');
  assert(rejectedList.status === 200, 'GET /candidates?status=rejected 200', rejectedList.status);
  assert(
    (rejectedList.json?.items ?? []).some((c) => c.id === incCand.id),
    'status=rejected 필터에 거부 후보 포함',
  );

  // ── 7) 직접 생성: POST /memories → approved + manual source ────────────────
  step(7, '직접 POST /memories → status approved · source manual');
  const manualCreate = await createMemory(userA.token, {
    workspaceId,
    type: 'fact',
    subject: `직접 생성 사실 ${RUN}`,
    content: '사용자가 명시적으로 기억을 요청한 직접 생성 사실입니다',
  });
  assert(manualCreate.status === 201, 'POST /v1/memory/memories 201 Created', manualCreate.status);
  const manualMem = manualCreate.json;
  assert(manualMem?.status === 'approved', "직접 생성 memory status === 'approved'", manualMem?.status);
  assert(manualMem?.isCurrent === true, '직접 생성 memory isCurrent === true');
  assert(
    (manualMem?.sources ?? []).some((s) => s.sourceType === 'manual'),
    "직접 생성 memory.sources 에 sourceType 'manual' 존재",
  );

  // ── 8) 수정: PATCH → memory_versions 기록(수정 반영) ──────────────────────
  step(8, 'PATCH memory → 수정 반영(memory_versions 스냅샷 기록)');
  const newSubject = `승인 기억 수정본 ${RUN}`;
  const newContent = '수정된 본문 — 변경 전 상태는 memory_versions v2 로 스냅샷된다';
  const patched = await updateMemory(userA.token, approvedId, {
    subject: newSubject,
    content: newContent,
    changeReason: '검증용 수정',
  });
  assert(patched.status === 200, 'PATCH /v1/memory/memories/:id 200', patched.status);
  assert(patched.json?.subject === newSubject, 'PATCH 응답 subject 수정 반영', {
    len: patched.json?.subject?.length,
  });
  // GET 재조회로 수정이 영속됐는지 확인.
  const afterPatch = await listMemories(userA.token, { workspaceId });
  const patchedMem = (afterPatch.json?.items ?? []).find((m) => m.id === approvedId);
  assert(!!patchedMem, 'PATCH 후 memory 재조회 가능');
  assert(patchedMem?.subject === newSubject, 'GET /memories 에 수정된 subject 반영(영속)');

  // ── 9) supersede: 현재/과거 구분(current/asOf) ────────────────────────────
  step(9, 'supersede: 기존 superseded(validUntil=now) · 새 기억 current · current=true/asOf 구분');
  // 과거 시점 기억을 명시적 validFrom(2020)으로 생성 → asOf 검증 기준을 확보.
  const PAST = '2020-01-01T00:00:00.000Z';
  const ASOF = '2021-06-01T00:00:00.000Z'; // PAST < ASOF < now(2026) — 과거 시점 조회 기준.
  const oldCreate = await createMemory(userA.token, {
    workspaceId,
    type: 'fact',
    subject: `결제 서버 인스턴스 타입(구) ${RUN}`,
    content: '결제 서버 인스턴스 타입은 t3.medium 이다',
    validFrom: PAST,
    observedAt: PAST,
  });
  assert(oldCreate.status === 201, 'supersede 대상(과거) memory 생성 201', oldCreate.status);
  const oldId = oldCreate.json?.id;
  assert(typeof oldId === 'string' && oldId.length > 0, 'supersede 대상 memory id 반환');
  assert(
    typeof oldCreate.json?.validFrom === 'string' && oldCreate.json.validFrom.startsWith('2020'),
    'supersede 대상 validFrom === 과거(2020) 반영',
    { validFrom: oldCreate.json?.validFrom },
  );

  const sup = await supersedeMemory(userA.token, oldId, {
    type: 'fact',
    subject: `결제 서버 인스턴스 타입(신) ${RUN}`,
    content: '결제 서버 인스턴스 타입을 t3.large 로 증설했다',
  });
  assert(sup.status === 201, 'POST /memories/:id/supersede 201 Created', sup.status);
  const newMem = sup.json;
  const newId = newMem?.id;
  assert(typeof newId === 'string' && newId.length > 0, 'supersede 새 memory id 반환');
  assert(newMem?.supersedesMemoryId === oldId, '새 memory supersedesMemoryId === 기존 id');
  assert(newMem?.status === 'approved', "새 memory status === 'approved'", newMem?.status);
  assert(newMem?.isCurrent === true, '새 memory isCurrent === true(validUntil null)');
  assert(
    typeof newMem?.validFrom === 'string' && !newMem.validFrom.startsWith('2020'),
    '새 memory validFrom === now(과거 아님)',
    { validFrom: newMem?.validFrom },
  );

  // 전체 조회로 기존이 superseded 되었는지 확인.
  const allAfterSup = await listMemories(userA.token, { workspaceId });
  const oldAfter = (allAfterSup.json?.items ?? []).find((m) => m.id === oldId);
  assert(!!oldAfter, 'supersede 후 기존 memory 조회 가능');
  assert(oldAfter?.status === 'superseded', "기존 memory status === 'superseded'", oldAfter?.status);
  assert(oldAfter?.isCurrent === false, '기존 memory isCurrent === false');
  assert(oldAfter?.validUntil != null, '기존 memory validUntil 설정됨(now)');

  // current=true → 새 것 포함, 기존 제외.
  const curList = await listMemories(userA.token, { workspaceId, current: 'true' });
  assert(curList.status === 200, 'GET /memories?current=true 200', curList.status);
  const curIds = (curList.json?.items ?? []).map((m) => m.id);
  assert(curIds.includes(newId), 'current=true 결과에 새 memory 포함');
  assert(!curIds.includes(oldId), 'current=true 결과에 기존(superseded) memory 제외');
  assert(
    (curList.json?.items ?? []).every((m) => m.isCurrent === true),
    'current=true 결과는 모두 isCurrent',
  );

  // asOf=과거 → 기존(당시 유효) 포함, 새 것(validFrom=now) 제외.
  const asOfList = await listMemories(userA.token, { workspaceId, asOf: ASOF });
  assert(asOfList.status === 200, 'GET /memories?asOf=<과거> 200', asOfList.status);
  const asOfIds = (asOfList.json?.items ?? []).map((m) => m.id);
  assert(asOfIds.includes(oldId), 'asOf=과거 결과에 기존(당시 유효) memory 포함');
  assert(!asOfIds.includes(newId), 'asOf=과거 결과에 새 memory(validFrom=now) 제외');

  // ── 10) 원문 역추적: 승인 memory.sources 로 Slack 스레드까지 추적 ─────────
  step(10, '원문 역추적: 승인 memory.sources → chunk + 원본 Slack 스레드(threadTs)');
  const traceRes = await listMemories(userA.token, { workspaceId, type: 'decision' });
  assert(traceRes.status === 200, 'GET /memories?type=decision 200', traceRes.status);
  const traceMem = (traceRes.json?.items ?? []).find((m) => m.id === approvedId);
  assert(!!traceMem, '승인된 decision memory 조회 가능(원문 역추적 대상)');
  const traceSources = traceMem?.sources ?? [];
  const traceChunk = traceSources.find((s) => s.sourceType === 'chunk');
  const traceSlack = traceSources.find((s) => s.sourceType === 'slack_message');
  assert(traceChunk?.sourceRefId === decChunkId, 'chunk source → sourceChunkId 로 chunk 역추적 가능');
  assert(!!traceSlack, "memory.sources 에 sourceType 'slack_message'(원본 스레드) 존재");
  assert(
    traceSlack?.sourceRefId === TS.decRoot,
    'slack_message source sourceRefId === decision 스레드 루트 ts(원문까지 역추적)',
    { got: traceSlack?.sourceRefId },
  );

  // ── 11) 권한: 비소유자 userB 는 목록/승인 403(PRD §26) ────────────────────
  step(11, '권한: 비소유자 userB 의 candidates/memories 조회·승인 → 403');
  const userB = await registerUser('mem-nonowner-b');
  const bCand = await listCandidates(userB.token, workspaceId);
  assert(bCand.status === 403, 'userB GET /candidates 403', bCand.status);
  const bMem = await listMemories(userB.token, { workspaceId });
  assert(bMem.status === 403, 'userB GET /memories 403', bMem.status);
  // 아직 pending 인 task 후보로 승인 시도 → 소유권 재검증에서 403.
  const bApprove = await approveCandidate(userB.token, taskCand.id);
  assert(bApprove.status === 403, 'userB POST /candidates/:id/approve 403', bApprove.status);

  // ── 12) 멱등: extract 재실행 후 후보 중복 없음 ────────────────────────────
  step(12, '멱등: POST /memory/extract 재실행 → 후보 id 집합 불변(중복 없음)');
  const reExt = await extractMemory(userA.token, workspaceId);
  assert(reExt.status === 202, '재실행 POST /memory/extract 202', reExt.status);
  // 재추출 잡이 처리될 시간을 주면서, 어느 시점에도 후보가 늘지 않아야 한다.
  const deadline = Date.now() + IDEMPOTENCY_WINDOW_MS;
  let lastIds = baselineCandidateIds;
  while (Date.now() < deadline) {
    const ids = await collectCandidateIds(userA.token, workspaceId);
    assert(ids.length <= baselineCandidateIds.length, '재추출 중 후보가 늘지 않음(중복 미생성)', {
      before: baselineCandidateIds.length,
      now: ids.length,
    });
    lastIds = ids;
    await sleep(POLL_INTERVAL_MS);
  }
  assert(
    sameStringSet(lastIds, baselineCandidateIds),
    `재추출 후 후보 id 집합 불변(멱등, count=${baselineCandidateIds.length})`,
    { before: baselineCandidateIds.length, after: lastIds.length },
  );

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). subject/content/secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
