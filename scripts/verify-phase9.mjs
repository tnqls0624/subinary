#!/usr/bin/env node
// =============================================================================
// verify-phase9.mjs — Phase 9(Temporal GraphRAG: Entity/Relationship) e2e 검증
// -----------------------------------------------------------------------------
// docs/phase9-build-spec.md §8 시나리오(1~10)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + FormData + Blob 만 사용한다(외부 의존성 없음, Node ≥18).
//
// 인증(Bearer) + Slack import 는 scripts/verify-phase8.mjs 와 동일 패턴을 재사용한다:
//   - POST /v1/auth/register → res.json.tokens.accessToken
//   - POST /v1/slack/import (multipart: 필드 먼저 + file 은 Blob 으로 마지막)
//
// 파이프라인은 3단계 비동기다.
//   (1) Slack import: BullMQ slack-import 워커가 번들을 파싱해 slack_messages/threads + slack_users
//       적재. → GET /v1/slack/workspaces/:id 를 폴링해 messageCount 도달·lastImportedAt 확인.
//   (2) RAG 인덱싱: import 성공 후 rag-index 큐가 스레드를 청킹 → chunks upsert → 임베딩.
//       그래프 추출은 chunks(text/occurredAt/sourceRefId)를 대상으로 하므로 chunks 가 준비돼야
//       한다. → POST /v1/ai/retrieval 이 결과(items>0)를 줄 때까지 ≤15s 폴링(= chunks 생성 확인).
//   (3) 그래프 추출: POST /v1/graph/extract → graph-extract 큐가 각 chunk 텍스트를 결정적 규칙
//       추출(@family/rag extractGraph)해 entities/relationships 를 upsert 한다.
//       → GET /v1/graph/entities 를 폴링(≤15s)해 technology/person entity 등장을 확인.
//
// 추출은 결정적 규칙 함수다(packages/rag/src/graph.ts, 스펙 §3). 랜덤/시간/LLM 을 쓰지 않는다.
//   · technology entity: 기술 사전(TECH_TERMS)이 chunk 텍스트에 등장하면 등록
//     (canonicalName=정규화 소문자 term). 본 번들은 route53 / acm / postgresql / redis 만 매칭되도록
//     문장을 골랐다(다른 사전 용어 미포함).
//   · person entity: 워크스페이스의 slack_users 전원 등록(관계 없이 등록만 — works_on 은 Phase 9
//     에서 축소, 스펙 §5). 여기선 U1(soobeen)·U2(alex) 2명.
//   · relationship(chunk 단위, tech pair): 같은 chunk 안 technology 쌍 (A,B) → relates_to. chunk 에
//     해결 마커(RESOLUTION_MARKERS = 해결/복구/조치/재발급/해소/resolved/fixed)가 있으면 resolves.
//     본 번들 스레드:
//       · "Route53 인증서 만료 … ACM 재발급으로 해결" → route53·acm 공출현 + 해결 마커 → resolves.
//       · "PostgreSQL 파티셔닝을 Redis 캐시와 함께 도입 결정" → postgresql·redis 공출현, 해결 마커
//         없음 → relates_to("결정" 은 해결 마커가 아니다).
//     pair 는 canonical 오름차순(A<B)으로 정렬 저장하므로 방향과 무관하게 두 entity 를 잇는
//     관계를 id 쌍으로 조회한다.
//
// 스코프(workspaceId)는 개인 데이터 컨테이너 workspaces.id 다(= slackWorkspaceSummary.workspaceId).
//   RAG/memory 와 동일하게 graph API 의 workspaceId 도 slack_workspaces.id 가 아니라 workspaces.id 다.
//
// 접근제어(PRD §26): graph 는 workspaces.ownerUserId == 현재 userId 인 **소유자 본인만**.
//   비소유자(userB)는 entities/relationships 조회 및 extract 모두 403.
//
// Temporal / supersede(스펙 §1.3): relationship 은 validFrom/validUntil/supersedesRelationshipId 를
//   갖는다. 명시적 supersede 는 기존 관계를 닫고(validUntil=now) 새 관계(supersedesRelationshipId=기존,
//   validFrom=now)를 만든다(자동 결정변경 추론은 하지 않는다). 조회:
//     · current=true → validUntil IS NULL OR validUntil > now.
//     · asOf=DATE → validFrom <= asOf AND (validUntil IS NULL OR validUntil > asOf).
//   자동 추출된 관계의 validFrom = chunk.occurredAt(번들 ts 기준 2024-07) 이고, supersede 로 만든 새
//   관계의 validFrom = now(2026) 이므로 asOf=2025-01-01 은 "기존만 포함 · 새 관계 제외"를 판정한다.
//
// 멱등(스펙 §1.1/§1.2): entities UNIQUE(workspaceId,type,canonicalName) + onConflictDoUpdate,
//   relationships UNIQUE(workspaceId,sourceEntityId,type,targetEntityId,sourceRefId) +
//   onConflictDoNothing → extract 재실행해도 entity/relationship 수가 늘지 않는다(중복 0). 명시적
//   supersede 로 만든 새 관계(sourceRefId=null)는 추출 대상이 아니므로 재추출이 건드리지 않는다.
//
// 로그 정책(PRD §11): chunk/entity 의 원문·subject·PII·secret 을 출력하지 않는다. 개수/식별자
//   (entityId·relationshipId 접두·canonicalName·type·불리언)만 출력한다.
//
// 실행법:
//   1) 전체 스택 기동(진행자 사전 수행): docker compose up -d --build
//      (+ migrate 0009 entities/relationships + self-FK)
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-phase9.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase9.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
// =============================================================================

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// import 파싱 폴링 상한 + RAG 인덱싱 폴링 상한 + 그래프 추출 폴링 상한(스펙 §8-3 = 15초).
const IMPORT_TIMEOUT_MS = 15_000;
const RAG_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 15_000;
// 멱등(재추출) 안정 관찰 창(재추출 잡이 처리될 시간을 주면서 수가 늘지 않음을 확인).
const IDEMPOTENCY_WINDOW_MS = 10_000;
const POLL_INTERVAL_MS = 500;

