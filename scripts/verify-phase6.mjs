#!/usr/bin/env node
// =============================================================================
// verify-phase6.mjs — Phase 6(Slack Import) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase6-build-spec.md §8 시나리오(1~10)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + FormData + Blob 만 사용한다(외부 의존성 없음, Node ≥18).
//
// 인증(Bearer)은 verify-phase5.mjs 와 동일하게 POST /v1/auth/register →
//   res.json.tokens.accessToken 을 사용한다(가족/장치 없이 사용자만 필요).
//
// 업로드는 JSON 번들 multipart 다(ZIP 아님, 스펙 §1.1). FormData 에 필드
//   (mySlackUserId/workspaceName/kind)를 **먼저** 붙이고 파일 file 을
//   new Blob([bundleJson], { type:'application/json' }) 로 **마지막**에 붙여
//   POST /v1/slack/import 로 전송한다(서버가 스트림에서 필드 → 파일 순으로 읽음).
//   Content-Type 은 fetch 가 boundary 와 함께 자동 설정하므로 수동 지정하지 않는다.
//
// Import 는 BullMQ 워커에서 **비동기** 파싱된다. 수집 응답은 즉시 status:'queued'
// 로 수락하고, 결과(messageCount 등)는 GET /v1/slack/workspaces/:id 를 폴링(≤10s)해
// 확인한다. 워커는 slack_messages 를 UNIQUE(slackChannelId, ts) 기준
// onConflictDoNothing 으로 upsert 하므로 **재import 는 멱등**(중복 저장 없음)이다.
//
// 접근제어(PRD §26): Slack 데이터는 workspaces.ownerUserId == 현재 userId 인
//   **소유자 본인만** 조회할 수 있다. 가족 구성원·제3자 모두 불가 → 비소유자 403.
//
// 로그에는 문자/메시지 **원문 전체·secret 원문·토큰**을 출력하지 않는다(PRD §11).
//   번들에 secret 메시지를 1건 포함하지만 그 text 는 절대 로그로 남기지 않는다
//   (개수/식별자/집계만 출력).
//
// 실행법:
//   1) 전체 스택 기동(진행자 사전 수행): docker compose up -d --build (+ migrate 0005)
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-phase6.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase6.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
// =============================================================================

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// 비동기 import(수집→파싱) 폴링 상한(스펙 §8 = 10초) + 폴링 간격.
const IMPORT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

let passed = 0;
let failed = 0;

/* -------------------------------------------------------------------------- */
/* 요약 / assert / step 유틸(verify-phase5 스타일)                              */
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
    // extra 는 상태코드/개수/식별자 등 비민감 정보만 전달한다(원문/secret/토큰 금지).
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
// (스펙 §1.4 / parser). 검증도 동일 규약으로 계산한다.
function tsToIso(ts) {
  return new Date(Number(String(ts).split('.')[0]) * 1000).toISOString();
}

// 초 단위(정수)로 만든 ISO — 날짜(from/to) 필터 경계 계산용.
function secToIso(sec) {
  return new Date(sec * 1000).toISOString();
}

// 스레드/메시지 타임라인(초는 모두 상이 → occurredAt 결정론적). 재실행 간
// slack_messages UNIQUE(slackChannelId, ts) 충돌은 없다 — 매 run 마다 새 userA →
// 새 workspace → 새 slack_channels(uuid)라 ts 가 같아도 채널 uuid 가 다르다.
const TS = {
  root: '1721040600.000100', // 스레드 루트 (C1, U1)
  reply1: '1721040660.000200', // 답글1     (C1, U2)
  reply2: '1721040720.000300', // 답글2     (C1, U1)
  keyword: '1721041000.000100', // 키워드 메시지 (C1, U1)
  normalC2: '1721041100.000100', // 일반 메시지  (C2, U1)
  otherC2: '1721041200.000100', // 다른 유저 메시지 (C2, U2)
  secret: '1721041300.000100', // secret 포함 (C1, U1) — text 는 로그 금지
};

