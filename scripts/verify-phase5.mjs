#!/usr/bin/env node
// =============================================================================
// verify-phase5.mjs — Phase 5(Analytics · Budgets) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase5-build-spec.md §8.1 시나리오(1~8)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + node:crypto 만 사용(외부 의존성 없음).
//
// 장치 HMAC 서명 프로토콜은 verify-phase4.mjs 와 동일하게 재사용한다(Phase 2 §6):
//   서명 대상 payload = `${X-Timestamp}.${X-Nonce}.${rawBody}` (원본 바이트)
//   X-Signature       = HMAC-SHA256(secret, payload) 의 hex digest
//   요청 body 는 서명한 bodyString 과 **정확히 동일 바이트**로 전송한다.
//   헤더: X-Device-Id / X-Timestamp / X-Nonce / X-Signature, Content-Type JSON.
//
// 카드 문자는 수집 → BullMQ 파싱 → **거래 승격**까지 모두 비동기이므로, 정규화
// 거래(card_transactions)는 최대 10초 폴링한다(GET /v1/transactions). 취소 연결도
// 승격 시점에 확정되므로 상태가 반영될 때까지 폴링한다.
//
// 문자 포맷은 packages/card-parsers 실제 구현(BaseCardParser/ShinhanCardParser)에
// 맞춘다:
//   신한 승인 예)
//     [Web발신]
//     신한카드(1234)승인
//     30,000원 일시불
//     MM/DD HH:mm
//     스타벅스
//   maskedCardNumber 는 `(1234)` → `****1234` 로 추출되며, 카드 자동연결은
//   payment_cards.maskedNumber 뒤 4자리와 매칭한다. 가맹점은 datetime 이후 첫
//   유효 토큰. 카테고리 키워드(@family/shared):
//     스타벅스 → cafe · 이마트/올리브영/다이소 → shopping · 김밥천국 → food ·
//     서울대병원 → medical (categorization.ts CATEGORY_KEYWORD_RULES).
//
// 시딩(구성원 2명, 카드 5장, 승인 6 + 취소 1):
//   userA(owner) 장치 A로 수집:
//     #1 스타벅스 승인 30,000  (household 카드1234) → cafe
//     #2 스타벅스 취소 12,000  (household 카드1234) → #1 부분취소, net 18,000
//     #3 이마트   승인 50,000  (household 카드1234) → shopping
//     #4 올리브영 승인 40,000  (private   카드5678) → shopping (A 본인만)
//     #5 서울대병원 승인 25,000(summary   카드9012) → medical  (요약공개)
//   userB(member) 장치 B로 수집:
//     #6 김밥천국 승인 15,000  (household 카드2345) → food
//     #7 다이소   승인 8,000   (private   카드6789) → shopping (B 본인만)
//
//   actor=userA 공개범위 순지출(본인 ∪ household ∪ summary_only, 타인 private 제외):
//     18,000 + 50,000 + 40,000 + 25,000 + 15,000 = 148,000 (타인 B의 #7 제외)
//   actor=userB 순지출:
//     18,000 + 50,000 + 25,000 + 15,000 + 8,000 = 116,000 (타인 A의 #4 제외)
//
// 검증 시나리오(스펙 §8.1):
//   1) analytics.monthly: totalNet=수동 합, totalApproved/Cancelled, deltaNet 계산,
//      취소 반영(cancellationApplied), 정수.
//   2) categories: 합=totalNet, ratio 합≈1, 카테고리명, 취소 반영(cafe=18,000).
//   3) members: 구성원별 net 합=totalNet(구성원 2명).
//   4) cards: 카드별 net 합=totalNet.
//   5) merchants: 합=totalNet, 타인 summary_only 는 '(비공개)'(userB 관점).
//   6) budgets: household 예산 usageRate=spent/amount, category 예산=해당 카테고리 지출.
//   7) 권한: userB(member) 예산 생성 403, 타인 private 제외(excludedByPermission>0).
//   8) 모든 금액 KRW 정수.
//
// 실행법:
//   1) 전체 스택 기동(진행자 사전 수행): docker compose up -d --build (+ migrate 0004)
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-phase5.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase5.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
//
// 로그에는 원문 전체 / secret 원문·암호문 / 서명 / 토큰 / 비밀번호를 출력하지 않는다
// (PRD §11). 실패 상세는 비민감 정보(상태코드/금액집계 등)만 남긴다.
// =============================================================================

import { createHmac, randomBytes } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일/eventId UNIQUE 충돌을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// 비동기 수집→파싱→승격 폴링 상한(스펙 §0/§8 = 10초) + 폴링 간격.
const PROMOTE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

const TIMEZONE = 'Asia/Seoul';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

