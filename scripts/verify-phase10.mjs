#!/usr/bin/env node
// =============================================================================
// verify-phase10.mjs — Phase 10(MCP 서버, stdio) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase10-build-spec.md §0/§4 완료 조건을 실 스택 대상으로 검증한다.
// **api 컨테이너 내부에서 실행**하는 것을 전제로 한다(MCP 서버를 child 로 spawn,
// API 는 localhost:3001). 통합자 실행 예:
//
//   docker compose exec -T api node /app/scripts/verify-phase10.mjs
//
// 본 스크립트는 실행마다 **새 시드 계정(RUN 접미사 이메일)** 을 register 로 만들고,
// 그 자격을 그대로 MCP child 의 FAMILY_EMAIL/FAMILY_PASSWORD 로 주입한다. 따라서
// 시드 계정은 정확히 워크스페이스 1개·가족 1개만 갖게 되어 도구의 기본값 자동해석
// (workspaceId=listWorkspaces()[0], householdId=me().memberships[0])이 결정론적이다.
// (외부에서 넘긴 FAMILY_EMAIL 은 계정 신원으로 쓰지 않는다 — 재실행 누적 방지.)
//
// Node 내장 fetch + FormData + Blob + node:crypto + node:child_process 만 사용
// (외부 의존성 없음, Node ≥18).
//
// ── 검증 흐름(스펙 §4) ──────────────────────────────────────────────────────
//  (사전 시드는 본 스크립트가 API 로 직접 수행)
//   1. 시드 계정 register + 가족(household) + 카드 + 승인 문자(finance_summary 용)
//      → 승격 폴링(card_transactions).
//   2. Slack export 번들 import(RAG 근거) → 파싱 폴링 → workspaceId 도출 →
//      RAG 인덱싱 폴링(retrieval hasEvidence). work-query 가 refused 되지 않음을
//      API 로 사전 확인(= MCP memory_search 가 출처 포함 답변을 내도록 보장).
//   3. 타 사용자(userB) 시드: 자기 Slack workspace 생성(권한 경계 테스트용
//      foreign workspaceId 확보).
//   4. MCP 서버 spawn: node <MCP_MAIN>, env FAMILY_API_URL/FAMILY_EMAIL/FAMILY_PASSWORD.
//   5. JSON-RPC over stdio(개행 구분 JSON 메시지, StdioServerTransport 프레이밍):
//        initialize → notifications/initialized → tools/list(6도구) →
//        tools/call 각 도구:
//          · memory_search{question}  → 답변 + 출처(채널/시각)
//          · memory_read{query}       → snippet + 출처
//          · memory_remember{...}     → 생성 확인(API 로 실제 생성 교차검증)
//          · memory_timeline{}        → 최근 기억(remember 한 것 포함)
//          · finance_summary{month}   → 순지출 요약(API monthly 와 금액 일치)
//          · memory_forget{memoryId}  → 삭제(API 로 soft-delete 교차검증)
//        + 권한: memory_read{workspaceId: foreign} → 로그인 사용자 스코프 밖은
//          API 가 403 으로 차단 → MCP 가 오류 메시지로 전달(타인 데이터 미노출).
//   6. MCP 서버 종료(kill).
//
// ── 프로토콜 노트 ────────────────────────────────────────────────────────────
//  · @modelcontextprotocol/sdk 의 StdioServerTransport 는 **개행(\n) 구분 JSON-RPC**
//    메시지를 쓰고 읽는다(Content-Length 프레이밍 아님). 본 검증은 각 요청을
//    `JSON.stringify(msg)+'\n'` 로 stdin 에 쓰고, stdout 을 부분 청크 버퍼링 후
//    개행 단위로 파싱해 id 매칭으로 응답을 수집한다.
//  · stdout 은 MCP 프로토콜 전용이다. MCP 서버 로그는 stderr 로만 나온다 —
//    본 검증은 stderr 를 링버퍼로 모아두고 실패 진단 시에만 말미를 출력한다.
//
// ── 로그 정책(PRD §11) ───────────────────────────────────────────────────────
//  토큰/비밀번호/쿠키/서명/원문 전체를 출력하지 않는다. 실패 상세는 상태코드·개수·
//  식별자·금액 집계 등 비민감 정보만 남긴다. 시드 계정 비밀번호는 상수(재현 가능)이며
//  로그에 찍지 않는다.
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
// =============================================================================

import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

/* -------------------------------------------------------------------------- */
/* 상수                                                                        */
/* -------------------------------------------------------------------------- */

// 검증 자신의 API 호출 대상(= MCP child 와 동일 base). 컨테이너 내부 기본값.
const BASE = process.env.FAMILY_API_URL || process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// MCP 서버 진입점(이미지에 빌드된 산출물). 필요 시 MCP_MAIN 으로 재정의.
const MCP_MAIN = process.env.MCP_MAIN || '/app/apps/mcp/dist/main.js';