// 날짜 필터 창 [FROM, TO): 초 1000/1100/1200/1300 만 포함(스레드 600/660/720 제외).
// 경계(900, 1400)에 걸리는 메시지가 없어 inclusive/exclusive 무관하게 결정론적.
const FILTER_FROM = secToIso(1721040900);
const FILTER_TO = secToIso(1721041400);
const FILTER_EXPECTED_TS = [TS.keyword, TS.normalC2, TS.otherC2, TS.secret];

// 키워드 검색용 유니크 토큰(다른 메시지·secret 에 등장하지 않음).
const KEYWORD = '스프린트회고';

/* -------------------------------------------------------------------------- */
/* Slack export 번들(스펙 §1.1 형식) 생성                                       */
/* -------------------------------------------------------------------------- */
// 채널 2 / 유저 2 / 스레드(루트+답글 2) / 일반 메시지 / 다른 유저 / secret 1개.
// U1 = 내 계정(mySlackUserId), U2 = 타인.
//
// 메시지 구성(총 7건):
//   C1(eng-backend): root(U1) · reply1(U2) · reply2(U1) · keyword(U1) · secret(U1) = 5
//   C2(general)    : normalC2(U1) · otherC2(U2)                                     = 2
//   → U1 메시지 5 / U2 메시지 2, messageCount=7, channelCount=2, userCount=2.
function buildBundle() {
  return {
    workspace: { name: `검증 슬랙 ${RUN}`, slackTeamId: `T-${RUN}` },
    channels: [
      { id: 'C1', name: 'eng-backend' },
      { id: 'C2', name: 'general' },
    ],
    users: [
      { id: 'U1', name: 'soobeen', real_name: '수빈' },
      { id: 'U2', name: 'alex', real_name: 'Alex Kim' },
    ],
    messages: [
      // 스레드(루트 + 답글 2). 루트는 thread_ts === ts, 답글은 thread_ts = 루트 ts.
      {
        channel: 'C1',
        ts: TS.root,
        user: 'U1',
        text: '배포 스레드 시작합니다',
        thread_ts: TS.root,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.reply1,
        user: 'U2',
        text: '확인했습니다',
        thread_ts: TS.root,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: TS.reply2,
        user: 'U1',
        text: '머지 완료했어요',
        thread_ts: TS.root,
        edited_ts: null,
      },
      // 키워드 메시지(유니크 토큰). thread_ts 없음 → 단독.
      {
        channel: 'C1',
        ts: TS.keyword,
        user: 'U1',
        text: `${KEYWORD} 문서 정리했습니다`,
        edited_ts: null,
      },
      // 일반 메시지(C2, 내 계정).
      {
        channel: 'C2',
        ts: TS.normalC2,
        user: 'U1',
        text: '점심 뭐 먹을까요',
        edited_ts: null,
      },
      // 다른 유저 메시지(C2, U2) → isMine=false 확인용.
      {
        channel: 'C2',
        ts: TS.otherC2,
        user: 'U2',
        text: '저는 김밥이요',
        edited_ts: null,
      },
      // secret 포함 메시지 — text 는 절대 로그로 남기지 않는다(파서가 warning, 저장은 유지).
      {
        channel: 'C1',
        ts: TS.secret,
        user: 'U1',
        text: 'CI 토큰 공유: xoxb-dummy-not-a-real-token-phase6',
        edited_ts: null,
      },
    ],
  };
}

const TOTAL_MESSAGES = 7;
const C1_MESSAGES = 5; // eng-backend
const MINE_MESSAGES = 5; // U1

/* -------------------------------------------------------------------------- */
/* HTTP 헬퍼                                                                   */
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
 * 파일 file 을 마지막에 붙인다. 반환: { status, json }.
 */