// asOf 판정 기준(과거 시점). 자동 관계 validFrom(2024-07) < ASOF < now(2026) 이어야 한다.
const ASOF_PAST = '2025-01-01T00:00:00.000Z';

let passed = 0;
let failed = 0;

/* -------------------------------------------------------------------------- */
/* 요약 / assert / step 유틸(verify-phase8 스타일)                              */
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
    // extra 는 상태코드/개수/식별자 등 비민감 정보만 전달한다(원문/PII/secret 금지).
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
/* Slack export 번들 — 그래프 추출용 스레드(스펙 §8-1)                           */
/* -------------------------------------------------------------------------- */
// 채널 2(eng-log/random) / 유저 2(soobeen/alex). 각 스레드 chunk 는 root+reply 를 개행 결합하며,
//   두 기술 용어가 같은 chunk(스레드) 안에서 공출현하도록 root 문장에 함께 담았다.
//     · incident/resolves 스레드 : Route53 + ACM + 재발급/해결 → resolves(장애-해결)
//     · relates_to 스레드        : PostgreSQL + Redis + "도입 결정"(해결 마커 없음) → relates_to
//     · 사람 단독 메시지          : 기술 용어 없음(entity/관계 미생성, person 은 slack_users 로 등록)
const CH = { eng: 'eng-log', random: 'random' };

// technology entity 의 canonicalName(정규화 소문자 term) — 스펙 §1.1/§3 TECH_TERMS.
const TECH = { route53: 'route53', acm: 'acm', postgresql: 'postgresql', redis: 'redis' };

// Slack ts = "epoch.micro". 스레드 chunk 의 sourceRefId = threadTs(=루트 ts).
//   root ts 1721400000 → 2024-07-19T14:40Z 이므로 자동 관계 validFrom 은 2024-07(과거)이다.
const TS = {
  incRoot: '1721400000.000100', // resolves 스레드 루트(eng, U1)
  incReply: '1721400060.000200', // resolves 스레드 답글(eng, U2)
  relRoot: '1721400200.000100', // relates_to 스레드 루트(eng, U1)
  relReply: '1721400260.000200', // relates_to 스레드 답글(eng, U2)
  chat: '1721400400.000100', // 사람 단독 메시지(random, U2)
};

// 총 메시지 수(import 파싱 완료 판정). 스레드 2개(각 2) + 단독 1 = 5.
const TOTAL_MESSAGES = 5;