let passed = 0;
let failed = 0;

/* -------------------------------------------------------------------------- */
/* 요약 / assert / step 유틸(verify-phase4 스타일)                             */
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
    // extra 는 상태코드/금액집계 등 비민감 정보만 전달한다(원문/secret/서명 금지).
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

/** 근사 비교(부동소수 ratio/usageRate 용). */
function approxEq(a, b, eps = 1e-6) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps;
}

/* -------------------------------------------------------------------------- */
/* 금액 / 시간 헬퍼                                                            */
/* -------------------------------------------------------------------------- */

/** KRW 정수를 천단위 콤마 문자열로(로케일/ICU 비의존). 파서는 콤마를 제거해 정수화. */
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

/** 현재 Asia/Seoul 달의 `YYYY-MM`(예산 list.month 비교용, 고정 UTC+9). */
function seoulMonthString() {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  const y = seoulNow.getUTCFullYear();
  const m = seoulNow.getUTCMonth() + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

// 모든 거래 시각을 "현재 시각 기준 과거"로 배치해 연도 롤오버를 피하고(파서
// FUTURE_TOLERANCE), 취소(#2)는 승인(#1)보다 늦은 시각이 되도록 한다(승격 §3).
const NOW_MS = Date.now();
const minsAgo = (m) => new Date(NOW_MS - m * 60_000);
const OCCUR = {
  a1: minsAgo(60), // #1 스타벅스 승인
  c1: minsAgo(55), // #2 스타벅스 취소(승인보다 늦음)
  t3: minsAgo(45), // #3 이마트 승인
  t4: minsAgo(40), // #4 올리브영 승인(private A)
  t5: minsAgo(35), // #5 서울대병원 승인(summary A)
  t6: minsAgo(30), // #6 김밥천국 승인(household B)
  t7: minsAgo(25), // #7 다이소 승인(private B)
};

// 절대 ISO 집계 창(모든 거래 approvedAt 을 포함, 월 경계와 무관). 직전 동기간은
// 비어 있어(이전 3시간 무거래) previousNet=0 → deltaRate=null 을 결정론적으로 만든다.
const PERIOD_FROM = new Date(NOW_MS - 180 * 60_000).toISOString();
const PERIOD_TO = new Date(NOW_MS + 10 * 60_000).toISOString();

// 직전 동기간에 지출이 존재하는 2차 창(deltaNet<0, deltaRate!=null 검증용).
// current=[T-37m,T+10m) → #5,#6 만; previous=[T-84m,T-37m) → #1(net),#3,#4.
const PERIOD_B_FROM = new Date(NOW_MS - 37 * 60_000).toISOString();
const PERIOD_B_TO = new Date(NOW_MS + 10 * 60_000).toISOString();

/* -------------------------------------------------------------------------- */
/* 카드 문자(파서 포맷과 정확히 일치, packages/card-parsers/BaseCardParser)     */
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

/** 신한 취소 문자(`승인취소` → transactionType='cancellation'). */
function shinhanCancellation({ card, amount, merchant, when }) {
  return [
    '[Web발신]',
    `신한카드(${card})승인취소`,
    `${krw(amount)}원`,
    seoulMMDDHHmm(when),
    merchant,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* HTTP 헬퍼                                                                   */
/* -------------------------------------------------------------------------- */

/** 사용자 인증(Bearer) HTTP 헬퍼. 반환: { status, json }. */
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

/** 회원가입 → { token, email, name }(실패 시 종료). name=label(members 조인 검증용). */
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
/* 장치 HMAC 서명 헬퍼(verify-phase4 재사용)                                    */
/* -------------------------------------------------------------------------- */

/** 현재 epoch seconds(문자열). X-Timestamp 는 정수 epoch seconds 문자열. */
function nowSec() {
  return Math.floor(Date.now() / 1000).toString();
}

/** 매 요청 고유한 nonce(replay 차단 통과용). */
function newNonce() {
  return randomBytes(16).toString('hex');
}

/** sign(secret, tsSec, nonce, bodyString) = HMAC-SHA256(secret, `${ts}.${nonce}.${body}`) hex. */
function sign(secret, tsSec, nonce, bodyString) {
  return createHmac('sha256', secret).update(`${tsSec}.${nonce}.${bodyString}`).digest('hex');
}

/** 카드 문자 수집(POST /v1/mobile-events/card-sms, HMAC 가드). 반환: { status, json }. */
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

/** 문자 1건 수집(HMAC) 후 200/accepted 확인. 반환: { eventId }. */
async function sendSms(device, { label, content, receivedAt }) {
  const eventId = `evt-${label}-${RUN}`;
  const res = await ingestCardSms(device, {
    eventId,
    sender: SHINHAN_SENDER,
    content,
    receivedAt,
  });
  assert(res.status === 200, `[${label}] 수집 응답 200`, res.status);
  assert(res.json?.accepted === true, `[${label}] accepted === true`, res.json?.accepted);
  return { eventId };
}

/* -------------------------------------------------------------------------- */
/* 거래 조회 / 폴링 헬퍼                                                        */
/* -------------------------------------------------------------------------- */

/** 목록 응답에서 배열 추출(bare 배열 / { items } / { data } 모두 안전 처리). */
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

/** GET /v1/transactions 전체 페이지 수집(nextCursor 추적). */
async function listTransactions(token, householdId, extra = {}) {
  const items = [];
  let cursor;
  let lastStatus = 0;
  for (let page = 0; page < 20; page += 1) {
    const qs = new URLSearchParams({ householdId, ...extra });
    if (cursor) qs.set('cursor', cursor);
    const res = await req('GET', `/transactions?${qs.toString()}`, { token });
    lastStatus = res.status;
    if (res.status !== 200) break;
    for (const item of extractList(res.json)) items.push(item);
    cursor = res.json && !Array.isArray(res.json) ? res.json.nextCursor : null;
    if (!cursor) break;
  }
  return { status: lastStatus, items };
}

/**
 * 목록이 predicate 를 만족할 때까지 GET /v1/transactions 를 폴링(≤10s).
 * predicate(items) → boolean. 반환: 마지막 관측 items(만족 못 하면 마지막 상태).
 */
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

/** 승인 거래(type=approval, 특정 amount) 찾기. */
function findApproval(items, amount) {
  return items.find((t) => t.transactionType === 'approval' && t.amount === amount);
}

/* -------------------------------------------------------------------------- */
/* 등록 헬퍼                                                                    */
/* -------------------------------------------------------------------------- */

/** 카드 등록(POST /v1/cards) → cardId. issuer 는 자동연결과 무관(뒤4자리만 매칭). */
async function registerCard(token, householdId, { maskedNumber, visibility, alias }) {
  const res = await req('POST', '/cards', {
    token,
    body: { householdId, issuer: '신한카드', alias, maskedNumber, visibility },
  });
  assert(res.status >= 200 && res.status < 300, `카드 등록 2xx (${alias})`, res.status);
  const id = res.json?.id;
  assert(typeof id === 'string' && id.length > 0, `카드 id 반환 (${alias})`);
  assert(res.json?.visibility === visibility, `카드 visibility=${visibility}`, res.json?.visibility);
  return id;
}

/** 장치 등록(POST /v1/devices/register) → { deviceId, secret }. */
async function registerDevice(token, householdId, name, platform) {
  const res = await req('POST', '/devices/register', {
    token,
    body: { householdId, name, platform },
  });
  assert(res.status === 201, `장치 등록 201 (${name})`, res.status);
  const deviceId = res.json?.deviceId;
  const secret = res.json?.secret;
  assert(typeof deviceId === 'string' && deviceId.length > 0, `deviceId 반환 (${name})`);
  assert(typeof secret === 'string' && secret.length > 0, `raw secret 1회 노출 (${name})`);
  return { deviceId, secret };
}

/** GET /v1/categories 에서 slug → categoryId. */
async function categoryIdBySlug(token, householdId, slug) {
  const res = await req('GET', `/categories?householdId=${householdId}`, { token });
  assert(res.status === 200, 'GET /v1/categories 200', res.status);
  const found = extractList(res.json).find((c) => c?.slug === slug);
  assert(!!found, `카테고리 slug='${slug}' 존재(시스템 시드)`, slug);
  return found.id;
}

/* -------------------------------------------------------------------------- */
/* 분석 조회 헬퍼                                                               */
/* -------------------------------------------------------------------------- */

/** GET /v1/analytics/:kind. period 는 {month} | {from,to} | {} (현재 달). */
async function getAnalytics(token, kind, householdId, period = {}) {
  const qs = new URLSearchParams({ householdId });
  if (period.month) qs.set('month', period.month);
  if (period.from) qs.set('from', period.from);
  if (period.to) qs.set('to', period.to);
  const res = await req('GET', `/analytics/${kind}?${qs.toString()}`, { token });
  return res;
}

/** items 배열의 net 합(SQL 결과를 JS 로 검산 — 계산 자체는 SQL 이 수행함). */
function sumNet(items) {
  return items.reduce((acc, it) => acc + it.net, 0);
}

/** 모든 net 이 정수인지. */
function allIntegerNet(items) {
  return items.every((it) => Number.isInteger(it.net) && Number.isInteger(it.count));
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`Phase 5 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();
  const receivedAt = new Date(NOW_MS).toISOString();

  // ── 0) 셋업: 사용자 2명 + 가족 + 장치 2대 + 카드 5장 ──────────────────────
  step(0, 'userA(owner)+userB(member) 회원가입, 가족 생성, userB 초대·수락, 장치 2대, 카드 5장');
  const userA = await registerUser('analytics-owner-a');
  const userB = await registerUser('analytics-member-b');

  const createdHh = await req('POST', '/households', {
    token: userA.token,
    body: { name: `분석검증 가족 ${RUN}` },
  });
  assert(createdHh.status >= 200 && createdHh.status < 300, '가족 생성 2xx', createdHh.status);
  const householdId = createdHh.json?.id;
  assert(typeof householdId === 'string' && householdId.length > 0, '가족 id 반환');

  // userB 를 member 로 초대·수락.
  const inv = await req('POST', `/households/${householdId}/invitations`, {
    token: userA.token,
    body: { role: 'member' },
  });
  assert(inv.status >= 200 && inv.status < 300, 'userB 초대 생성 2xx', inv.status);
  const inviteToken = inv.json?.token;
  assert(typeof inviteToken === 'string' && inviteToken.length > 0, 'raw 초대 token 수신');
  const accept = await req('POST', `/household-invitations/${inviteToken}/accept`, {
    token: userB.token,
    body: { consent: true },
  });
  assert(accept.status >= 200 && accept.status < 300, 'userB 초대 수락 2xx', accept.status);
  assert(accept.json?.myRole === 'member', 'userB myRole=member', accept.json?.myRole);

  // 장치: A(userA), B(userB, member 도 자기 가족 장치 등록 가능).
  const deviceA = await registerDevice(userA.token, householdId, 'A의 아이폰', 'ios');
  const deviceB = await registerDevice(userB.token, householdId, 'B의 갤럭시', 'android');

  // 카드 5장(등록은 owner userA 가 수행 — 자동연결은 뒤4자리, 거래 memberId 는 장치 소유자).
  const cardHhA = await registerCard(userA.token, householdId, {
    maskedNumber: '1234',
    visibility: 'household',
    alias: 'A 우리집카드',
  });
  const cardPrivA = await registerCard(userA.token, householdId, {
    maskedNumber: '5678',
    visibility: 'private',
    alias: 'A 개인카드',
  });
  const cardSumA = await registerCard(userA.token, householdId, {
    maskedNumber: '9012',
    visibility: 'summary_only',
    alias: 'A 요약공개카드',
  });
  const cardHhB = await registerCard(userA.token, householdId, {
    maskedNumber: '2345',
    visibility: 'household',
    alias: 'B 우리집카드',
  });
  const cardPrivB = await registerCard(userA.token, householdId, {
    maskedNumber: '6789',
    visibility: 'private',
    alias: 'B 개인카드',
  });

  // ── 1) 거래 시딩(승인/취소 문자) + 승격 폴링 ─────────────────────────────
  step(1, '카드 문자 시딩(승인 6 + 취소 1) → 승격 폴링(≤10s), 취소 반영 확인');

  // #1 스타벅스 승인(household A) → 승격 대기.
  await sendSms(deviceA, {
    label: 'a1-starbucks',
    content: shinhanApproval({ card: '1234', amount: 30000, merchant: '스타벅스', when: OCCUR.a1 }),
    receivedAt,
  });
  {
    const { ok } = await pollList(userA.token, householdId, (items) => {
      const t = findApproval(items, 30000);
      return t && t.cardId === cardHhA && t.categorySlug === 'cafe';
    });
    assert(ok, '#1 스타벅스 승인 승격(cardId 연결, categorySlug=cafe)');
  }

  // #2 스타벅스 부분 취소 12,000 → #1 반영(net 18,000) 대기.
  await sendSms(deviceA, {
    label: 'c1-starbucks-cancel',
    content: shinhanCancellation({ card: '1234', amount: 12000, merchant: '스타벅스', when: OCCUR.c1 }),
    receivedAt,
  });
  {
    const { ok, items } = await pollList(userA.token, householdId, (list) => {
      const t = findApproval(list, 30000);
      return t && t.cancelledAmount === 12000 && t.netAmount === 18000;
    });
    const t = findApproval(items, 30000);
    assert(ok, '#2 부분취소 반영: 스타벅스 승인 cancelledAmount=12000, netAmount=18000', {
      cancelledAmount: t?.cancelledAmount,
      netAmount: t?.netAmount,
      status: t?.status,
    });
  }

  // #3~#5 (장치 A), #6~#7 (장치 B) 승인 시딩.
  await sendSms(deviceA, {
    label: 't3-emart',
    content: shinhanApproval({ card: '1234', amount: 50000, merchant: '이마트', when: OCCUR.t3 }),
    receivedAt,
  });
  await sendSms(deviceA, {
    label: 't4-oliveyoung',
    content: shinhanApproval({ card: '5678', amount: 40000, merchant: '올리브영', when: OCCUR.t4 }),
    receivedAt,
  });
  await sendSms(deviceA, {
    label: 't5-hospital',
    content: shinhanApproval({ card: '9012', amount: 25000, merchant: '서울대병원', when: OCCUR.t5 }),
    receivedAt,
  });
  await sendSms(deviceB, {
    label: 't6-kimbap',
    content: shinhanApproval({ card: '2345', amount: 15000, merchant: '김밥천국', when: OCCUR.t6 }),
    receivedAt,
  });
  await sendSms(deviceB, {
    label: 't7-daiso',
    content: shinhanApproval({ card: '6789', amount: 8000, merchant: '다이소', when: OCCUR.t7 }),
    receivedAt,
  });

  // userA 관점: 자기 4건(승인) + household B 1건(김밥천국) 승격 완료 대기.
  {
    const { ok } = await pollList(userA.token, householdId, (items) => {
      return (
        findApproval(items, 50000)?.cardId === cardHhA &&
        findApproval(items, 40000)?.cardId === cardPrivA &&
        findApproval(items, 25000)?.cardId === cardSumA &&
        findApproval(items, 15000)?.cardId === cardHhB
      );
    });
    assert(ok, 'userA 관점: 이마트/올리브영/서울대병원/김밥천국 승격 완료');
  }
  // userB 관점: 자기 private 다이소 승격 완료 대기(userA 는 볼 수 없음).
  {
    const { ok } = await pollList(userB.token, householdId, (items) => {
      return findApproval(items, 8000)?.cardId === cardPrivB;
    });
    assert(ok, 'userB 관점: 다이소(개인카드 B) 승격 완료');
  }

  // ── 2) analytics.monthly (시나리오 1) ────────────────────────────────────
  step(2, 'analytics.monthly: totalNet=148,000, totalApproved/Cancelled, deltaNet, 취소 반영, 정수');
  const period = { from: PERIOD_FROM, to: PERIOD_TO };
  const monthlyRes = await getAnalytics(userA.token, 'monthly', householdId, period);
  assert(monthlyRes.status === 200, 'GET /v1/analytics/monthly 200', monthlyRes.status);
  const monthly = monthlyRes.json;

  assert(monthly?.meta?.cancellationApplied === true, 'meta.cancellationApplied === true');
  assert(monthly?.meta?.period?.timezone === TIMEZONE, `meta.period.timezone === ${TIMEZONE}`, monthly?.meta?.period?.timezone);
  assert(
    Array.isArray(monthly?.meta?.includedMemberIds) && monthly.meta.includedMemberIds.length === 2,
    'meta.includedMemberIds 2명(userA·userB) 포함',
    monthly?.meta?.includedMemberIds?.length,
  );
  assert(Number.isInteger(monthly?.totalNet), 'totalNet 정수', monthly?.totalNet);
  assert(monthly.totalApproved === 160000, 'totalApproved === 160,000 (승인 amount 합)', monthly.totalApproved);
  assert(monthly.totalCancelled === 12000, 'totalCancelled === 12,000 (취소액 합)', monthly.totalCancelled);
  assert(monthly.totalNet === 148000, 'totalNet === 148,000 (취소 반영 순지출)', monthly.totalNet);
  assert(monthly.totalNet === monthly.totalApproved - monthly.totalCancelled, 'totalNet === totalApproved - totalCancelled');
  assert(monthly.transactionCount === 5, 'transactionCount === 5 (scope 내 승인 건수)', monthly.transactionCount);
  assert(monthly.previousNet === 0, 'previousNet === 0 (직전 동기간 무거래)', monthly.previousNet);
  assert(monthly.deltaNet === monthly.totalNet - monthly.previousNet, 'deltaNet === totalNet - previousNet');
  assert(monthly.deltaNet === 148000, 'deltaNet === 148,000', monthly.deltaNet);
  assert(monthly.deltaRate === null, 'deltaRate === null (previousNet=0)', monthly.deltaRate);
  assert(monthly.meta.excludedByPermission >= 1, 'userA meta.excludedByPermission >= 1 (userB private #7 제외)', monthly.meta.excludedByPermission);

  // deltaNet 비제로 검증(직전 동기간 지출 존재하는 2차 창).
  const monthlyB = (await getAnalytics(userA.token, 'monthly', householdId, { from: PERIOD_B_FROM, to: PERIOD_B_TO })).json;
  assert(monthlyB?.totalNet === 40000, '2차 창 totalNet === 40,000 (서울대병원+김밥천국)', monthlyB?.totalNet);
  assert(monthlyB?.previousNet === 108000, '2차 창 previousNet === 108,000 (스타벅스net+이마트+올리브영)', monthlyB?.previousNet);
  assert(monthlyB?.deltaNet === -68000, '2차 창 deltaNet === -68,000', monthlyB?.deltaNet);
  assert(
    monthlyB?.deltaRate !== null && approxEq(monthlyB.deltaRate, -68000 / 108000),
    '2차 창 deltaRate === deltaNet/previousNet (비-null)',
    monthlyB?.deltaRate,
  );

  // ── 3) categories (시나리오 2) ───────────────────────────────────────────
  step(3, 'categories: 합=totalNet, ratio 합≈1, 카테고리명, 취소 반영(cafe=18,000)');
  const catRes = await getAnalytics(userA.token, 'categories', householdId, period);
  assert(catRes.status === 200, 'GET /v1/analytics/categories 200', catRes.status);
  const catItems = catRes.json?.items ?? [];
  assert(allIntegerNet(catItems), 'categories 모든 net/count 정수');
  assert(sumNet(catItems) === monthly.totalNet, 'categories net 합 === totalNet(148,000)', sumNet(catItems));
  const ratioSum = catItems.reduce((a, it) => a + it.ratio, 0);
  assert(approxEq(ratioSum, 1, 1e-6), 'categories ratio 합 ≈ 1', ratioSum);
  const cafe = catItems.find((it) => it.categorySlug === 'cafe');
  const shopping = catItems.find((it) => it.categorySlug === 'shopping');
  const medical = catItems.find((it) => it.categorySlug === 'medical');
  const food = catItems.find((it) => it.categorySlug === 'food');
  assert(cafe?.net === 18000, 'cafe net === 18,000 (취소 반영: 30,000-12,000)', cafe?.net);
  assert(cafe?.categoryName === '카페', "cafe categoryName === '카페'", cafe?.categoryName);
  assert(shopping?.net === 90000, 'shopping net === 90,000 (이마트+올리브영, 타인 다이소 제외)', shopping?.net);
  assert(shopping?.categoryName === '쇼핑', "shopping categoryName === '쇼핑'", shopping?.categoryName);
  assert(medical?.net === 25000, 'medical net === 25,000 (서울대병원)', medical?.net);
  assert(food?.net === 15000, 'food net === 15,000 (김밥천국)', food?.net);

  // ── 4) members (시나리오 3) ──────────────────────────────────────────────
  step(4, 'members: 구성원별 net 합=totalNet(구성원 2명)');
  const memRes = await getAnalytics(userA.token, 'members', householdId, period);
  assert(memRes.status === 200, 'GET /v1/analytics/members 200', memRes.status);
  const memItems = memRes.json?.items ?? [];
  assert(allIntegerNet(memItems), 'members 모든 net/count 정수');
  assert(memItems.length === 2, 'members 항목 2명', memItems.length);
  assert(sumNet(memItems) === monthly.totalNet, 'members net 합 === totalNet(148,000)', sumNet(memItems));
  const memA = memItems.find((it) => it.name === userA.name);
  const memB = memItems.find((it) => it.name === userB.name);
  assert(memA?.net === 133000, 'userA net === 133,000 (스타벅스net+이마트+올리브영+병원)', memA?.net);
  assert(memB?.net === 15000, 'userB net === 15,000 (household 김밥천국; 타인관점 private 제외)', memB?.net);

  // ── 5) cards (시나리오 4) ────────────────────────────────────────────────
  step(5, 'cards: 카드별 net 합=totalNet');
  const cardRes = await getAnalytics(userA.token, 'cards', householdId, period);
  assert(cardRes.status === 200, 'GET /v1/analytics/cards 200', cardRes.status);
  const cardItems = cardRes.json?.items ?? [];
  assert(allIntegerNet(cardItems), 'cards 모든 net/count 정수');
  assert(sumNet(cardItems) === monthly.totalNet, 'cards net 합 === totalNet(148,000)', sumNet(cardItems));
  const cHhA = cardItems.find((it) => it.cardId === cardHhA);
  const cPrivA = cardItems.find((it) => it.cardId === cardPrivA);
  const cSumA = cardItems.find((it) => it.cardId === cardSumA);
  const cHhB = cardItems.find((it) => it.cardId === cardHhB);
  assert(cHhA?.net === 68000, 'household 카드A net === 68,000 (스타벅스net+이마트)', cHhA?.net);
  assert(cPrivA?.net === 40000, 'private 카드A net === 40,000 (올리브영)', cPrivA?.net);
  assert(cSumA?.net === 25000, 'summary 카드A net === 25,000 (서울대병원)', cSumA?.net);
  assert(cHhB?.net === 15000, 'household 카드B net === 15,000 (김밥천국)', cHhB?.net);

  // ── 6) merchants (시나리오 5) — userA(마스킹 없음) + userB('(비공개)') ─────
  step(6, "merchants: 합=totalNet, 타인 summary_only 는 '(비공개)'(userB 관점)");
  const merchA = (await getAnalytics(userA.token, 'merchants', householdId, period)).json?.items ?? [];
  assert(allIntegerNet(merchA), 'merchants(A) 모든 net/count 정수');
  assert(sumNet(merchA) === monthly.totalNet, 'merchants(A) net 합 === totalNet(148,000)', sumNet(merchA));
  assert(merchA.find((it) => it.merchant === '스타벅스')?.net === 18000, "merchants(A) '스타벅스' net === 18,000");
  assert(!merchA.some((it) => it.merchant === '(비공개)'), 'merchants(A): 본인/household 뷰라 (비공개) 없음');

  const merchBRes = await getAnalytics(userB.token, 'merchants', householdId, period);
  assert(merchBRes.status === 200, 'GET /v1/analytics/merchants (userB) 200', merchBRes.status);
  const merchB = merchBRes.json?.items ?? [];
  const redacted = merchB.find((it) => it.merchant === '(비공개)');
  assert(!!redacted, "merchants(B): 타인 summary_only 가맹점은 '(비공개)' 라벨로 포함");
  assert(redacted?.net === 25000, "merchants(B): '(비공개)' net === 25,000 (서울대병원)", redacted?.net);
  assert(
    !merchB.some((it) => typeof it.merchant === 'string' && it.merchant.includes('병원')),
    'merchants(B): 타인 summary_only 실제 가맹점명(병원) 미노출',
  );

  // userB 관점 monthly: 타인(A) private 제외 확인(시나리오 7 일부).
  const monthlyB2 = (await getAnalytics(userB.token, 'monthly', householdId, period)).json;
  assert(monthlyB2?.totalNet === 116000, 'userB totalNet === 116,000 (타인 A private 40,000 제외)', monthlyB2?.totalNet);
  assert(monthlyB2?.meta?.excludedByPermission >= 1, 'userB meta.excludedByPermission >= 1 (A private #4 제외)', monthlyB2?.meta?.excludedByPermission);
  assert(sumNet(merchB) === 116000, 'merchants(B) net 합 === 116,000', sumNet(merchB));

  // ── 7) budgets (시나리오 6) — 현재 달 사용률 ─────────────────────────────
  step(7, 'budgets: household usageRate=spent/amount, category 예산=해당 카테고리 지출');
  const currentMonth = seoulMonthString();

  // 현재 달 기준 순지출/카테고리 지출(예산 spent 와 동일 규약으로 검산).
  const monthlyCur = (await getAnalytics(userA.token, 'monthly', householdId, {})).json;
  assert(Number.isInteger(monthlyCur?.totalNet), '현재 달 monthly.totalNet 정수', monthlyCur?.totalNet);
  const catCur = (await getAnalytics(userA.token, 'categories', householdId, {})).json?.items ?? [];
  const shoppingCurNet = catCur.find((it) => it.categorySlug === 'shopping')?.net ?? 0;

  // household 예산 생성(owner userA).
  const hhBudgetAmount = 300000;
  const hhBudgetRes = await req('POST', '/budgets', {
    token: userA.token,
    body: { householdId, name: '가족 월 예산', scopeType: 'household', amount: hhBudgetAmount },
  });
  assert(hhBudgetRes.status === 201, 'household 예산 생성 201 (owner)', hhBudgetRes.status);
  const hhBudget = hhBudgetRes.json;
  assert(hhBudget?.scopeType === 'household', "예산 scopeType='household'", hhBudget?.scopeType);
  assert(hhBudget?.scopeLabel === '가족 전체', "household scopeLabel='가족 전체'", hhBudget?.scopeLabel);
  assert(hhBudget?.amount === hhBudgetAmount, 'household 예산 amount 저장', hhBudget?.amount);
  assert(Number.isInteger(hhBudget?.spent), 'household 예산 spent 정수', hhBudget?.spent);
  assert(hhBudget.spent === monthlyCur.totalNet, 'household spent === 현재 달 순지출(analytics 일치)', {
    spent: hhBudget?.spent,
    monthlyNet: monthlyCur?.totalNet,
  });
  assert(hhBudget.remaining === hhBudget.amount - hhBudget.spent, 'household remaining === amount - spent', hhBudget?.remaining);
  assert(approxEq(hhBudget.usageRate, hhBudget.spent / hhBudget.amount), 'household usageRate === spent/amount', hhBudget?.usageRate);

  // category(shopping) 예산 생성.
  const shoppingCatId = await categoryIdBySlug(userA.token, householdId, 'shopping');
  const catBudgetAmount = 100000;
  const catBudgetRes = await req('POST', '/budgets', {
    token: userA.token,
    body: { householdId, name: '쇼핑 예산', scopeType: 'category', scopeRefId: shoppingCatId, amount: catBudgetAmount },
  });
  assert(catBudgetRes.status === 201, 'category 예산 생성 201', catBudgetRes.status);
  const catBudget = catBudgetRes.json;
  assert(catBudget?.scopeType === 'category', "예산 scopeType='category'", catBudget?.scopeType);
  assert(catBudget?.scopeRefId === shoppingCatId, 'category scopeRefId=shopping', catBudget?.scopeRefId);
  assert(catBudget?.scopeLabel === '쇼핑', "category scopeLabel='쇼핑'", catBudget?.scopeLabel);
  assert(catBudget.spent === shoppingCurNet, 'category spent === 현재 달 shopping 지출(analytics 일치)', {
    spent: catBudget?.spent,
    shoppingNet: shoppingCurNet,
  });
  assert(approxEq(catBudget.usageRate, catBudget.spent / catBudget.amount), 'category usageRate === spent/amount', catBudget?.usageRate);

  // 예산 목록: 2건, month=현재 달.
  const listRes = await req('GET', `/budgets?householdId=${householdId}`, { token: userA.token });
  assert(listRes.status === 200, 'GET /v1/budgets 200', listRes.status);
  assert(listRes.json?.month === currentMonth, `budgets.month === ${currentMonth}`, listRes.json?.month);
  assert(Array.isArray(listRes.json?.items) && listRes.json.items.length === 2, 'budgets 목록 2건', listRes.json?.items?.length);
  for (const b of listRes.json.items) {
    assert(Number.isInteger(b.amount) && Number.isInteger(b.spent) && Number.isInteger(b.remaining), `[예산 ${b.scopeType}] 금액 정수`, {
      amount: b.amount,
      spent: b.spent,
      remaining: b.remaining,
    });
    assert(approxEq(b.usageRate, b.amount > 0 ? b.spent / b.amount : 0), `[예산 ${b.scopeType}] usageRate=spent/amount`, b.usageRate);
  }

  // ── 8) 권한 (시나리오 7) — userB(member) 예산 생성 403 ────────────────────
  step(8, '권한: userB(member) 예산 생성 403(owner/admin 전용), 타인 private 제외(위에서 확인)');
  const forbidden = await req('POST', '/budgets', {
    token: userB.token,
    body: { householdId, scopeType: 'household', amount: 100000 },
  });
  assert(forbidden.status === 403, 'userB(member) 예산 생성 403', forbidden.status);

  // 비멤버(제3자)는 조회도 403.
  const stranger = await registerUser('analytics-stranger-c');
  const strangerRes = await getAnalytics(stranger.token, 'monthly', householdId, period);
  assert(strangerRes.status === 403, '비멤버 analytics 조회 403(멤버십 강제)', strangerRes.status);
  const strangerBudget = await req('GET', `/budgets?householdId=${householdId}`, { token: stranger.token });
  assert(strangerBudget.status === 403, '비멤버 budgets 조회 403', strangerBudget.status);

  // ── 9) 금액 정수 전수 검사 (시나리오 8) ──────────────────────────────────
  step(9, '모든 analytics/budgets 금액 KRW 정수 전수 검사');
  const intChecks = [
    ['monthly.totalNet', monthly.totalNet],
    ['monthly.totalApproved', monthly.totalApproved],
    ['monthly.totalCancelled', monthly.totalCancelled],
    ['monthly.previousNet', monthly.previousNet],
    ['monthly.deltaNet', monthly.deltaNet],
    ['monthly.excludedByPermission', monthly.meta.excludedByPermission],
    ['budget(household).spent', hhBudget.spent],
    ['budget(household).remaining', hhBudget.remaining],
    ['budget(category).spent', catBudget.spent],
    ['budget(category).remaining', catBudget.remaining],
  ];
  for (const [label, value] of intChecks) {
    assert(Number.isInteger(value), `${label} 정수`, value);
  }
  assert(allIntegerNet(catItems) && allIntegerNet(memItems) && allIntegerNet(cardItems) && allIntegerNet(merchA) && allIntegerNet(merchB), '모든 breakdown net/count 정수');

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
