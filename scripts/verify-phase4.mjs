#!/usr/bin/env node
// =============================================================================
// verify-phase4.mjs — Phase 4(거래 관리: Cards & Transactions) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase4-build-spec.md §8 시나리오(1~10)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + node:crypto 만 사용(외부 의존성 없음).
//
// 장치 HMAC 서명 프로토콜(Phase 2 §1.2 / verify-phase2·verify-phase3 와 동일):
//   서명 대상 payload = `${X-Timestamp}.${X-Nonce}.${rawBody}`  (원본 바이트)
//   X-Signature       = HMAC-SHA256(secret, payload) 의 hex digest
//   요청 body 는 서명한 bodyString 과 **정확히 동일 바이트**로 전송한다
//   (JSON.stringify 결과 문자열을 그대로 fetch body 로 사용).
//   헤더: X-Device-Id / X-Timestamp / X-Nonce / X-Signature, Content-Type JSON.
//
// 카드 문자는 수집 → BullMQ 파싱 → **거래 승격**까지 모두 **비동기**(같은 잡 내
// 승격, 별도 큐 없음)이므로, 정규화 거래(card_transactions)는 최대 10초 폴링한다
// (GET /v1/transactions). 승인/부분취소/전체취소 연결과 2차 중복 판정도 승격 시점에
// 확정되므로 상태가 반영될 때까지 폴링한다.
//
// 문자 포맷은 packages/card-parsers 실제 구현(BaseCardParser)에 맞춘다:
//   신한 승인 예)
//     [Web발신]
//     신한카드(1234)승인
//     12,500원 일시불
//     MM/DD HH:mm
//     스타벅스
//   maskedCardNumber 는 `(1234)` → `****1234` 로 추출되며, 카드 자동연결은
//   payment_cards.maskedNumber 의 **뒤 4자리**와 매칭한다(스펙 §1.5).
//   가맹점은 datetime 이후 첫 유효 토큰. 카테고리 키워드(@family/shared):
//   `스타벅스 → cafe`(scenario 3), 사용자 규칙 저장 후 `스타벅스 → food`(scenario 6).
//
// 검증 시나리오(스펙 §8):
//   1)  userA 회원가입 + 가족 + 장치 등록(raw secret 1회).
//   2)  카드 등록(신한, maskedNumber '1234', visibility household) → householdCardId.
//   3)  승인 문자(신한/1234/스타벅스/12,500원) → 승격 폴링:
//       approval 거래, cardId 연결, netAmount=12500, categorySlug='cafe'.
//   4)  부분 취소(같은 카드/가맹점 5,000원) → 승인.status='partially_cancelled',
//       cancelledAmount=5000, netAmount=7500. 취소 레코드 netAmount=0, parent 연결.
//   5)  잔액 전체 취소(7,500원) → 승인.status='cancelled', netAmount=0, cancelledAmount=12500.
//   6)  카테고리 수정(PATCH 승인거래 categoryId=food, applyRule=true) → 규칙 저장.
//       같은 가맹점 새 승인(다른 eventId) 승격 → categorySlug='food'(이후 거래 적용).
//   7)  공개범위: userB member 초대·수락. private 카드(+승인) / summary_only 카드(+승인)
//       등록. userB GET /v1/transactions: household 거래 포함, 타인 private 제외,
//       타인 summary_only 는 가맹점 마스킹(masked=true, merchantRaw=null) 포함.
//   8)  월 요약: GET /v1/transactions/summary → totalNet = 승인 netAmount 합(취소 반영),
//       정수. 목록에서 재계산한 값과 일치.
//   9)  2차 중복: 동일 카드/금액/가맹점/시각 유사 다른 eventId 승인 → status='duplicate_suspected'.
//   10) 모든 금액(amount/cancelledAmount/netAmount)이 KRW 정수, netAmount 규약 준수.
//
// 실행법:
//   1) 전체 스택 기동(진행자가 사전 수행): docker compose up -d --build
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-phase4.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase4.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
//
// 로그에는 원문 전체 / secret 원문·암호문 / 서명 / 토큰 / 비밀번호를 출력하지 않는다
// (PRD §11). 실패 상세는 비민감 정보(상태코드/거래상태/금액집계 등)만 남긴다.
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