// 인덱싱 준비 확인용 검색 질의(relates_to 스레드와 강하게 겹침 → items>0 확보).
const INDEX_READY_QUERY = 'PostgreSQL 파티셔닝 Redis 캐시 도입';

function buildBundle() {
  return {
    workspace: { name: `그래프 검증 슬랙 ${RUN}`, slackTeamId: `T-${RUN}` },
    channels: [
      { id: 'C1', name: CH.eng },
      { id: 'C2', name: CH.random },
    ],
    users: [
      { id: 'U1', name: 'soobeen', real_name: '수빈' },
      { id: 'U2', name: 'alex', real_name: 'Alex Kim' },
    ],
    messages: [
      // ── resolves 스레드(Route53 + ACM + 해결/재발급 → resolves) ──
      {
        channel: 'C1',
        ts: TS.incRoot,
        user: 'U1',
        text: 'Route53 인증서 만료로 장애가 발생했는데 ACM 재발급으로 해결했습니다',
        thread_ts: TS.incRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.incReply,
        user: 'U2',
        text: '동일 장애 재발 방지를 위해 모니터링 알람을 추가했습니다',
        thread_ts: TS.incRoot,
        edited_ts: null,
      },
      // ── relates_to 스레드(PostgreSQL + Redis, 해결 마커 없음 → relates_to) ──
      {
        channel: 'C1',
        ts: TS.relRoot,
        user: 'U1',
        text: 'PostgreSQL 파티셔닝을 Redis 캐시와 함께 도입하기로 결정했습니다',
        thread_ts: TS.relRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.relReply,
        user: 'U2',
        text: '월 단위 range 파티셔닝으로 진행하기로 정리했습니다',
        thread_ts: TS.relRoot,
        edited_ts: null,
      },
      // ── 사람 단독 메시지(기술 용어 없음 — entity/관계 미생성) ──
      {
        channel: 'C2',
        ts: TS.chat,
        user: 'U2',
        text: '다들 수고 많으셨습니다 회고는 내일 오전에 진행합니다',
        edited_ts: null,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP 헬퍼(verify-phase8 스타일)                                             */
/* -------------------------------------------------------------------------- */

/** 쿼리스트링 직렬화(undefined/null 값은 생략). */
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
/* Slack workspace 폴링(import 완료·workspaceId 도출) — verify-phase8 재사용     */
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
/* RAG 인덱싱 준비 폴링(chunks 생성 확인) — verify-phase8 재사용                 */
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
/* graph API 헬퍼                                                              */
/* -------------------------------------------------------------------------- */

/** POST /v1/graph/extract → { status, json }. */
async function extractGraph(token, workspaceId) {
  return req('POST', '/graph/extract', { token, body: { workspaceId } });
}

/** GET /v1/graph/entities?workspaceId=&type=&q= → { status, json }. */
async function listEntities(token, { workspaceId, type, q } = {}) {
  return req('GET', `/graph/entities${qs({ workspaceId, type, q })}`, { token });
}

/** GET /v1/graph/entities/:id → { status, json }(entityDetail: entity + neighbors). */
async function getEntity(token, id) {
  return req('GET', `/graph/entities/${id}`, { token });
}

/** GET /v1/graph/relationships?workspaceId=&entityId=&type=&current=&asOf= → { status, json }. */
async function listRelationships(token, params = {}) {
  return req('GET', `/graph/relationships${qs(params)}`, { token });
}

/** POST /v1/graph/relationships/:id/supersede → { status, json }. */
async function supersedeRelationship(token, id, body) {
  return req('POST', `/graph/relationships/${id}/supersede`, { token, body });
}

/** GET /v1/graph/timeline?workspaceId=&entityId= → { status, json }({ entityId, items }). */
async function timeline(token, params) {
  return req('GET', `/graph/timeline${qs(params)}`, { token });
}

/** entities 폴링: predicate(items) 가 참일 때까지(≤timeout). 반환 { ok, items }. */
async function pollEntities(token, workspaceId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const res = await listEntities(token, { workspaceId });
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

/** canonicalName(+type)으로 entity 찾기. */
function findEntity(items, canonicalName, type) {
  return items.find(
    (e) => e.canonicalName === canonicalName && (type === undefined || e.type === type),
  );
}

/** 두 entity id 를 잇는 relationship 찾기(방향 무관, 선택 type). */
function findRel(items, idA, idB, type) {
  return items.find(
    (r) =>
      ((r.sourceEntityId === idA && r.targetEntityId === idB) ||
        (r.sourceEntityId === idB && r.targetEntityId === idA)) &&
      (type === undefined || r.type === type),
  );
}

/** 현재 entity/relationship 수 스냅샷(멱등 비교용). */
async function countGraph(token, workspaceId) {
  const e = await listEntities(token, { workspaceId });
  assert(e.status === 200, 'GET /v1/graph/entities 200(멱등 기준 수집)', e.status);
  const r = await listRelationships(token, { workspaceId });
  assert(r.status === 200, 'GET /v1/graph/relationships 200(멱등 기준 수집)', r.status);
  return {
    entities: Array.isArray(e.json?.items) ? e.json.items.length : 0,
    relationships: Array.isArray(r.json?.items) ? r.json.items.length : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Phase 9 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  const bundleJson = JSON.stringify(buildBundle());

  // ── 1) userA 회원가입 + Slack import(resolves/relates_to 스레드) ──────────
  step(1, 'userA(소유자) 회원가입 + Slack export 번들 업로드(Route53·ACM resolves / PostgreSQL·Redis relates_to)');
  const userA = await registerUser('graph-owner-a');
  console.log(`  · 번들 요약: 채널 2, 유저 2, 메시지 ${TOTAL_MESSAGES}(스레드 2×2 + 단독 1)`);
  const imp = await importBundle(userA.token, bundleJson, {
    mySlackUserId: 'U1',
    workspaceName: `그래프 검증 슬랙 ${RUN}`,
    kind: 'company',
  });
  assert(imp.status === 200, 'POST /v1/slack/import 200', imp.status);
  assert(imp.json?.status === 'queued', "import status === 'queued'", imp.json?.status);
  const slackWorkspaceId = imp.json?.slackWorkspaceId;
  assert(
    typeof slackWorkspaceId === 'string' && slackWorkspaceId.length > 0,
    'slackWorkspaceId 반환',
  );

  // ── 2) import 파싱 완료 폴링 → workspaceId 도출 → RAG 인덱싱(chunks) 폴링 ──
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
    'workspaceId(workspaces.id — graph/RAG 스코프) 도출',
  );

  const ragReady = await pollRetrieval(
    userA.token,
    { workspaceId, query: INDEX_READY_QUERY, topK: 5 },
    (r) => Array.isArray(r.items) && r.items.length > 0,
    RAG_TIMEOUT_MS,
  );
  assert(ragReady.ok, 'RAG 인덱싱 완료(chunks 생성 — retrieval items>0, 15s 내)', {
    itemCount: Array.isArray(ragReady.json?.items) ? ragReady.json.items.length : 'n/a',
  });

  // ── 3) 그래프 추출 트리거 + entity 등장 폴링 ──────────────────────────────
  step(3, 'POST /v1/graph/extract → 202 queued → entity 추출 폴링(≤15s)');
  const ext = await extractGraph(userA.token, workspaceId);
  assert(ext.status === 202, 'POST /v1/graph/extract 202 Accepted', ext.status);
  assert(ext.json?.status === 'queued', "extract status === 'queued'", ext.json?.status);
  const jobId = ext.json?.jobId;
  assert(
    jobId === `graph-extract_${workspaceId}`,
    'jobId === graph-extract_<workspaceId>(BullMQ 커스텀 jobId 규약)',
    { jobId },
  );
  assert(typeof jobId === 'string' && !jobId.includes(':'), "jobId 에 ':' 없음('_' 사용, 스펙 §0)");

  // technology entity(route53/acm/postgresql/redis)가 모두 등장할 때까지 폴링.
  const polled = await pollEntities(
    userA.token,
    workspaceId,
    (items) =>
      !!findEntity(items, TECH.route53, 'technology') &&
      !!findEntity(items, TECH.acm, 'technology') &&
      !!findEntity(items, TECH.postgresql, 'technology') &&
      !!findEntity(items, TECH.redis, 'technology'),
    EXTRACT_TIMEOUT_MS,
  );
  assert(polled.ok, '그래프 추출 완료(route53/acm/postgresql/redis entity 등장, 15s 내)', {
    count: polled.items.length,
  });

  // ── 4) GET /entities: technology + person entity 존재, isCurrent ──────────
  step(4, 'GET /entities: technology(route53/acm/postgresql/redis) + person entity 존재 · isCurrent=true');
  const entRes = await listEntities(userA.token, { workspaceId });
  assert(entRes.status === 200, 'GET /v1/graph/entities 200(소유자)', entRes.status);
  const entities = Array.isArray(entRes.json?.items) ? entRes.json.items : [];
  assert(entities.length > 0, 'entities 비어있지 않음', entities.length);

  const route53 = findEntity(entities, TECH.route53, 'technology');
  const acm = findEntity(entities, TECH.acm, 'technology');
  const postgresql = findEntity(entities, TECH.postgresql, 'technology');
  const redis = findEntity(entities, TECH.redis, 'technology');
  assert(!!route53, "technology entity 'route53' 존재");
  assert(!!acm, "technology entity 'acm' 존재");
  assert(!!postgresql, "technology entity 'postgresql' 존재");
  assert(!!redis, "technology entity 'redis' 존재");
  // technology entity 는 현재 유효(validUntil null → isCurrent true).
  assert(
    [route53, acm, postgresql, redis].every((e) => e.isCurrent === true),
    '모든 technology entity isCurrent === true(validUntil null)',
  );
  // validFrom 은 chunk.occurredAt(과거) — ISO 파싱 가능.
  assert(
    typeof route53.validFrom === 'string' && !Number.isNaN(Date.parse(route53.validFrom)),
    'route53 entity validFrom(ISO 파싱 가능)',
  );
  // person entity: slack_users(U1/U2) 전원 등록 → type 'person' ≥ 2.
  const persons = entities.filter((e) => e.type === 'person');
  assert(persons.length >= 2, "person entity ≥ 2(slack_users U1/U2 등록)", persons.length);
  assert(
    persons.every((p) => typeof p.name === 'string' && p.name.length > 0),
    'person entity name 존재',
  );
  const route53Id = route53.id;
  const acmId = acm.id;
  const postgresqlId = postgresql.id;
  const redisId = redis.id;

  // ── 5) GET /entities/:id(route53) → neighbors 에 acm(resolves) ────────────
  step(5, 'GET /entities/:id(route53) → local graph neighbors 에 acm(resolves)');
  const detail = await getEntity(userA.token, route53Id);
  assert(detail.status === 200, 'GET /v1/graph/entities/:id 200(소유자)', detail.status);
  assert(detail.json?.entity?.id === route53Id, 'entityDetail.entity.id === route53 id');
  const neighbors = Array.isArray(detail.json?.neighbors) ? detail.json.neighbors : [];
  assert(neighbors.length > 0, 'route53 neighbors 비어있지 않음', neighbors.length);
  const acmNeighbor = neighbors.find(
    (n) => n.entity?.canonicalName === TECH.acm && n.relationship?.type === 'resolves',
  );
  assert(!!acmNeighbor, "route53 neighbors 에 acm(resolves) 존재(장애-해결 이웃)");
  assert(
    acmNeighbor?.relationship?.isCurrent === true,
    'route53–acm resolves 관계 isCurrent === true(추출 직후)',
  );

  // ── 6) GET /relationships?type=resolves → route53–acm resolves ────────────
  step(6, 'GET /relationships?type=resolves → route53–acm resolves(장애-해결책 관계 검색)');
  const resolvesRes = await listRelationships(userA.token, { workspaceId, type: 'resolves' });
  assert(resolvesRes.status === 200, 'GET /relationships?type=resolves 200', resolvesRes.status);
  const resolvesItems = Array.isArray(resolvesRes.json?.items) ? resolvesRes.json.items : [];
  assert(
    resolvesItems.every((r) => r.type === 'resolves'),
    'type=resolves 필터 결과는 모두 resolves',
  );
  const resolvesRel = findRel(resolvesItems, route53Id, acmId, 'resolves');
  assert(!!resolvesRel, 'route53–acm 를 잇는 resolves 관계 존재');
  assert(
    typeof resolvesRel?.sourceName === 'string' && typeof resolvesRel?.targetName === 'string',
    'resolves 관계에 sourceName/targetName 조인됨',
  );
  assert(resolvesRel?.sourceRefId === TS.incRoot, 'resolves 관계 sourceRefId === 스레드 루트 ts(원문 연결)', {
    sourceRefId: resolvesRel?.sourceRefId,
  });

  // supersede 대상: postgresql–redis relates_to(자동 추출, validFrom=2024).
  const relatesRes = await listRelationships(userA.token, { workspaceId, type: 'relates_to' });
  assert(relatesRes.status === 200, 'GET /relationships?type=relates_to 200', relatesRes.status);
  const relatesItems = Array.isArray(relatesRes.json?.items) ? relatesRes.json.items : [];
  const oldRel = findRel(relatesItems, postgresqlId, redisId, 'relates_to');
  assert(!!oldRel, 'postgresql–redis relates_to 관계 존재(supersede 대상)');
  assert(oldRel?.isCurrent === true, 'supersede 대상 relates_to 관계 isCurrent === true(대체 전)');
  const oldRelId = oldRel.id;
  assert(
    typeof oldRel.validFrom === 'string' && oldRel.validFrom.startsWith('2024'),
    'supersede 대상 관계 validFrom === chunk.occurredAt(2024-07, 과거)',
    { validFrom: oldRel?.validFrom },
  );

  // ── 7) supersede: 기존 닫힘(validUntil) + 새 관계 current + 체인 연결 ──────
  step(7, 'supersede: 기존 relates_to 닫힘(validUntil) · 새 관계 current · supersedesRelationshipId 체인 · current/asOf 구분');
  const sup = await supersedeRelationship(userA.token, oldRelId, {
    sourceEntityId: postgresqlId,
    targetEntityId: redisId,
    type: 'relates_to',
    // sourceRefId 는 생략 → 새 관계 sourceRefId=null(UNIQUE 는 null 을 distinct 취급, 스펙 §2).
  });
  assert(sup.status === 201, 'POST /relationships/:id/supersede 201 Created', sup.status);
  const newRel = sup.json;
  const newRelId = newRel?.id;
  assert(typeof newRelId === 'string' && newRelId.length > 0, 'supersede 새 관계 id 반환');
  assert(newRelId !== oldRelId, '새 관계는 기존과 다른 row(id 상이)');
  assert(
    newRel?.supersedesRelationshipId === oldRelId,
    '새 관계 supersedesRelationshipId === 기존 id(결정 변화 체인)',
  );
  assert(newRel?.isCurrent === true, '새 관계 isCurrent === true(validUntil null)');
  assert(
    typeof newRel?.validFrom === 'string' && !newRel.validFrom.startsWith('2024'),
    '새 관계 validFrom === now(과거 아님)',
    { validFrom: newRel?.validFrom },
  );

  // 기존 관계가 닫혔는지(superseded) 재조회로 확인.
  const afterSup = await listRelationships(userA.token, { workspaceId, type: 'relates_to' });
  const oldAfter = (afterSup.json?.items ?? []).find((r) => r.id === oldRelId);
  assert(!!oldAfter, 'supersede 후 기존 관계 조회 가능');
  assert(oldAfter?.isCurrent === false, '기존 관계 isCurrent === false(대체됨)');
  assert(oldAfter?.validUntil != null, '기존 관계 validUntil 설정됨(now)');

  // current=true → 새 것만(기존 relates_to 제외), resolves(미대체)는 여전히 포함.
  const curList = await listRelationships(userA.token, { workspaceId, current: 'true' });
  assert(curList.status === 200, 'GET /relationships?current=true 200', curList.status);
  const curItems = Array.isArray(curList.json?.items) ? curList.json.items : [];
  const curIds = curItems.map((r) => r.id);
  assert(curIds.includes(newRelId), 'current=true 결과에 새 관계 포함');
  assert(!curIds.includes(oldRelId), 'current=true 결과에 기존(대체된) 관계 제외');
  assert(curItems.every((r) => r.isCurrent === true), 'current=true 결과는 모두 isCurrent');

  // asOf=과거(2025) → 기존(당시 유효) 포함, 새 것(validFrom=now) 제외.
  const asOfList = await listRelationships(userA.token, { workspaceId, asOf: ASOF_PAST });
  assert(asOfList.status === 200, 'GET /relationships?asOf=<과거> 200', asOfList.status);
  const asOfIds = (asOfList.json?.items ?? []).map((r) => r.id);
  assert(asOfIds.includes(oldRelId), 'asOf=과거 결과에 기존(당시 유효) 관계 포함');
  assert(!asOfIds.includes(newRelId), 'asOf=과거 결과에 새 관계(validFrom=now) 제외');

  // ── 8) timeline(entityId) → validFrom 오름차순 ───────────────────────────
  step(8, 'timeline(postgresql) → 관련 관계 validFrom 오름차순(형성/변경 이력)');
  const tl = await timeline(userA.token, { workspaceId, entityId: postgresqlId });
  assert(tl.status === 200, 'GET /v1/graph/timeline 200(소유자)', tl.status);
  assert(tl.json?.entityId === postgresqlId, 'timeline.entityId === 요청 entityId');
  const tlItems = Array.isArray(tl.json?.items) ? tl.json.items : [];
  // supersede 후 postgresql 은 기존(2024) + 새(now) relates_to 2건 이상 보유.
  assert(tlItems.length >= 2, 'timeline items ≥ 2(기존 + supersede 새 관계)', tlItems.length);
  assert(
    tlItems.some((r) => r.id === oldRelId) && tlItems.some((r) => r.id === newRelId),
    'timeline 에 기존/새 관계 모두 포함(이력 보존)',
  );
  let nonDecreasing = true;
  for (let i = 1; i < tlItems.length; i += 1) {
    const prev = Date.parse(tlItems[i - 1].validFrom);
    const cur = Date.parse(tlItems[i].validFrom);
    if (Number.isNaN(prev) || Number.isNaN(cur) || cur < prev) {
      nonDecreasing = false;
      break;
    }
  }
  assert(nonDecreasing, 'timeline 은 validFrom 오름차순(비감소)');

  // ── 9) 권한: 비소유자 userB 는 entities/relationships/extract 403 ─────────
  step(9, '권한: 비소유자 userB 의 entities/relationships 조회 · extract → 403(PRD §26)');
  const userB = await registerUser('graph-nonowner-b');
  const bEnt = await listEntities(userB.token, { workspaceId });
  assert(bEnt.status === 403, 'userB GET /entities 403', bEnt.status);
  const bRel = await listRelationships(userB.token, { workspaceId });
  assert(bRel.status === 403, 'userB GET /relationships 403', bRel.status);
  const bExt = await extractGraph(userB.token, workspaceId);
  assert(bExt.status === 403, 'userB POST /extract 403', bExt.status);
  // 남의 entity 상세도 소유권 재검증에서 403.
  const bDetail = await getEntity(userB.token, route53Id);
  assert(bDetail.status === 403, 'userB GET /entities/:id 403', bDetail.status);

  // ── 10) 멱등: extract 재실행 후 entity/relationship 수 안정 ───────────────
  step(10, '멱등: POST /graph/extract 재실행 → entities/relationships 수 불변(중복 없음)');
  const baseline = await countGraph(userA.token, workspaceId);
  console.log(
    `  · 멱등 기준: entities ${baseline.entities} · relationships ${baseline.relationships}`,
  );
  const reExt = await extractGraph(userA.token, workspaceId);
  assert(reExt.status === 202, '재실행 POST /graph/extract 202', reExt.status);
  // 재추출 잡이 처리될 시간을 주면서, 어느 시점에도 수가 늘지 않아야 한다.
  const deadline = Date.now() + IDEMPOTENCY_WINDOW_MS;
  let lastCount = baseline;
  while (Date.now() < deadline) {
    const now = await countGraph(userA.token, workspaceId);
    assert(
      now.entities <= baseline.entities && now.relationships <= baseline.relationships,
      '재추출 중 entity/relationship 이 늘지 않음(중복 미생성)',
      { before: baseline, now },
    );
    lastCount = now;
    await sleep(POLL_INTERVAL_MS);
  }
  assert(
    lastCount.entities === baseline.entities && lastCount.relationships === baseline.relationships,
    `재추출 후 수 불변(멱등, entities=${baseline.entities}, relationships=${baseline.relationships})`,
    { before: baseline, after: lastCount },
  );

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). 원문/PII/secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