async function importBundle(token, bundleJson, { mySlackUserId, workspaceName, kind } = {}) {
  const form = new FormData();
  if (mySlackUserId !== undefined) form.append('mySlackUserId', mySlackUserId);
  if (workspaceName !== undefined) form.append('workspaceName', workspaceName);
  if (kind !== undefined) form.append('kind', kind);
  // 파일은 마지막(서버가 필드 → 파일 순으로 스트림 파싱).
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
/* Slack 조회 헬퍼                                                             */
/* -------------------------------------------------------------------------- */

/** GET /v1/slack/workspaces/:id → { status, json }. */
async function getWorkspace(token, id) {
  return req('GET', `/slack/workspaces/${id}`, { token });
}

/**
 * 워크스페이스가 predicate 를 만족할 때까지 폴링(≤10s).
 * predicate(ws) → boolean. 반환: { ok, ws }(마지막 관측).
 */
async function pollWorkspace(token, id, predicate) {
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
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

/** GET /v1/slack/messages 전체 페이지 수집(nextCursor 추적). 반환: { status, items }. */
async function listMessages(token, params = {}) {
  const items = [];
  let cursor;
  let lastStatus = 0;
  for (let page = 0; page < 20; page += 1) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    if (cursor) qs.set('cursor', cursor);
    const res = await req('GET', `/slack/messages?${qs.toString()}`, { token });
    lastStatus = res.status;
    if (res.status !== 200 || !res.json) break;
    const pageItems = Array.isArray(res.json.items) ? res.json.items : [];
    for (const it of pageItems) items.push(it);
    cursor = res.json.nextCursor ?? null;
    if (!cursor) break;
  }
  return { status: lastStatus, items };
}

/** GET /v1/slack/threads?slackWorkspaceId=&channelId=&threadTs= → { status, json }. */
async function getThread(token, { slackWorkspaceId, channelId, threadTs }) {
  const qs = new URLSearchParams({ slackWorkspaceId, channelId, threadTs });
  return req('GET', `/slack/threads?${qs.toString()}`, { token });
}

/** ts 오름차순(숫자 비교) 검사: 배열이 비내림차순인지. */
function isTsAscending(list) {
  for (let i = 1; i < list.length; i += 1) {
    if (parseFloat(list[i - 1]) > parseFloat(list[i])) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Phase 6 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  const bundleJson = JSON.stringify(buildBundle());

  // ── 1) userA 회원가입 ─────────────────────────────────────────────────────
  step(1, 'userA(소유자) 회원가입');
  const userA = await registerUser('slack-owner-a');

  // ── 2)+3) 번들 업로드(multipart) → 200 queued ────────────────────────────
  step(2, 'Slack export 번들 생성(채널2/유저2/스레드+답글2/일반/다른유저/secret) + multipart 업로드');
  console.log(`  · 번들 요약: 채널 2, 유저 2, 메시지 ${TOTAL_MESSAGES}(스레드 답글 2, secret 1 포함)`);
  const imp1 = await importBundle(userA.token, bundleJson, {
    mySlackUserId: 'U1',
    workspaceName: `검증 슬랙 ${RUN}`,
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

  // ── 4) 폴링(≤10s): messageCount>0, channelCount=2, userCount=2 ────────────
  step(4, '폴링(≤10s) GET /v1/slack/workspaces/:id → messageCount·channelCount·userCount');
  const poll1 = await pollWorkspace(
    userA.token,
    slackWorkspaceId,
    (ws) => ws.messageCount >= TOTAL_MESSAGES && ws.lastImportedAt != null,
  );
  assert(poll1.ok, `import 파싱 완료(messageCount=${TOTAL_MESSAGES} 도달, 10s 내)`, {
    messageCount: poll1.ws?.messageCount,
    lastImportedAt: poll1.ws?.lastImportedAt == null ? 'null' : 'set',
  });
  const ws1 = poll1.ws;
  assert(ws1.id === slackWorkspaceId, 'workspace.id === slackWorkspaceId', {
    id: ws1.id,
  });
  assert(ws1.messageCount === TOTAL_MESSAGES, `messageCount === ${TOTAL_MESSAGES}`, ws1.messageCount);
  assert(ws1.channelCount === 2, 'channelCount === 2', ws1.channelCount);
  assert(ws1.userCount === 2, 'userCount === 2', ws1.userCount);
  assert(ws1.mySlackUserId === 'U1', "mySlackUserId === 'U1'", ws1.mySlackUserId);
  const firstImportedAt = ws1.lastImportedAt;

  // ── 5) 멱등: 동일 번들 재업로드 → messageCount 증가 없음 ───────────────────
  step(5, '멱등: 동일 번들 재업로드 → 새 importId, messageCount 불변(중복 저장 없음)');
  const imp2 = await importBundle(userA.token, bundleJson, {
    mySlackUserId: 'U1',
    workspaceName: `검증 슬랙 ${RUN}`,
    kind: 'company',
  });
  assert(imp2.status === 200, '재업로드 POST /v1/slack/import 200', imp2.status);
  const importId2 = imp2.json?.importId;
  assert(typeof importId2 === 'string' && importId2.length > 0, '재업로드 importId 반환');
  assert(importId2 !== importId1, '재업로드는 새 source_item(importId 상이)', {
    same: importId2 === importId1,
  });
  assert(
    imp2.json?.slackWorkspaceId === slackWorkspaceId,
    '재업로드는 동일 slackWorkspaceId(소유 workspace 재사용)',
  );
  // 2차 import 가 실제로 처리(lastImportedAt 전진)될 때까지 폴링 후 messageCount 불변 확인.
  // onConflictDoNothing 이라 중복 행이 원천 불가 → 처리 완료 시 messageCount 는 여전히 7.
  const poll2 = await pollWorkspace(
    userA.token,
    slackWorkspaceId,
    (ws) => ws.lastImportedAt !== firstImportedAt,
  );
  assert(poll2.ok, '재import 워커 처리 완료(lastImportedAt 전진, 10s 내)', {
    advanced: poll2.ok,
  });
  assert(
    poll2.ws.messageCount === TOTAL_MESSAGES,
    `재import 후에도 messageCount === ${TOTAL_MESSAGES}(멱등, 중복 없음)`,
    poll2.ws?.messageCount,
  );
  assert(poll2.ws.channelCount === 2, '재import 후 channelCount === 2(멱등)', poll2.ws?.channelCount);
  assert(poll2.ws.userCount === 2, '재import 후 userCount === 2(멱등)', poll2.ws?.userCount);

  // ── 전체 메시지 목록(소유자) — 이후 검색/스레드에 필요한 식별자 도출 ───────
  step(6, '메시지 목록(소유자) → 채널 uuid·출처 필드 도출');
  const all = await listMessages(userA.token, { slackWorkspaceId });
  assert(all.status === 200, 'GET /v1/slack/messages 200(소유자)', all.status);
  assert(all.items.length === TOTAL_MESSAGES, `전체 메시지 ${TOTAL_MESSAGES}건`, all.items.length);

  // 채널 필터/스레드 조회에 쓸 C1(eng-backend) 채널 식별자를 응답에서 도출한다
  // (contract slackChannelId — DB uuid. 응답에서 얻어 구현 세부에 견고하게).
  const c1Sample = all.items.find((m) => m.channelName === 'eng-backend');
  assert(!!c1Sample, "채널 'eng-backend' 메시지 존재");
  const c1ChannelId = c1Sample.slackChannelId;
  assert(
    typeof c1ChannelId === 'string' && c1ChannelId.length > 0,
    'slackChannelId(채널 식별자) 존재',
  );

  // ── 6) 스레드 복원: ts 오름차순, replyCount 정확, 루트+답글 포함 ───────────
  step(7, '스레드 복원: GET /v1/slack/threads → ts 오름차순, replyCount=2, 루트+답글2 포함');
  const thr = await getThread(userA.token, {
    slackWorkspaceId,
    channelId: c1ChannelId,
    threadTs: TS.root,
  });
  assert(thr.status === 200, 'GET /v1/slack/threads 200', thr.status);
  assert(thr.json?.threadTs === TS.root, 'threadTs === 루트 ts', thr.json?.threadTs);
  assert(thr.json?.channelName === 'eng-backend', "thread channelName === 'eng-backend'", thr.json?.channelName);
  assert(thr.json?.replyCount === 2, 'replyCount === 2(답글 2)', thr.json?.replyCount);
  const thrMsgs = Array.isArray(thr.json?.messages) ? thr.json.messages : [];
  assert(thrMsgs.length === 3, '스레드 메시지 3건(루트 + 답글 2)', thrMsgs.length);
  const thrTsList = thrMsgs.map((m) => m.ts);
  assert(isTsAscending(thrTsList), '스레드 메시지 ts 오름차순 정렬');
  assert(
    JSON.stringify(thrTsList) === JSON.stringify([TS.root, TS.reply1, TS.reply2]),
    '스레드 순서 = [루트, 답글1, 답글2]',
    thrTsList,
  );
  assert(
    thrMsgs.every((m) => m.channelName === 'eng-backend'),
    '스레드 전 메시지 channelName === eng-backend',
  );

  // ── 7a) 키워드 검색: q=유니크토큰 → 해당 메시지만 ─────────────────────────
  step(8, '키워드 검색: q=유니크토큰 → 해당 1건만');
  const kw = await listMessages(userA.token, { slackWorkspaceId, q: KEYWORD });
  assert(kw.status === 200, 'GET /v1/slack/messages?q= 200', kw.status);
  assert(kw.items.length === 1, '키워드 검색 결과 1건', kw.items.length);
  assert(kw.items[0]?.text?.includes(KEYWORD), '검색 결과 text 에 키워드 포함');
  assert(kw.items[0]?.ts === TS.keyword, '검색 결과가 키워드 메시지', kw.items[0]?.ts);

  // ── 7b) 채널 필터 ─────────────────────────────────────────────────────────
  step(9, '채널 필터: channelId=C1 → eng-backend 메시지만(5건)');
  const byChannel = await listMessages(userA.token, {
    slackWorkspaceId,
    channelId: c1ChannelId,
  });
  assert(byChannel.status === 200, 'GET /v1/slack/messages?channelId= 200', byChannel.status);
  assert(byChannel.items.length === C1_MESSAGES, `채널 필터 결과 ${C1_MESSAGES}건`, byChannel.items.length);
  assert(
    byChannel.items.every((m) => m.channelName === 'eng-backend'),
    '채널 필터 결과 전부 eng-backend',
  );

  // ── 7c) 날짜 필터(occurredAt from/to) ─────────────────────────────────────
  step(10, '날짜 필터: from/to 창 → 창 내 4건만(스레드 제외)');
  const byDate = await listMessages(userA.token, {
    slackWorkspaceId,
    from: FILTER_FROM,
    to: FILTER_TO,
  });
  assert(byDate.status === 200, 'GET /v1/slack/messages?from&to 200', byDate.status);
  assert(byDate.items.length === FILTER_EXPECTED_TS.length, `날짜 필터 결과 ${FILTER_EXPECTED_TS.length}건`, byDate.items.length);
  assert(
    byDate.items.every((m) => m.occurredAt >= FILTER_FROM && m.occurredAt <= FILTER_TO),
    '날짜 필터 결과 occurredAt 이 창 [from,to] 내',
  );
  const dateTsSet = new Set(byDate.items.map((m) => m.ts));
  assert(!dateTsSet.has(TS.root), '날짜 필터 결과에 스레드 루트(창 밖) 미포함');
  assert(
    FILTER_EXPECTED_TS.every((t) => dateTsSet.has(t)),
    '날짜 필터 결과에 창 내 메시지 전부 포함',
  );

  // ── 8) mine 필터: mine=true → mySlackUserId 메시지만, isMine=true ──────────
  step(11, 'mine 필터: mine=true → 내(U1) 메시지만(5건), isMine=true');
  // 대조: 필터 없이 조회하면 isMine=false(타인 U2)도 존재해야 한다.
  assert(
    all.items.some((m) => m.isMine === false),
    'mine 미필터 목록에 isMine=false(타인) 메시지 존재',
  );
  const mine = await listMessages(userA.token, { slackWorkspaceId, mine: 'true' });
  assert(mine.status === 200, 'GET /v1/slack/messages?mine=true 200', mine.status);
  assert(mine.items.length === MINE_MESSAGES, `mine 필터 결과 ${MINE_MESSAGES}건`, mine.items.length);
  assert(mine.items.every((m) => m.isMine === true), 'mine 필터 결과 전부 isMine=true');
  assert(
    mine.items.every((m) => m.slackUserId === 'U1'),
    'mine 필터 결과 전부 slackUserId=U1(mySlackUserId)',
  );

  // ── 9) 출처: channelName/authorName/ts/permalinkHint ──────────────────────
  step(12, '출처 표시: channelName/authorName/ts/permalinkHint');
  const src = kw.items[0]; // 키워드(비-secret) 메시지로 검사 — 원문 로그 없음.
  assert(typeof src.channelName === 'string' && src.channelName.length > 0, '출처 channelName 존재', src.channelName);
  assert(typeof src.authorName === 'string' && src.authorName.length > 0, '출처 authorName 존재(정규화된 작성자명)');
  assert(typeof src.ts === 'string' && src.ts.length > 0, '출처 ts 존재', src.ts);
  assert(
    typeof src.permalinkHint === 'string' && src.permalinkHint.length > 0,
    '출처 permalinkHint 존재(#channel@ts 또는 slack:// 힌트)',
  );
  assert(src.occurredAt === tsToIso(src.ts), 'occurredAt === ts 파생(Asia/Seoul ISO 무관 UTC 절대시각)', {
    occurredAt: src.occurredAt,
    expected: tsToIso(src.ts),
  });

  // ── 10) 접근제어: 비소유자(userB) 조회 403 ────────────────────────────────
  step(13, '접근제어: 비소유자 userB 의 workspace/messages/threads 조회 403(PRD §26)');
  const userB = await registerUser('slack-nonowner-b');
  const wsForbidden = await getWorkspace(userB.token, slackWorkspaceId);
  assert(wsForbidden.status === 403, 'userB workspace 상세 403', wsForbidden.status);
  const msgForbidden = await req('GET', `/slack/messages?slackWorkspaceId=${slackWorkspaceId}`, {
    token: userB.token,
  });
  assert(msgForbidden.status === 403, 'userB messages 조회 403', msgForbidden.status);
  const thrForbidden = await getThread(userB.token, {
    slackWorkspaceId,
    channelId: c1ChannelId,
    threadTs: TS.root,
  });
  assert(thrForbidden.status === 403, 'userB threads 조회 403', thrForbidden.status);
  // 비소유자 목록에는 타인 workspace 가 노출되지 않는다.
  const bList = await req('GET', '/slack/workspaces', { token: userB.token });
  assert(bList.status === 200, 'userB workspaces 목록 200', bList.status);
  const bItems = Array.isArray(bList.json?.items)
    ? bList.json.items
    : Array.isArray(bList.json)
      ? bList.json
      : [];
  assert(
    !bItems.some((w) => w.id === slackWorkspaceId),
    'userB 목록에 userA workspace 미노출',
  );

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). 원문/secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