let passed = 0;
let failed = 0;

// ── 요약/assert/step 유틸(verify-phase3 스타일) ──────────────────────────────
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
    // extra 는 상태코드/거래상태/금액집계 등 비민감 정보만 전달한다(원문/secret/서명 금지).
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

// ── 금액/시간 헬퍼 ───────────────────────────────────────────────────────────

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

// 모든 거래 시각을 "현재 시각 기준 과거"로 배치해 연도 롤오버를 피하고,
// 취소는 승인보다 늦은 시각(승인.approvedAt < 취소.cancelledAt)이 되도록 한다(스펙 §6.7).
const NOW_MS = Date.now();
const minsAgo = (m) => new Date(NOW_MS - m * 60_000);
const OCCUR = {
  approval1: minsAgo(60), // 최초 승인
  partialCancel: minsAgo(50), // 부분 취소(승인보다 늦음)
  fullCancel: minsAgo(40), // 전체 취소(부분보다 늦음)
  approval2: minsAgo(30), // 규칙 적용 대상 새 승인
  privateApproval: minsAgo(25), // private 카드 승인
  summaryApproval: minsAgo(20), // summary_only 카드 승인
  duplicate: minsAgo(30), // 2차 중복(approval2 와 동일 시각·카드·금액·가맹점)
};
// 월 요약 조회 창(모든 거래 approvedAt 을 포함하도록 넉넉히 브래킷). 절대 ISO 구간이라
// 월 경계(자정/월초)와 무관하게 위 거래를 정확히 포함한다.
const PERIOD_FROM = new Date(NOW_MS - 90 * 60_000).toISOString();
const PERIOD_TO = new Date(NOW_MS + 10 * 60_000).toISOString();

// ── 카드 문자(파서 포맷과 정확히 일치, packages/card-parsers/BaseCardParser) ──
const CARD = { household: '1234', private: '5678', summaryOnly: '9012' };
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

// ── HTTP 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 사용자 인증(Bearer) HTTP 헬퍼. body 가 있으면 JSON 직렬화, token 이 있으면 Bearer.
 * 반환: { status, json }.
 */
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

/** 회원가입 → accessToken 반환(실패 시 종료). */
async function registerUser(label) {
  const em = email(label);
  const res = await req('POST', '/auth/register', {
    body: { email: em, password: PASSWORD, name: label },
  });
  assert(res.status === 201, `${label} 회원가입 201`, res.status);
  const token = res.json?.tokens?.accessToken;
  assert(typeof token === 'string' && token.length > 0, `${label} accessToken 수신`);
  return { token, email: em };
}

// ── 장치 HMAC 서명 헬퍼(verify-phase2/3 재사용) ──────────────────────────────

/** 현재 epoch seconds(문자열). X-Timestamp 는 정수 epoch seconds 문자열(Phase 2 §4.4). */
function nowSec() {
  return Math.floor(Date.now() / 1000).toString();
}

/** 매 요청 고유한 nonce(replay 차단 통과용). */
function newNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * 서명 레시피(Phase 2 §6):
 *   sign(secret, tsSec, nonce, bodyString) = HMAC-SHA256(secret, `${tsSec}.${nonce}.${bodyString}`) hex
 */
function sign(secret, tsSec, nonce, bodyString) {
  return createHmac('sha256', secret).update(`${tsSec}.${nonce}.${bodyString}`).digest('hex');
}

/**
 * 카드 문자 수집 요청(POST /v1/mobile-events/card-sms, HMAC 가드 경유).
 * body 는 서명한 bodyString 과 **동일 바이트**로 전송한다. 반환: { status, json }.
 */
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

/**
 * 문자 1건 수집(HMAC) 후 200/accepted 확인. 반환: 응답 json.
 * eventId 는 실행별 고유(RUN) + 라벨로 구성한다.
 */
async function sendSms(device, { label, sender, content, receivedAt }) {
  const eventId = `evt-${label}-${RUN}`;
  const res = await ingestCardSms(device, { eventId, sender, content, receivedAt });
  assert(res.status === 200, `[${label}] 수집 응답 200`, res.status);
  assert(res.json?.accepted === true, `[${label}] accepted === true`, res.json?.accepted);
  return { eventId, json: res.json };
}