// 재실행 시 이메일/eventId UNIQUE 충돌을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// 시드 계정 비밀번호(로그 금지). 외부에서 FAMILY_PASSWORD 를 주면 그것을 쓴다.
const SEED_PASSWORD = process.env.FAMILY_PASSWORD || 'Passw0rd!123';
// 시드 계정 이메일 — 항상 실행별 새 계정(재실행 시 워크스페이스/가족 누적 방지).
const SEED_EMAIL = `mcp-owner-${RUN}@example.com`.toLowerCase();

// 비동기 파이프라인 폴링 상한(스펙 §4 = 15초권) + 간격.
const IMPORT_TIMEOUT_MS = 15_000;
const RAG_TIMEOUT_MS = 15_000;
const PROMOTE_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

// MCP JSON-RPC 요청 타임아웃(login 라운드트립 + 응답 여유). initialize 는 서버가
// 시작 시 login() 을 수행하므로 넉넉히.
const RPC_TIMEOUT_MS = 20_000;

const TIMEZONE = 'Asia/Seoul';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

let passed = 0;
let failed = 0;

// spawn 된 MCP child(실패/성공 종료 전 반드시 kill).
let mcpChild = null;
// MCP stderr 링버퍼(실패 진단용, 말미 일부만 보관).
const stderrRing = [];
const STDERR_RING_MAX = 40;

/* -------------------------------------------------------------------------- */
/* 요약 / assert / step 유틸(verify-phase9 스타일)                              */
/* -------------------------------------------------------------------------- */

function summary() {
  console.log('');
  console.log('────────────────────────────────────────');
  console.log(`요약: 통과 ${passed} · 실패 ${failed}`);
  console.log('────────────────────────────────────────');
}

