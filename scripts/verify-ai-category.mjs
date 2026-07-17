#!/usr/bin/env node
// =============================================================================
// verify-ai-category.mjs — LLM 거래 자동 분류(category-suggest) e2e 검증 (mock 기준)
// -----------------------------------------------------------------------------
// 카테고리 분류 우선순위 [사용자 규칙 → 키워드 → LLM 제안 → 미분류] 중 LLM tier 의
// **파이프라인 무해 통과**를 실 스택(AI_PROVIDER=mock) 대상으로 검증한다.
// Node 내장 fetch + node:crypto 만 사용(외부 의존성 없음, verify-phase4 스타일).
//
// 핵심 규약(프로젝트 절대 규약 §1): LLM 호출 실패/JSON 파싱 실패/무효 응답은
// 파이프라인을 절대 중단시키지 않는다. Mock LLM 은 JSON 을 반환하지 않으므로
// category-suggest 프로세서는 항상 "무효 응답 → 조용히 종료(미분류 유지)" 폴백을
// 타며, 이 경로가 실행돼도 수집→파싱→승격→조회→수동분류→규칙 tier 가 전부
// 정상 동작하는 것이 합격 기준이다. (LLM tier 의 실제 분류 결과는 실키에서만
// 검증 가능 — 이 스크립트의 범위 밖.)
//
// 검증 시나리오:
//   1) userA 회원가입 + 가족 생성 + 장치 등록(raw secret 1회).
//   2) 카드 등록(신한, maskedNumber '1234', visibility household).
//   3) 키워드 미매칭 가맹점('수비네공방') 승인 문자 수집 → 10초 내 승격 확인:
//      approval 거래, 카드 연결, categoryId/categorySlug = null(미분류).
//      → 이 승격이 category-suggest 잡(jobId catsug_<hh>_<md5>)을 enqueue 한다.
//   4) category-suggest 잡 무해 통과: 잡 처리 시간을 기다린 뒤
//      - 거래가 여전히 미분류(mock LLM 폴백 — 규칙 미생성)인지,
//      - 거래 필드(netAmount 등)가 손상되지 않았는지,
//      - worker /v1/health/live 가 살아 있는지(잡이 워커를 죽이지 않음),
//      - 거래 목록 API 가 정상(200)인지 확인한다.
//   5) 사용자가 수동으로 카테고리 지정: PATCH /v1/transactions/:id
//      { categoryId: shopping, applyRule: true } → merchant_category_rules 생성
//      (기존 기능) + 거래 categorySlug='shopping'.
//   6) 같은 가맹점 재수집(다른 eventId/금액) → 10초 내 승격 + 규칙 tier 로
//      categorySlug='shopping' 자동 분류(자가학습 루프의 소비측 동작 확인).
//      재승격이 같은 jobId 로 category-suggest 를 재-enqueue 해도(이미 분류됨 →
//      enqueue 안 함 / 규칙 존재 → 프로세서 스킵) 무해해야 한다.
//
// 실행법:
//   1) 전체 스택 기동(진행자가 사전 수행): docker compose up -d --build
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-ai-category.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 \
//      #   WORKER_BASE_URL=http://localhost:3002 node scripts/verify-ai-category.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
//
// 로그에는 원문 전체 / secret / 서명 / 토큰 / 비밀번호를 출력하지 않는다(PRD §11).
// 실패 상세는 비민감 정보(상태코드/카테고리 slug/금액 등)만 남긴다.
// =============================================================================

import { createHmac, randomBytes } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const WORKER_BASE = process.env.WORKER_BASE_URL || 'http://localhost:3002';
const PREFIX = '/v1';

// 재실행 시 이메일/eventId UNIQUE 충돌을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// 비동기 수집→파싱→승격 폴링 상한 + 간격(verify-phase4 와 동일).
const PROMOTE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;
// category-suggest 잡 처리 대기(가맹점 단위 1잡 — mock LLM 은 즉시 폴백하므로 넉넉).
const SUGGEST_WAIT_MS = 4_000;

const TIMEZONE = 'Asia/Seoul';

// 키워드 tier(categorizeByKeyword)와 매칭되지 않는 가맹점 — 미분류로 승격되어
// category-suggest 큐를 타야 한다. 브랜치/애그리게이터 접미사가 없어
// normalizeMerchant 결과도 동일 문자열(규칙 정확 매칭 키 안정)이다.
const UNKNOWN_MERCHANT = '수비네공방';

let passed = 0;
let failed = 0;

// ── 요약/assert/step 유틸(verify-phase4 스타일) ──────────────────────────────
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
    // extra 는 상태코드/slug/금액 등 비민감 정보만 전달한다(원문/secret/서명 금지).
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

// ── 금액/시간 헬퍼(verify-phase4 재사용) ─────────────────────────────────────

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

// 거래 시각은 "현재 기준 과거"로 배치(연도 롤오버 회피). 두 승인은 금액/시각이
// 달라 2차 유사중복(duplicate_suspected) 판정을 피한다.
const NOW_MS = Date.now();
const minsAgo = (m) => new Date(NOW_MS - m * 60_000);
const OCCUR = {
  approval1: minsAgo(60), // 미지정 가맹점 최초 승인(미분류 → LLM 제안 enqueue)
  approval2: minsAgo(30), // 규칙 생성 후 같은 가맹점 재승인(규칙 tier 자동 분류)
};