// ── 거래 조회/폴링 헬퍼 ──────────────────────────────────────────────────────

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
    // limit 은 서버 기본(50)에 맡긴다 — 검증 거래는 한 자릿수라 기본 페이지에 모두 담긴다.
    // (숫자 쿼리 파라미터의 strict 검증 여부에 의존하지 않기 위함.) nextCursor 로 안전하게 이어 읽는다.
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
 * predicate 를 만족하는 거래가 나타날 때까지 GET /v1/transactions 를 폴링(≤10s).
 * 반환: 매칭 거래(없으면 null) + 관측 카운트.
 */
async function pollTransactions(token, householdId, predicate) {
  const deadline = Date.now() + PROMOTE_TIMEOUT_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    const { status, items } = await listTransactions(token, householdId);
    if (status === 200) {
      seen = items.length;
      const found = items.find((t) => {
        try {
          return predicate(t);
        } catch {
          return false;
        }
      });
      if (found) return { txn: found, seen };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { txn: null, seen };
}

/** 단건 거래를 predicate 만족까지 폴링(GET /v1/transactions/:id, ≤10s). */
async function pollTransactionById(token, id, predicate) {
  const deadline = Date.now() + PROMOTE_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    const res = await req('GET', `/transactions/${id}`, { token });
    if (res.status === 200 && res.json) {
      last = res.json;
      try {
        if (predicate(res.json)) return { txn: res.json };
      } catch {
        /* keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { txn: null, last };
}

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

/** GET /v1/categories 에서 slug → categoryId. */
async function categoryIdBySlug(token, householdId, slug) {
  const res = await req('GET', `/categories?householdId=${householdId}`, { token });
  assert(res.status === 200, 'GET /v1/categories 200', res.status);
  const found = extractList(res.json).find((c) => c?.slug === slug);
  assert(!!found, `카테고리 slug='${slug}' 존재(시스템 시드)`, slug);
  return found.id;
}

/** 승인 거래 netAmount 규약 검증: netAmount === amount - cancelledAmount. */
function assertApprovalNet(t, label) {
  assert(
    t.netAmount === t.amount - t.cancelledAmount,
    `[${label}] netAmount === amount - cancelledAmount`,
    { amount: t.amount, cancelledAmount: t.cancelledAmount, netAmount: t.netAmount },
  );
}

// =============================================================================
async function main() {
  console.log(`Phase 4 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();
  const receivedAt = new Date(NOW_MS).toISOString();

  // ── 1) userA 회원가입 + 가족 + 장치 등록 ──────────────────────────────────
  step(1, 'userA 회원가입 + 가족 생성 + 장치 등록(raw secret 1회 수신)');
  const userA = await registerUser('txn-owner-a');
  const createdHh = await req('POST', '/households', {
    token: userA.token,
    body: { name: `거래검증 가족 ${RUN}` },
  });
  assert(createdHh.status >= 200 && createdHh.status < 300, '가족 생성 2xx', createdHh.status);
  const householdId = createdHh.json?.id;
  assert(typeof householdId === 'string' && householdId.length > 0, '가족 id 반환');

  const reg = await req('POST', '/devices/register', {
    token: userA.token,
    body: { householdId, name: 'A의 아이폰', platform: 'ios' },
  });
  assert(reg.status === 201, '장치 등록 201', reg.status);
  const device = { deviceId: reg.json?.deviceId, secret: reg.json?.secret };
  assert(typeof device.deviceId === 'string' && device.deviceId.length > 0, 'deviceId 반환');
  assert(typeof device.secret === 'string' && device.secret.length > 0, 'raw secret 1회 노출');

  // ── 2) 카드 등록(신한, 1234, household) ───────────────────────────────────
  step(2, "카드 등록(신한, maskedNumber '1234', visibility household)");
  const householdCardId = await registerCard(userA.token, householdId, {
    maskedNumber: CARD.household,
    visibility: 'household',
    alias: '우리집 신한카드',
  });

  // ── 3) 승인 문자 → 승격(카드연결/netAmount/키워드 카테고리) ────────────────
  step(3, '신한 승인 문자(스타벅스 12,500원) → 승격: approval, cardId 연결, netAmount=12500, categorySlug=cafe');
  await sendSms(device, {
    label: 'approval1',
    sender: SHINHAN_SENDER,
    content: shinhanApproval({ card: CARD.household, amount: 12500, merchant: '스타벅스', when: OCCUR.approval1 }),
    receivedAt,
  });
  const { txn: approval1, seen: seen3 } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.transactionType === 'approval' && t.amount === 12500,
  );
  assert(approval1 !== null, '10초 내 승인 거래 승격 완료(GET /v1/transactions)', `관측 ${seen3}건`);
  const approval1Id = approval1.id;
  assert(approval1.cardId === householdCardId, '카드 자동연결(cardId=householdCardId)', approval1.cardId);
  assert(approval1.transactionType === 'approval', "transactionType='approval'", approval1.transactionType);
  assert(approval1.status === 'approved', "초기 status='approved'", approval1.status);
  assert(approval1.netAmount === 12500, 'netAmount === 12500', approval1.netAmount);
  assert(approval1.cancelledAmount === 0, '초기 cancelledAmount === 0', approval1.cancelledAmount);
  assert(approval1.currency === 'KRW', "currency='KRW'", approval1.currency);
  assert(approval1.categorySlug === 'cafe', "categorySlug='cafe'(키워드 규칙)", approval1.categorySlug);
  assert(
    typeof approval1.merchantRaw === 'string' && approval1.merchantRaw.includes('스타벅스'),
    "merchantRaw 에 '스타벅스' 포함",
    approval1.merchantRaw,
  );
  assert(typeof approval1.approvedAt === 'string' && approval1.approvedAt.length > 0, 'approvedAt ISO 문자열');
  assert(approval1.visibility === 'household', "거래 visibility 상속='household'", approval1.visibility);

  // ── 4) 부분 취소 → partially_cancelled ────────────────────────────────────
  step(4, '부분 취소(스타벅스 5,000원) → 승인.status=partially_cancelled, cancelledAmount=5000, netAmount=7500');
  await sendSms(device, {
    label: 'cancel-partial',
    sender: SHINHAN_SENDER,
    content: shinhanCancellation({ card: CARD.household, amount: 5000, merchant: '스타벅스', when: OCCUR.partialCancel }),
    receivedAt,
  });
  const { txn: afterPartial, last: partialLast } = await pollTransactionById(
    userA.token,
    approval1Id,
    (t) => t.cancelledAmount === 5000,
  );
  assert(afterPartial !== null, '10초 내 부분 취소 연결 반영', partialLast?.cancelledAmount);
  assert(afterPartial.status === 'partially_cancelled', "status='partially_cancelled'", afterPartial.status);
  assert(afterPartial.cancelledAmount === 5000, 'cancelledAmount === 5000', afterPartial.cancelledAmount);
  assert(afterPartial.netAmount === 7500, 'netAmount === 7500 (12500-5000)', afterPartial.netAmount);
  assertApprovalNet(afterPartial, '부분취소 후 승인');

  // 취소 레코드 자체 검증: netAmount=0, 승인에 parentTransactionId 로 연결(스펙 §1.2/§6.7).
  const { txn: partialCancelRec } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.transactionType === 'cancellation' && t.amount === 5000,
  );
  assert(partialCancelRec !== null, '부분 취소 레코드(cancellation, amount=5000) 존재');
  assert(partialCancelRec.netAmount === 0, '취소 레코드 netAmount === 0(이중계상 방지)', partialCancelRec.netAmount);
  assert(
    partialCancelRec.parentTransactionId === approval1Id,
    '취소 레코드 parentTransactionId → 승인 연결',
    partialCancelRec.parentTransactionId,
  );

  // ── 5) 잔액 전체 취소 → cancelled, netAmount=0 ────────────────────────────
  step(5, '잔액 전체 취소(7,500원) → 승인.status=cancelled, netAmount=0, cancelledAmount=12500');
  await sendSms(device, {
    label: 'cancel-full',
    sender: SHINHAN_SENDER,
    content: shinhanCancellation({ card: CARD.household, amount: 7500, merchant: '스타벅스', when: OCCUR.fullCancel }),
    receivedAt,
  });
  const { txn: afterFull, last: fullLast } = await pollTransactionById(
    userA.token,
    approval1Id,
    (t) => t.status === 'cancelled',
  );
  assert(afterFull !== null, '10초 내 전체 취소 연결 반영', fullLast?.status);
  assert(afterFull.status === 'cancelled', "status='cancelled'", afterFull.status);
  assert(afterFull.cancelledAmount === 12500, 'cancelledAmount === 12500', afterFull.cancelledAmount);
  assert(afterFull.netAmount === 0, 'netAmount === 0(전체 취소)', afterFull.netAmount);
  assertApprovalNet(afterFull, '전체취소 후 승인');

  // ── 6) 카테고리 수정 + 규칙 저장 → 이후 거래 적용 ─────────────────────────
  step(6, '카테고리 수정(PATCH categoryId=food, applyRule=true) → 규칙 저장, 이후 승인은 categorySlug=food');
  const foodId = await categoryIdBySlug(userA.token, householdId, 'food');
  const patch = await req('PATCH', `/transactions/${approval1Id}`, {
    token: userA.token,
    body: { categoryId: foodId, applyRule: true },
  });
  assert(patch.status >= 200 && patch.status < 300, 'PATCH 거래 카테고리 2xx', patch.status);

  // 직접 지정(우선순위 1) 확인: 승인#1 재조회 → categoryId/categorySlug=food.
  const afterPatch = await req('GET', `/transactions/${approval1Id}`, { token: userA.token });
  assert(afterPatch.status === 200, 'PATCH 후 거래 재조회 200', afterPatch.status);
  assert(afterPatch.json?.categoryId === foodId, '거래 categoryId=food(직접 지정)', afterPatch.json?.categoryId);
  assert(afterPatch.json?.categorySlug === 'food', "거래 categorySlug='food'", afterPatch.json?.categorySlug);

  // 규칙 적용(우선순위 2): 같은 가맹점 새 승인(다른 eventId) 승격 → food(이후 거래).
  await sendSms(device, {
    label: 'approval2',
    sender: SHINHAN_SENDER,
    content: shinhanApproval({ card: CARD.household, amount: 4300, merchant: '스타벅스', when: OCCUR.approval2 }),
    receivedAt,
  });
  const { txn: approval2 } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.transactionType === 'approval' && t.amount === 4300 && t.status === 'approved',
  );
  assert(approval2 !== null, '10초 내 새 승인(4,300원) 승격 완료');
  assert(approval2.categorySlug === 'food', "규칙 적용: 새 스타벅스 승인 categorySlug='food'(이후 거래)", approval2.categorySlug);
  assert(approval2.netAmount === 4300, '새 승인 netAmount === 4300', approval2.netAmount);

  // ── 7) 공개범위: userB member / private 제외 / summary_only 마스킹 ─────────
  step(7, '공개범위: userB member 초대·수락, private 타인 제외, summary_only 타인 마스킹, household 포함');
  const userB = await registerUser('txn-member-b');
  const inv = await req('POST', `/households/${householdId}/invitations`, {
    token: userA.token,
    body: { role: 'member' },
  });
  assert(inv.status >= 200 && inv.status < 300, '초대 생성 2xx', inv.status);
  const inviteToken = inv.json?.token;
  assert(typeof inviteToken === 'string' && inviteToken.length > 0, 'raw 초대 token 수신');
  const accept = await req('POST', `/household-invitations/${inviteToken}/accept`, {
    token: userB.token,
    body: { consent: true },
  });
  assert(accept.status >= 200 && accept.status < 300, 'userB 초대 수락 2xx', accept.status);
  assert(accept.json?.myRole === 'member', 'userB myRole=member', accept.json?.myRole);

  // userA: private 카드 + 승인, summary_only 카드 + 승인 등록.
  const privateCardId = await registerCard(userA.token, householdId, {
    maskedNumber: CARD.private,
    visibility: 'private',
    alias: 'A의 비밀 카드',
  });
  const summaryCardId = await registerCard(userA.token, householdId, {
    maskedNumber: CARD.summaryOnly,
    visibility: 'summary_only',
    alias: 'A의 요약공개 카드',
  });
  await sendSms(device, {
    label: 'private-approval',
    sender: SHINHAN_SENDER,
    content: shinhanApproval({ card: CARD.private, amount: 20000, merchant: '이마트', when: OCCUR.privateApproval }),
    receivedAt,
  });
  await sendSms(device, {
    label: 'summary-approval',
    sender: SHINHAN_SENDER,
    content: shinhanApproval({ card: CARD.summaryOnly, amount: 15000, merchant: '올리브영', when: OCCUR.summaryApproval }),
    receivedAt,
  });

  // 승격 완료 대기(userA 시점에서 두 거래가 모두 보일 때까지).
  const { txn: privSeen } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.cardId === privateCardId && t.transactionType === 'approval',
  );
  assert(privSeen !== null, 'private 카드 승인 승격 완료(userA 관측)');
  assert(privSeen.visibility === 'private', "private 거래 visibility='private'(카드 상속)", privSeen.visibility);
  const { txn: sumSeen } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.cardId === summaryCardId && t.transactionType === 'approval',
  );
  assert(sumSeen !== null, 'summary_only 카드 승인 승격 완료(userA 관측)');
  assert(sumSeen.visibility === 'summary_only', "summary_only 거래 visibility 상속", sumSeen.visibility);

  // userB(member) 목록: household 포함, 타인 private 제외, 타인 summary_only 마스킹.
  const bList = await listTransactions(userB.token, householdId);
  assert(bList.status === 200, 'userB 거래 목록 조회 200', bList.status);

  const bHousehold = bList.items.filter((t) => t.cardId === householdCardId);
  assert(bHousehold.length >= 1, 'userB: household 카드 거래 포함', bHousehold.length);
  assert(
    bHousehold.every((t) => t.masked === false),
    'userB: household 거래는 마스킹되지 않음(masked=false)',
  );
  assert(
    bHousehold.some((t) => typeof t.merchantRaw === 'string' && t.merchantRaw.includes('스타벅스')),
    'userB: household 거래 가맹점 원문 노출(스타벅스)',
  );

  const bPrivate = bList.items.filter((t) => t.cardId === privateCardId);
  assert(bPrivate.length === 0, 'userB: 타인 private 거래 완전 제외', bPrivate.length);

  const bSummary = bList.items.filter((t) => t.cardId === summaryCardId);
  assert(bSummary.length === 1, 'userB: 타인 summary_only 거래는 목록에 포함(1건)', bSummary.length);
  assert(bSummary[0]?.masked === true, 'userB: summary_only 거래 masked=true', bSummary[0]?.masked);
  assert(bSummary[0]?.merchantRaw === null, 'userB: summary_only 거래 가맹점 마스킹(merchantRaw=null)', bSummary[0]?.merchantRaw);
  assert(Number.isInteger(bSummary[0]?.amount), 'userB: summary_only 거래 금액은 정수로 노출(마스킹은 가맹점만)', bSummary[0]?.amount);

  // ── 8) 월 요약: totalNet = 승인 netAmount 합(취소 반영), 정수 ──────────────
  step(8, '월 요약(GET /v1/transactions/summary): totalNet = 승인 netAmount 합(취소 반영), 정수');
  const sumRes = await req(
    'GET',
    `/transactions/summary?householdId=${householdId}&from=${encodeURIComponent(PERIOD_FROM)}&to=${encodeURIComponent(PERIOD_TO)}`,
    { token: userA.token },
  );
  assert(sumRes.status === 200, 'GET /v1/transactions/summary 200', sumRes.status);
  const summaryJson = sumRes.json;
  assert(!!summaryJson?.period, 'summary.period 반환', summaryJson?.period);
  assert(typeof summaryJson?.period?.timezone === 'string' && summaryJson.period.timezone.length > 0, 'period.timezone 존재');
  assert(Number.isInteger(summaryJson?.totalNet), 'totalNet 정수(KRW)', summaryJson?.totalNet);
  assert(Number.isInteger(summaryJson?.totalApproved), 'totalApproved 정수', summaryJson?.totalApproved);
  assert(Number.isInteger(summaryJson?.totalCancelled), 'totalCancelled 정수', summaryJson?.totalCancelled);
  assert(Number.isInteger(summaryJson?.count) && summaryJson.count >= 1, 'count 양의 정수', summaryJson?.count);
  assert(Array.isArray(summaryJson?.includedMembers), 'includedMembers 배열', summaryJson?.includedMembers);

  // 목록에서 동일 창의 승인 netAmount 를 재계산해 totalNet 과 일치 검증(스펙 §1.2/§8.8).
  const aAll = await listTransactions(userA.token, householdId);
  assert(aAll.status === 200, 'userA 전체 거래 목록 조회 200', aAll.status);
  const fromMs = Date.parse(PERIOD_FROM);
  const toMs = Date.parse(PERIOD_TO);
  const inWindow = (iso) => {
    if (typeof iso !== 'string') return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  };
  const expectedNet = aAll.items
    .filter((t) => t.transactionType === 'approval' && inWindow(t.approvedAt))
    .reduce((acc, t) => acc + t.netAmount, 0);
  assert(
    summaryJson.totalNet === expectedNet,
    'totalNet === 목록 재계산 승인 netAmount 합(취소 반영)',
    { totalNet: summaryJson.totalNet, expectedNet },
  );

  // ── 9) 2차 유사중복 → duplicate_suspected ─────────────────────────────────
  step(9, '2차 중복: 동일 카드/금액/가맹점/시각 유사 다른 eventId 승인 → status=duplicate_suspected');
  await sendSms(device, {
    label: 'duplicate',
    sender: SHINHAN_SENDER,
    content: shinhanApproval({ card: CARD.household, amount: 4300, merchant: '스타벅스', when: OCCUR.duplicate }),
    receivedAt,
  });
  const { txn: dupTxn } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.transactionType === 'approval' && t.amount === 4300 && t.status === 'duplicate_suspected',
  );
  assert(dupTxn !== null, "10초 내 2차 중복 거래 status='duplicate_suspected' 판정");
  assert(dupTxn.cardId === householdCardId, '중복 거래도 카드 자동연결', dupTxn.cardId);
  // 원본 승인(approval2)은 여전히 approved 로 유지되어야 한다.
  const { txn: originalStillApproved } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.id === approval2.id && t.status === 'approved',
  );
  assert(originalStillApproved !== null, '원본 승인(approval2)은 approved 유지');

  // ── 10) 모든 금액 KRW 정수 + netAmount 규약 ───────────────────────────────
  step(10, '모든 거래 금액(amount/cancelledAmount/netAmount) KRW 정수 + netAmount 규약');
  const finalList = await listTransactions(userA.token, householdId);
  assert(finalList.status === 200, '최종 거래 목록 조회 200', finalList.status);
  assert(finalList.items.length >= 6, '거래 건수 확인(승인 3 + 취소 2 + 중복 1 이상)', finalList.items.length);
  for (const t of finalList.items) {
    const tag = `${t.transactionType}/${t.status}/${t.amount}`;
    assert(Number.isInteger(t.amount), `[${tag}] amount 정수`, t.amount);
    assert(Number.isInteger(t.cancelledAmount), `[${tag}] cancelledAmount 정수`, t.cancelledAmount);
    assert(Number.isInteger(t.netAmount), `[${tag}] netAmount 정수`, t.netAmount);
    assert(t.currency === 'KRW', `[${tag}] currency=KRW`, t.currency);
    if (t.transactionType === 'cancellation') {
      assert(t.netAmount === 0, `[${tag}] 취소 레코드 netAmount=0`, t.netAmount);
    } else {
      assert(
        t.netAmount === t.amount - t.cancelledAmount,
        `[${tag}] 승인 netAmount=amount-cancelledAmount`,
        { amount: t.amount, cancelledAmount: t.cancelledAmount, netAmount: t.netAmount },
      );
    }
  }

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