/** MCP child 정리(중복 호출 안전). */
function killMcp() {
  if (mcpChild && !mcpChild.killed) {
    try {
      mcpChild.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  mcpChild = null;
}

/** 실패 진단용 MCP stderr 말미 출력(비민감 — 서버가 secret 을 stderr 로 내지 않음). */
function dumpStderrTail() {
  if (stderrRing.length === 0) return;
  console.error('  ─ MCP stderr(말미) ─');
  for (const line of stderrRing) {
    console.error(`    | ${line}`);
  }
}

/** child 정리 후 프로세스 종료. */
function finish(code) {
  killMcp();
  process.exit(code);
}

/** 조건이 거짓이면 명확한 메시지 출력 후 즉시 종료(코드 1). */
function assert(cond, msg, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ FAIL: ${msg}`);
  if (extra !== undefined) {
    // extra 는 상태코드/개수/식별자/금액 등 비민감 정보만 전달한다.
    console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  dumpStderrTail();
  summary();
  console.error('\n검증 실패. 위 항목을 확인하세요.');
  finish(1);
}

function step(n, title) {
  console.log(`\n[${n}] ${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* 금액 / 시간 헬퍼(verify-phase5 재사용)                                       */
/* -------------------------------------------------------------------------- */

/** KRW 정수를 천단위 콤마 문자열로(파서는 콤마를 제거해 정수화). */
function krw(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 절대 시각(Date) → Asia/Seoul 벽시계 `MM/DD HH:mm`(파서 DATETIME_RE 포맷). */
function seoulMMDDHHmm(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 현재 Asia/Seoul 달의 `YYYY-MM`(finance_summary month 인자용, 고정 UTC+9). */
function seoulMonthString() {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  const y = seoulNow.getUTCFullYear();
  const m = seoulNow.getUTCMonth() + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

// 거래 시각을 "현재 시각 기준 몇 분 전"으로 배치(연도 롤오버 회피, 현재 달 포함).
const NOW_MS = Date.now();
const minsAgo = (m) => new Date(NOW_MS - m * 60_000);

/* -------------------------------------------------------------------------- */
/* 카드 문자(파서 포맷과 정확히 일치, packages/card-parsers)                     */
/* -------------------------------------------------------------------------- */

const SHINHAN_SENDER = '15447200';

/** 신한 승인 문자(`[Web발신]/신한카드(NNNN)승인/금액 일시불/MM/DD HH:mm/가맹점`). */
function shinhanApproval({ card, amount, merchant, when }) {
  return [
    '[Web발신]',
    `신한카드(${card})승인`,
    `${krw(amount)}원 일시불`,
    seoulMMDDHHmm(when),
    merchant,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Slack export 번들(verify-phase9 형태 재사용)                                 */
/* -------------------------------------------------------------------------- */
// 소유자(userA) 번들: RAG 근거가 되는 스레드 2개(기술 용어 공출현) + 단독 1.
//   work-query/retrieval 이 강하게 매칭되도록 아래 질의와 어휘를 겹쳐 둔다.
const OWNER_CHANNEL = 'eng-log';
const OWNER_MESSAGES_TOTAL = 5;
const OWNER_TS = {
  incRoot: '1721400000.000100',
  incReply: '1721400060.000200',
  relRoot: '1721400200.000100',
  relReply: '1721400260.000200',
  chat: '1721400400.000100',
};
// memory_search/read 가 근거를 확보하도록 번들과 강하게 겹치는 질의.
const RAG_QUERY = 'PostgreSQL 파티셔닝 Redis 캐시 도입 결정';

function buildOwnerBundle() {
  return {
    workspace: { name: `MCP 검증 슬랙 ${RUN}`, slackTeamId: `T-A-${RUN}` },
    channels: [{ id: 'C1', name: OWNER_CHANNEL }, { id: 'C2', name: 'random' }],
    users: [
      { id: 'U1', name: 'soobeen', real_name: '수빈' },
      { id: 'U2', name: 'alex', real_name: 'Alex Kim' },
    ],
    messages: [
      {
        channel: 'C1',
        ts: OWNER_TS.incRoot,
        user: 'U1',
        text: 'Route53 인증서 만료로 장애가 발생했는데 ACM 재발급으로 해결했습니다',
        thread_ts: OWNER_TS.incRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: OWNER_TS.incReply,
        user: 'U2',
        text: '동일 장애 재발 방지를 위해 모니터링 알람을 추가했습니다',
        thread_ts: OWNER_TS.incRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: OWNER_TS.relRoot,
        user: 'U1',
        text: 'PostgreSQL 파티셔닝을 Redis 캐시와 함께 도입하기로 결정했습니다',
        thread_ts: OWNER_TS.relRoot,
        edited_ts: null,
      },
      {
        channel: 'C1',
        ts: OWNER_TS.relReply,
        user: 'U2',
        text: '월 단위 range 파티셔닝으로 진행하기로 정리했습니다',
        thread_ts: OWNER_TS.relRoot,
        edited_ts: null,
      },
      {
        channel: 'C2',
        ts: OWNER_TS.chat,
        user: 'U2',
        text: '다들 수고 많으셨습니다 회고는 내일 오전에 진행합니다',
        edited_ts: null,
      },
    ],
  };
}

// 타 사용자(userB) 번들: 권한 경계 테스트용 별도 workspace. 소유자만 접근 가능하므로
// userA(MCP 로그인 사용자)가 이 workspaceId 로 조회하면 API 가 403 을 준다.
// 아래 마커 문자열은 절대 MCP 오류 응답에 새어 나오면 안 된다(누출 검사).
const FOREIGN_MARKER = `FOREIGN_SECRET_${RUN}`;

function buildForeignBundle() {
  return {
    workspace: { name: `타인 슬랙 ${RUN}`, slackTeamId: `T-B-${RUN}` },
    channels: [{ id: 'C1', name: 'secret-room' }],
    users: [{ id: 'U1', name: 'mallory', real_name: 'Mallory' }],
    messages: [
      {
        channel: 'C1',
        ts: '1721500000.000100',
        user: 'U1',
        text: `${FOREIGN_MARKER} PostgreSQL Redis 극비 문서`,
        thread_ts: '1721500000.000100',
        edited_ts: null,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP 헬퍼(verify-phase9 스타일)                                             */
/* -------------------------------------------------------------------------- */

/** 쿼리스트링 직렬화(undefined/null 생략). */
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

/** 번들 multipart 업로드(POST /v1/slack/import). 필드 먼저 + file(Blob) 마지막. */
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
      headers: { authorization: `Bearer ${token}` },
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

/** 서버 준비 대기(최대 ~30s). */
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

/* -------------------------------------------------------------------------- */
/* 계정 / 시드 헬퍼(verify-phase5·9 재사용)                                     */
/* -------------------------------------------------------------------------- */

/** 회원가입 → { token, email }. */
async function registerUser(em, name) {
  const res = await req('POST', '/auth/register', {
    body: { email: em, password: SEED_PASSWORD, name },
  });
  assert(res.status === 201, `${name} 회원가입 201`, res.status);
  const token = res.json?.tokens?.accessToken;
  assert(typeof token === 'string' && token.length > 0, `${name} accessToken 수신`);
  return { token, email: em };
}

/** 장치 HMAC 서명(verify-phase5 재사용). */
function nowSec() {
  return Math.floor(Date.now() / 1000).toString();
}
function newNonce() {
  return randomBytes(16).toString('hex');
}
function sign(secret, tsSec, nonce, bodyString) {
  return createHmac('sha256', secret).update(`${tsSec}.${nonce}.${bodyString}`).digest('hex');
}

/** 카드 문자 수집(HMAC 가드). 반환: { status, json }. */
async function ingestCardSms({ deviceId, secret }, { eventId, sender, content, receivedAt }) {
  const ts = nowSec();
  const nonce = newNonce();
  const body = JSON.stringify({ eventId, sender, content, receivedAt });
  const sig = sign(secret, ts, nonce, body);
  const headers = {
    'content-type': 'application/json',
    'x-device-id': deviceId,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': sig,
  };
  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}/mobile-events/card-sms`, { method: 'POST', headers, body });
  } catch (err) {
    assert(false, 'card-sms 수집 요청 실패 — 서버 연결 불가', err?.message);
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

/** 문자 1건 수집 후 200/accepted 확인. */
async function sendSms(device, { label, content, receivedAt }) {
  const eventId = `evt-${label}-${RUN}`;
  const res = await ingestCardSms(device, { eventId, sender: SHINHAN_SENDER, content, receivedAt });
  assert(res.status === 200, `[${label}] 수집 응답 200`, res.status);
  assert(res.json?.accepted === true, `[${label}] accepted === true`, res.json?.accepted);
}

/** 카드 등록 → cardId. */
async function registerCard(token, householdId, { maskedNumber, visibility, alias }) {
  const res = await req('POST', '/cards', {
    token,
    body: { householdId, issuer: '신한카드', alias, maskedNumber, visibility },
  });
  assert(res.status >= 200 && res.status < 300, `카드 등록 2xx (${alias})`, res.status);
  const id = res.json?.id;
  assert(typeof id === 'string' && id.length > 0, `카드 id 반환 (${alias})`);
  return id;
}

/** 장치 등록 → { deviceId, secret }. */
async function registerDevice(token, householdId, name, platform) {
  const res = await req('POST', '/devices/register', { token, body: { householdId, name, platform } });
  assert(res.status === 201, `장치 등록 201 (${name})`, res.status);
  const deviceId = res.json?.deviceId;
  const secret = res.json?.secret;
  assert(typeof deviceId === 'string' && deviceId.length > 0, `deviceId 반환 (${name})`);
  assert(typeof secret === 'string' && secret.length > 0, `raw secret 1회 노출 (${name})`);
  return { deviceId, secret };
}

/** 목록 응답에서 배열 추출(bare / {items} / {data}). */
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

/** GET /v1/transactions 전체 페이지 수집. */
async function listTransactions(token, householdId) {
  const items = [];
  let cursor;
  let lastStatus = 0;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ householdId });
    if (cursor) query.set('cursor', cursor);
    const res = await req('GET', `/transactions?${query.toString()}`, { token });
    lastStatus = res.status;
    if (res.status !== 200) break;
    for (const item of extractList(res.json)) items.push(item);
    cursor = res.json && !Array.isArray(res.json) ? res.json.nextCursor : null;
    if (!cursor) break;
  }
  return { status: lastStatus, items };
}

/** 승인 거래 승격 폴링(≤15s). */
async function pollList(token, householdId, predicate) {
  const deadline = Date.now() + PROMOTE_TIMEOUT_MS;
  let last = [];
  while (Date.now() < deadline) {
    const { status, items } = await listTransactions(token, householdId);
    if (status === 200) {
      last = items;
      try {
        if (predicate(items)) return { ok: true, items };
      } catch {
        /* keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, items: last };
}

function findApproval(items, amount) {
  return items.find((t) => t.transactionType === 'approval' && t.amount === amount);
}

/* -------------------------------------------------------------------------- */
/* Slack / RAG 폴링 헬퍼(verify-phase9 재사용)                                  */
/* -------------------------------------------------------------------------- */

async function getWorkspace(token, id) {
  return req('GET', `/slack/workspaces/${id}`, { token });
}

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

/** POST /v1/ai/retrieval → { status, json }. */
async function retrieval(token, { workspaceId, query, topK }) {
  const body = { workspaceId, query };
  if (topK !== undefined) body.topK = topK;
  return req('POST', '/ai/retrieval', { token, body });
}

/** retrieval 이 predicate 를 만족할 때까지 폴링(≤timeout). */
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
/* MCP stdio JSON-RPC 클라이언트                                               */
/* -------------------------------------------------------------------------- */

/**
 * MCP 서버를 spawn 하고 개행 구분 JSON-RPC 로 통신하는 최소 클라이언트.
 *  - request(method, params): id 부여 → stdin write → stdout 에서 id 매칭 응답 대기(타임아웃).
 *  - notify(method, params): id 없는 알림 write(응답 없음).
 * stdout 은 부분 청크를 버퍼링해 개행 단위로 파싱하며, 서버 알림(id 없음)은 무시한다.
 */
function createMcpClient() {
  const child = spawn('node', [MCP_MAIN], {
    env: {
      ...process.env,
      FAMILY_API_URL: BASE,
      FAMILY_EMAIL: SEED_EMAIL,
      FAMILY_PASSWORD: SEED_PASSWORD,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcpChild = child;

  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer }
  let stdoutBuf = '';
  let stderrBuf = '';
  let exited = null; // { code, signal }

  const rejectAll = (err) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // stdout 에 비-JSON 잡음(프로토콜 오염). 무시하되 진단을 위해 stderr 링에 남긴다.
        stderrRing.push(`[stdout non-json] ${line.slice(0, 120)}`);
        if (stderrRing.length > STDERR_RING_MAX) stderrRing.shift();
        continue;
      }
      if (msg && msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
      // 서버 → 클라이언트 알림(id 없음)이나 미매칭 id 는 무시.
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      stderrRing.push(line);
      if (stderrRing.length > STDERR_RING_MAX) stderrRing.shift();
    }
  });

  child.on('error', (err) => {
    exited = { code: null, signal: null, error: err?.message };
    rejectAll(new Error(`MCP child spawn 오류: ${err?.message ?? err}`));
  });

  child.on('exit', (code, signal) => {
    exited = { code, signal };
    rejectAll(new Error(`MCP child 조기 종료(code=${code}, signal=${signal})`));
  });

  const request = (method, params) => {
    if (exited) {
      return Promise.reject(new Error(`MCP child 종료됨(code=${exited.code})`));
    }
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 요청 타임아웃 method=${method} (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`MCP stdin write 실패: ${err?.message ?? err}`));
      }
    });
  };

  const notify = (method, params) => {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* 알림 write 실패는 후속 request 타임아웃으로 드러난다 */
    }
  };

  return { child, request, notify, isExited: () => exited };
}

/** tools/call 결과 content 배열에서 텍스트를 이어붙인다. */
function textOf(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** tools/call 래퍼 — JSON-RPC 응답을 검사해 result 를 반환(에러면 assert 실패). */
async function callTool(mcp, name, args, { allowError = false } = {}) {
  let resp;
  try {
    resp = await mcp.request('tools/call', { name, arguments: args });
  } catch (err) {
    assert(false, `tools/call ${name} 응답 수신`, err?.message);
    return; // unreachable
  }
  if (resp.error && !allowError) {
    assert(false, `tools/call ${name} JSON-RPC 오류 없음`, resp.error?.message ?? resp.error);
  }
  return resp.result;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Phase 10 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN}, mcp=${MCP_MAIN})`);
  await waitForApi();
  const receivedAt = new Date(NOW_MS).toISOString();

  // ── 1) 시드 계정 + 가족 + 카드 + 승인 문자(finance_summary 용) ─────────────
  step(1, '시드 계정(owner) + 가족 + 장치 + 카드 + 승인 문자 2건 → 승격 폴링');
  const userA = await registerUser(SEED_EMAIL, 'mcp-owner');

  const createdHh = await req('POST', '/households', {
    token: userA.token,
    body: { name: `MCP 검증 가족 ${RUN}` },
  });
  assert(createdHh.status >= 200 && createdHh.status < 300, '가족 생성 2xx', createdHh.status);
  const householdId = createdHh.json?.id;
  assert(typeof householdId === 'string' && householdId.length > 0, '가족 id 반환');

  const deviceA = await registerDevice(userA.token, householdId, 'MCP 시드 폰', 'ios');
  const cardHh = await registerCard(userA.token, householdId, {
    maskedNumber: '1234',
    visibility: 'household',
    alias: 'MCP 우리집카드',
  });

  // 승인 2건(이마트 50,000 + 스타벅스 30,000 = 순지출 80,000, 취소 없음).
  const FIN_EMART = 50_000;
  const FIN_STARBUCKS = 30_000;
  const EXPECTED_NET = FIN_EMART + FIN_STARBUCKS; // 80,000
  // 시각은 "몇 분 전"(현재 Asia/Seoul 달 내부, finance_summary 는 월 단위). 월 경계 직후
  // 극소 구간 리스크를 줄이려 작은 오프셋을 쓴다.
  await sendSms(deviceA, {
    label: 'emart',
    content: shinhanApproval({ card: '1234', amount: FIN_EMART, merchant: '이마트', when: minsAgo(3) }),
    receivedAt,
  });
  await sendSms(deviceA, {
    label: 'starbucks',
    content: shinhanApproval({ card: '1234', amount: FIN_STARBUCKS, merchant: '스타벅스', when: minsAgo(2) }),
    receivedAt,
  });
  {
    const { ok } = await pollList(userA.token, householdId, (items) => {
      return (
        findApproval(items, FIN_EMART)?.cardId === cardHh &&
        findApproval(items, FIN_STARBUCKS)?.cardId === cardHh
      );
    });
    assert(ok, '승인 문자 2건 거래 승격 완료(이마트+스타벅스)');
  }

  // ── 2) Slack import(RAG 근거) → workspaceId 도출 → RAG 인덱싱 폴링 ─────────
  step(2, 'Slack export 번들 import → 파싱 폴링 → workspaceId 도출 → RAG 인덱싱(hasEvidence) 폴링');
  const imp = await importBundle(userA.token, JSON.stringify(buildOwnerBundle()), {
    mySlackUserId: 'U1',
    workspaceName: `MCP 검증 슬랙 ${RUN}`,
    kind: 'company',
  });
  assert(imp.status === 200, 'POST /v1/slack/import 200', imp.status);
  const slackWorkspaceId = imp.json?.slackWorkspaceId;
  assert(typeof slackWorkspaceId === 'string' && slackWorkspaceId.length > 0, 'slackWorkspaceId 반환');

  const pollWs = await pollWorkspace(
    userA.token,
    slackWorkspaceId,
    (ws) => ws.messageCount >= OWNER_MESSAGES_TOTAL && ws.lastImportedAt != null,
    IMPORT_TIMEOUT_MS,
  );
  assert(pollWs.ok, `import 파싱 완료(messageCount≥${OWNER_MESSAGES_TOTAL}, 15s 내)`, {
    messageCount: pollWs.ws?.messageCount,
  });
  const workspaceId = pollWs.ws?.workspaceId;
  assert(typeof workspaceId === 'string' && workspaceId.length > 0, 'workspaceId(=workspaces.id) 도출');

  const ragReady = await pollRetrieval(
    userA.token,
    { workspaceId, query: RAG_QUERY, topK: 5 },
    (r) => r.hasEvidence === true && Array.isArray(r.items) && r.items.length > 0,
    RAG_TIMEOUT_MS,
  );
  assert(ragReady.ok, 'RAG 인덱싱 완료(retrieval hasEvidence=true, 15s 내)', {
    itemCount: Array.isArray(ragReady.json?.items) ? ragReady.json.items.length : 'n/a',
  });

  // work-query 가 근거 부족(refused)이 아님을 API 로 사전 확인 → MCP memory_search 도 동일 결과.
  const preWorkQuery = await req('POST', '/ai/work-query', {
    token: userA.token,
    body: { workspaceId, question: RAG_QUERY },
  });
  assert(preWorkQuery.status === 200, 'POST /v1/ai/work-query 200(사전 확인)', preWorkQuery.status);
  assert(preWorkQuery.json?.refused === false, 'work-query refused=false(근거 확보)', preWorkQuery.json?.refused);
  assert(
    Array.isArray(preWorkQuery.json?.citations) && preWorkQuery.json.citations.length > 0,
    'work-query citations 존재(출처)',
    preWorkQuery.json?.citations?.length,
  );

  // ── 3) 타 사용자(userB) 시드 — 권한 경계용 foreign workspaceId 확보 ─────────
  step(3, '타 사용자(userB) Slack workspace 시드 → foreign workspaceId 확보(권한 경계 테스트용)');
  const userB = await registerUser(`mcp-foreign-${RUN}@example.com`, 'mcp-foreign');
  const impB = await importBundle(userB.token, JSON.stringify(buildForeignBundle()), {
    mySlackUserId: 'U1',
    workspaceName: `타인 슬랙 ${RUN}`,
    kind: 'company',
  });
  assert(impB.status === 200, 'userB POST /v1/slack/import 200', impB.status);
  const foreignSlackWsId = impB.json?.slackWorkspaceId;
  assert(typeof foreignSlackWsId === 'string' && foreignSlackWsId.length > 0, 'userB slackWorkspaceId 반환');
  const foreignWs = await pollWorkspace(
    userB.token,
    foreignSlackWsId,
    (ws) => typeof ws.workspaceId === 'string' && ws.workspaceId.length > 0,
    IMPORT_TIMEOUT_MS,
  );
  assert(foreignWs.ok, 'userB workspaceId 도출');
  const foreignWorkspaceId = foreignWs.ws?.workspaceId;
  // 소유자가 다름을 API 로 교차확인(userA 로 foreign 조회 → 403).
  const crossCheck = await req('POST', '/ai/retrieval', {
    token: userA.token,
    body: { workspaceId: foreignWorkspaceId, query: RAG_QUERY },
  });
  assert(crossCheck.status === 403, 'userA→foreign workspace API 403(소유자 전용, 교차확인)', crossCheck.status);

  // ── 4) MCP 서버 spawn + initialize 핸드셰이크 ─────────────────────────────
  step(4, 'MCP 서버 spawn(node dist/main.js) + initialize/notifications/initialized');
  const mcp = createMcpClient();

  let initResp;
  try {
    initResp = await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-phase10', version: '1.0.0' },
    });
  } catch (err) {
    assert(false, 'MCP initialize 응답 수신(서버 기동/로그인 성공)', err?.message);
    return; // unreachable
  }
  assert(!initResp.error, 'initialize JSON-RPC 오류 없음', initResp.error?.message);
  const initResult = initResp.result;
  assert(!!initResult, 'initialize result 존재');
  assert(
    typeof initResult?.protocolVersion === 'string' && initResult.protocolVersion.length > 0,
    'initialize protocolVersion 반환',
    initResult?.protocolVersion,
  );
  assert(
    initResult?.serverInfo?.name === 'family-memory-ai',
    "serverInfo.name === 'family-memory-ai'(스펙 §2.5)",
    initResult?.serverInfo?.name,
  );
  assert(
    initResult?.capabilities && typeof initResult.capabilities === 'object' && 'tools' in initResult.capabilities,
    'capabilities.tools 광고(도구 지원)',
    initResult?.capabilities ? Object.keys(initResult.capabilities) : 'none',
  );

  // 초기화 완료 알림.
  mcp.notify('notifications/initialized', {});

  // ── 5) tools/list — 6개 도구 존재 ─────────────────────────────────────────
  step(5, 'tools/list — 6개 도구(memory_search/read/remember/forget/timeline, finance_summary)');
  const listResp = await mcp.request('tools/list', {});
  assert(!listResp.error, 'tools/list JSON-RPC 오류 없음', listResp.error?.message);
  const tools = Array.isArray(listResp.result?.tools) ? listResp.result.tools : [];
  const toolNames = new Set(tools.map((t) => t?.name));
  const REQUIRED_TOOLS = [
    'memory_search',
    'memory_read',
    'memory_remember',
    'memory_forget',
    'memory_timeline',
    'finance_summary',
  ];
  assert(tools.length >= 6, 'tools/list 6개 이상', tools.length);
  for (const name of REQUIRED_TOOLS) {
    assert(toolNames.has(name), `도구 '${name}' 존재`);
  }
  // 각 도구가 inputSchema(JSON Schema)를 광고하는지.
  for (const name of REQUIRED_TOOLS) {
    const t = tools.find((x) => x?.name === name);
    assert(
      t && t.inputSchema && typeof t.inputSchema === 'object',
      `도구 '${name}' inputSchema 광고`,
    );
  }

  // ── 6) tools/call: memory_search{question} → 답변 + 출처 ───────────────────
  step(6, 'memory_search{question} → 답변 + 출처(채널/시각) 포함(refused 아님)');
  {
    const result = await callTool(mcp, 'memory_search', { question: RAG_QUERY });
    const text = textOf(result);
    assert(text.length > 0, 'memory_search content text 비어있지 않음');
    assert(result?.isError !== true, 'memory_search 오류 아님(isError !== true)', result?.isError);
    assert(text.includes('출처'), "memory_search 결과에 '출처' 목록 포함(citations)");
    assert(
      text.includes(OWNER_CHANNEL),
      `memory_search 출처에 채널명('${OWNER_CHANNEL}') 포함(원문 역추적)`,
    );
  }

  // ── 7) memory_read{query} → snippet + 출처 ────────────────────────────────
  step(7, 'memory_read{query} → snippet + 출처(채널) 포함');
  {
    const result = await callTool(mcp, 'memory_read', { query: RAG_QUERY, topK: 5 });
    const text = textOf(result);
    assert(text.length > 0, 'memory_read content text 비어있지 않음');
    assert(result?.isError !== true, 'memory_read 오류 아님', result?.isError);
    assert(text.includes('출처'), "memory_read 결과에 '출처' 포함");
    assert(text.includes(OWNER_CHANNEL), `memory_read 출처에 채널명('${OWNER_CHANNEL}') 포함`);
  }

  // ── 8) memory_remember{...} → 생성(API 교차검증) ──────────────────────────
  step(8, 'memory_remember{type,subject,content} → 기억 생성(API 로 실제 생성 교차검증)');
  const REMEMBER_SUBJECT = `MCP검증기억-${RUN}`;
  const REMEMBER_CONTENT = `가족 여행 계획을 8월로 확정 ${RUN}`;
  {
    const result = await callTool(mcp, 'memory_remember', {
      type: 'decision',
      subject: REMEMBER_SUBJECT,
      content: REMEMBER_CONTENT,
    });
    const text = textOf(result);
    assert(result?.isError !== true, 'memory_remember 오류 아님', result?.isError);
    assert(text.length > 0, 'memory_remember content text 비어있지 않음');
    assert(text.includes(REMEMBER_SUBJECT), 'memory_remember 결과에 subject 반영(생성 확인)');
  }
  // API 로 실제 생성 교차검증 + 정규 memoryId 확보(forget 대상).
  const memListAfter = await req('GET', `/memory/memories${qs({ workspaceId })}`, { token: userA.token });
  assert(memListAfter.status === 200, 'GET /v1/memory/memories 200(remember 교차검증)', memListAfter.status);
  const remembered = extractList(memListAfter.json).find((m) => m.subject === REMEMBER_SUBJECT);
  assert(!!remembered, 'remember 로 만든 기억이 API 목록에 존재', {
    count: extractList(memListAfter.json).length,
  });
  assert(remembered?.type === 'decision', 'remember 기억 type === decision', remembered?.type);
  const rememberedId = remembered?.id;
  assert(typeof rememberedId === 'string' && rememberedId.length > 0, 'remember 기억 id 확보');

  // ── 9) memory_timeline{} → 최근 기억(remember 포함) ───────────────────────
  step(9, 'memory_timeline{}(entityId 없음) → 최근 기억 목록에 remember 한 기억 포함');
  {
    const result = await callTool(mcp, 'memory_timeline', {});
    const text = textOf(result);
    assert(result?.isError !== true, 'memory_timeline 오류 아님', result?.isError);
    assert(text.length > 0, 'memory_timeline content text 비어있지 않음');
    assert(text.includes(REMEMBER_SUBJECT), 'memory_timeline 결과에 remember 기억 subject 포함(최근순)');
  }

  // ── 10) finance_summary{month} → 순지출 요약(API monthly 와 금액 일치) ─────
  step(10, 'finance_summary{month} → 순지출 요약(API monthly 교차검증, 순지출=80,000)');
  const month = seoulMonthString();
  // API monthly 교차검증(자동 householdId 해석과 동일 스코프).
  const apiMonthly = await req('GET', `/analytics/monthly${qs({ householdId, month })}`, { token: userA.token });
  assert(apiMonthly.status === 200, 'GET /v1/analytics/monthly 200(교차검증)', apiMonthly.status);
  assert(apiMonthly.json?.totalNet === EXPECTED_NET, `API monthly.totalNet === ${EXPECTED_NET}`, apiMonthly.json?.totalNet);
  {
    const result = await callTool(mcp, 'finance_summary', { month });
    const text = textOf(result);
    assert(result?.isError !== true, 'finance_summary 오류 아님', result?.isError);
    assert(text.length > 0, 'finance_summary content text 비어있지 않음');
    // 순지출 금액이 사람이 읽는 텍스트에 포함(콤마 유무 무관).
    const digits = text.replace(/,/g, '');
    assert(
      digits.includes(String(EXPECTED_NET)),
      `finance_summary 결과에 순지출 금액(${EXPECTED_NET}) 포함`,
    );
  }

  // ── 11) memory_forget{memoryId} → 삭제(API soft-delete 교차검증) ──────────
  step(11, 'memory_forget{memoryId} → 삭제 확인(API 목록에서 사라짐 교차검증)');
  {
    const result = await callTool(mcp, 'memory_forget', { memoryId: rememberedId });
    const text = textOf(result);
    assert(result?.isError !== true, 'memory_forget 오류 아님', result?.isError);
    assert(
      /삭제|deleted|true/i.test(text),
      'memory_forget 결과가 삭제 완료를 나타냄',
    );
  }
  const memListForget = await req('GET', `/memory/memories${qs({ workspaceId })}`, { token: userA.token });
  assert(memListForget.status === 200, 'GET /v1/memory/memories 200(forget 교차검증)', memListForget.status);
  const stillThere = extractList(memListForget.json).some((m) => m.id === rememberedId);
  assert(!stillThere, 'forget 후 기억이 목록에서 제거됨(soft-delete 반영)');

  // ── 12) 권한: 로그인 사용자 스코프 밖(타인 workspace)은 오류로 차단 ────────
  step(12, '권한: memory_read{workspaceId: foreign} → 403 을 MCP 오류로 전달(타인 데이터 미노출)');
  {
    // 원시 JSON-RPC 응답을 직접 검사한다(도구 결과 isError / 프로토콜 error / 텍스트 모두 허용).
    let resp;
    try {
      resp = await mcp.request('tools/call', {
        name: 'memory_read',
        arguments: { query: RAG_QUERY, workspaceId: foreignWorkspaceId },
      });
    } catch (err) {
      assert(false, '권한 테스트 tools/call 응답 수신', err?.message);
      return; // unreachable
    }
    const text = textOf(resp.result);
    // 세 경로 중 하나로 반드시 "거부"가 드러나야 한다:
    //   (a) JSON-RPC error, (b) 도구 result.isError, (c) 권한/거부 메시지.
    const denied =
      !!resp.error ||
      resp.result?.isError === true ||
      /403|권한|접근|거부|소유|forbidden|denied|owner/i.test(text) ||
      /403|권한|접근|거부|소유|forbidden|denied|owner/i.test(resp.error?.message ?? '');
    assert(denied, '타인 workspace 조회는 권한 오류로 전달됨(API 403 → MCP)', {
      hasError: !!resp.error,
      isError: resp.result?.isError,
      preview: text.slice(0, 80),
    });
    // 타인 데이터(마커/원문)가 절대 새어 나오지 않아야 한다.
    const combined = `${text}\n${resp.error?.message ?? ''}`;
    assert(!combined.includes(FOREIGN_MARKER), '타인 workspace 원문(마커) 미노출');
    assert(!combined.includes('극비'), '타인 workspace 원문(민감어) 미노출');
  }

  // ── 13) MCP 서버 종료 ─────────────────────────────────────────────────────
  step(13, 'MCP 서버 종료(kill)');
  killMcp();
  assert(true, 'MCP child 종료 요청 완료');

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  finish(0);
}

main().catch((err) => {
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  dumpStderrTail();
  summary();
  finish(1);
});