// ── 카드 문자(파서 포맷과 정확히 일치, packages/card-parsers/BaseCardParser) ──
const CARD_TAIL = '1234';
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

/** worker liveness 확인(category-suggest 잡이 워커를 죽이지 않았는지). */
async function workerAlive() {
  try {
    const res = await fetch(`${WORKER_BASE}${PREFIX}/health/live`);
    return res.ok;
  } catch {
    return false;
  }
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

// ── 장치 HMAC 서명 헬퍼(verify-phase2/3/4 재사용) ────────────────────────────

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

/** 문자 1건 수집(HMAC) 후 200/accepted 확인. eventId 는 실행별 고유(RUN)+라벨. */
async function sendSms(device, { label, sender, content, receivedAt }) {
  const eventId = `evt-${label}-${RUN}`;
  const res = await ingestCardSms(device, { eventId, sender, content, receivedAt });
  assert(res.status === 200, `[${label}] 수집 응답 200`, res.status);
  assert(res.json?.accepted === true, `[${label}] accepted === true`, res.json?.accepted);
  return { eventId, json: res.json };
}

// ── 거래 조회/폴링 헬퍼(verify-phase4 재사용) ────────────────────────────────

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

/** GET /v1/categories 에서 slug → categoryId. */
async function categoryIdBySlug(token, householdId, slug) {
  const res = await req('GET', `/categories?householdId=${householdId}`, { token });
  assert(res.status === 200, 'GET /v1/categories 200', res.status);
  const found = extractList(res.json).find((c) => c?.slug === slug);
  assert(!!found, `카테고리 slug='${slug}' 존재(시스템 시드)`, slug);
  return found.id;
}

// =============================================================================
async function main() {
  console.log(`LLM 자동 분류(category-suggest) 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  console.log('(AI_PROVIDER=mock 기준: LLM 폴백 경로의 무해 통과 + 규칙 tier 자가학습 루프 검증)');
  await waitForApi();
  const receivedAt = new Date(NOW_MS).toISOString();

  // ── 1) userA 회원가입 + 가족 + 장치 등록 ──────────────────────────────────
  step(1, 'userA 회원가입 + 가족 생성 + 장치 등록(raw secret 1회 수신)');
  const userA = await registerUser('ai-cat-owner');
  const createdHh = await req('POST', '/households', {
    token: userA.token,
    body: { name: `AI분류검증 가족 ${RUN}` },
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
  const cardRes = await req('POST', '/cards', {
    token: userA.token,
    body: {
      householdId,
      issuer: '신한카드',
      alias: 'AI분류 검증 카드',
      maskedNumber: CARD_TAIL,
      visibility: 'household',
    },
  });
  assert(cardRes.status >= 200 && cardRes.status < 300, '카드 등록 2xx', cardRes.status);
  const cardId = cardRes.json?.id;
  assert(typeof cardId === 'string' && cardId.length > 0, '카드 id 반환');

  // ── 3) 키워드 미매칭 가맹점 승인 → 미분류 승격(= category-suggest enqueue) ──
  step(3, `키워드 미매칭 가맹점('${UNKNOWN_MERCHANT}') 승인 문자 → 10초 내 미분류(categoryId=null) 승격`);
  await sendSms(device, {
    label: 'unknown-merchant-1',
    sender: SHINHAN_SENDER,
    content: shinhanApproval({
      card: CARD_TAIL,
      amount: 17900,
      merchant: UNKNOWN_MERCHANT,
      when: OCCUR.approval1,
    }),
    receivedAt,
  });
  const { txn: approval1, seen: seen3 } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.transactionType === 'approval' && t.amount === 17900,
  );
  assert(approval1 !== null, '10초 내 승인 거래 승격 완료(GET /v1/transactions)', `관측 ${seen3}건`);
  const approval1Id = approval1.id;
  assert(approval1.cardId === cardId, '카드 자동연결(cardId 일치)', approval1.cardId);
  assert(approval1.status === 'approved', "status='approved'", approval1.status);
  assert(approval1.netAmount === 17900, 'netAmount === 17900', approval1.netAmount);
  assert(
    approval1.categoryId === null || approval1.categoryId === undefined,
    '키워드 미매칭 → categoryId 미분류(null)',
    approval1.categoryId,
  );
  assert(
    approval1.categorySlug === null || approval1.categorySlug === undefined,
    'categorySlug 미분류(null)',
    approval1.categorySlug,
  );

  // ── 4) category-suggest 잡 무해 통과(mock 폴백 = 미분류 유지, 큐/워커 무사) ──
  step(4, `category-suggest 잡 처리 대기(${SUGGEST_WAIT_MS / 1000}s) → mock 폴백: 미분류 유지 + 워커/API 무사`);
  // 승격 직후 promotion 이 category-suggest 잡을 enqueue 했다(가맹점 단위 jobId).
  // category-suggest 잡 처리 대기 후 무해 통과를 확인한다. provider 무관:
  //  - mock LLM: JSON 을 반환하지 않아 "무효 응답 → 조용히 종료" 폴백 → 미분류 유지.
  //  - 실 LLM(gemini): 유효 slug 를 제안하면 거래가 분류될 수 있다.
  // 어느 쪽이든 잡이 워커를 죽이거나 거래 필드를 손상시키지 않아야 한다(핵심 불변식).
  await sleep(SUGGEST_WAIT_MS);

  const after = await req('GET', `/transactions/${approval1Id}`, { token: userA.token });
  assert(after.status === 200, '잡 처리 후 거래 재조회 200', after.status);
  // categoryId 는 null(mock 폴백) 또는 유효 문자열(실 LLM 분류) — 둘 다 정상.
  const cat = after.json?.categoryId;
  assert(
    cat === null || cat === undefined || typeof cat === 'string',
    'category-suggest 무해 통과: 미분류 유지 또는 LLM 분류(둘 다 정상)',
    cat,
  );
  assert(after.json?.netAmount === 17900, '거래 필드 손상 없음(netAmount 유지)', after.json?.netAmount);
  assert(after.json?.status === 'approved', "거래 status='approved' 유지", after.json?.status);

  const alive = await workerAlive();
  assert(alive, `worker(${WORKER_BASE}) liveness OK — category-suggest 잡이 워커를 중단시키지 않음`);

  const listAfter = await listTransactions(userA.token, householdId);
  assert(listAfter.status === 200, '거래 목록 API 정상(200) — 파이프라인 무해 통과', listAfter.status);

  // ── 5) 수동 카테고리 지정 → merchant_category_rules 생성(기존 기능) ────────
  step(5, "수동 분류: PATCH /v1/transactions/:id { categoryId: shopping, applyRule: true } → 규칙 생성");
  const shoppingId = await categoryIdBySlug(userA.token, householdId, 'shopping');
  const patch = await req('PATCH', `/transactions/${approval1Id}`, {
    token: userA.token,
    body: { categoryId: shoppingId, applyRule: true },
  });
  assert(patch.status >= 200 && patch.status < 300, 'PATCH 거래 카테고리 2xx', patch.status);

  const afterPatch = await req('GET', `/transactions/${approval1Id}`, { token: userA.token });
  assert(afterPatch.status === 200, 'PATCH 후 거래 재조회 200', afterPatch.status);
  assert(afterPatch.json?.categoryId === shoppingId, '거래 categoryId=shopping(직접 지정)', afterPatch.json?.categoryId);
  assert(afterPatch.json?.categorySlug === 'shopping', "거래 categorySlug='shopping'", afterPatch.json?.categorySlug);

  // ── 6) 같은 가맹점 재수집 → 규칙 tier 자동 분류(자가학습 루프 소비측) ───────
  step(6, `같은 가맹점('${UNKNOWN_MERCHANT}') 재수집(다른 eventId/금액) → 규칙 tier 로 자동 분류`);
  await sendSms(device, {
    label: 'unknown-merchant-2',
    sender: SHINHAN_SENDER,
    content: shinhanApproval({
      card: CARD_TAIL,
      amount: 8800,
      merchant: UNKNOWN_MERCHANT,
      when: OCCUR.approval2,
    }),
    receivedAt,
  });
  const { txn: approval2, seen: seen6 } = await pollTransactions(
    userA.token,
    householdId,
    (t) => t.transactionType === 'approval' && t.amount === 8800,
  );
  assert(approval2 !== null, '10초 내 재수집 승인 승격 완료', `관측 ${seen6}건`);
  assert(approval2.status === 'approved', "재수집 거래 status='approved'", approval2.status);
  assert(
    approval2.categorySlug === 'shopping',
    "규칙 tier 자동 분류: categorySlug='shopping'(merchant_category_rules 적용)",
    approval2.categorySlug,
  );
  assert(approval2.categoryId === shoppingId, '자동 분류 categoryId=shopping', approval2.categoryId);
  assert(approval2.netAmount === 8800, '재수집 거래 netAmount === 8800', approval2.netAmount);

  // 재승격이 category-suggest 큐(dedupe jobId)와 상호작용해도 최초 거래의 수동
  // 분류가 훼손되지 않아야 한다(프로세서는 규칙 존재 시 스킵, 미분류 거래만 갱신).
  const finalFirst = await req('GET', `/transactions/${approval1Id}`, { token: userA.token });
  assert(finalFirst.status === 200, '최초 거래 재조회 200', finalFirst.status);
  assert(
    finalFirst.json?.categoryId === shoppingId,
    '최초 거래의 수동 분류 유지(categoryId=shopping)',
    finalFirst.json?.categoryId,
  );

  const aliveFinal = await workerAlive();
  assert(aliveFinal, `worker(${WORKER_BASE}) liveness OK(최종) — 전체 파이프라인 무해 통과`);

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅ (mock: LLM 폴백 무해 통과 + 규칙 tier 자가학습 루프 동작)');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). 원문/secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
