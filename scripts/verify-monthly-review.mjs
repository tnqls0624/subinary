#!/usr/bin/env node
// =============================================================================
// verify-monthly-review.mjs — 월 단위 회고 + 지출 합계 단일 정의 e2e 검증 (ADR-0026)
// -----------------------------------------------------------------------------
// 이 스크립트가 지키는 계약:
//  1) GET /analytics/months 가 거래 있는 달만 오름차순으로, 그 달 총액과 함께 준다.
//  2) **같은 달의 총액이 세 경로에서 같다** — analytics/monthly · transactions/summary
//     · budgets(household spent). 예전에는 기간 조건이 갈려 서로 다를 수 있었다.
//  3) 승인시각(approvedAt) 미파싱 거래가 세 경로 **모두**에 잡힌다(생성시각 구제).
//     이전에는 analytics만 잡고 예산·요약은 통째로 떨어뜨렸다(과소집계).
//  4) 자산이동(선불 충전·ATM)은 세 경로와 months, 그리고 AI 이상지출에서 빠진다.
//  5) duplicate_suspected(중복 '의심')는 **합계에 포함**된다 — 자동 제외는 오탐 시
//     지출을 숨기므로, 확정은 사용자가 excludedAt으로 한다.
//  6) 권한: 타 가족 householdId로 months 조회 → 403/404.
//
// Node 내장 fetch + node:crypto 만 사용. 로컬/개발 스택에 대고 돌린다.
// =============================================================================
import { createHash, randomUUID } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';
const TIMEZONE = 'Asia/Seoul';
const PROMOTE_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

let passed = 0;
let failed = 0;
let skipped = 0;

function summary() {
  console.log('\n────────────────────────────────────────');
  console.log(`요약: 통과 ${passed} · 실패 ${failed}${skipped ? ` · 건너뜀 ${skipped}` : ''}`);
  console.log('────────────────────────────────────────');
}
function assert(cond, msg, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ FAIL: ${msg}`);
  if (extra !== undefined) {
    console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  summary();
  console.error('\n검증 실패. 위 항목을 확인하세요.');
  process.exit(1);
}
function skip(msg, why) {
  skipped += 1;
  console.log(`  ⚠ SKIP ${msg} — ${why}`);
}
function step(n, t) {
  console.log(`\n[${n}] ${t}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const krw = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* --- 시각/월 유틸 (Asia/Seoul 고정) --------------------------------------- */

function seoulParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour'), mm: g('minute') };
}
/** 카드문자 본문에 쓰는 `MM/DD HH:mm`. */
function smsStamp(date) {
  const p = seoulParts(date);
  return `${p.m}/${p.d} ${p.hh}:${p.mm}`;
}
/** `YYYY-MM` (KST). */
function monthKey(date) {
  const p = seoulParts(date);
  return `${p.y}-${p.m}`;
}
/** `YYYY-MM`에 delta개월 더하기. */
function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const z = y * 12 + (m - 1) + delta;
  return `${Math.floor(z / 12)}-${String((z % 12) + 1).padStart(2, '0')}`;
}
/** `YYYY-MM` → [월초, 다음달초) ISO(+09:00 명시). */
function monthRange(month) {
  const next = addMonths(month, 1);
  return { from: `${month}-01T00:00:00+09:00`, to: `${next}-01T00:00:00+09:00` };
}

/* --- HTTP ----------------------------------------------------------------- */

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
    assert(false, `요청 실패 ${method} ${path}`, err?.message);
    return;
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

async function registerUser(tag) {
  const email = `review-${tag}-${RUN}@example.com`;
  const r = await req('POST', '/auth/register', {
    body: { email, password: PASSWORD, name: `Review ${tag}` },
  });
  assert(r.status === 201 || r.status === 200, `회원가입 (${tag})`, r.status);
  return r.json?.tokens?.accessToken;
}
async function createHousehold(token, name) {
  const r = await req('POST', '/households', { token, body: { name } });
  assert(r.status === 201 || r.status === 200, `가족 생성 (${name})`, r.status);
  return r.json?.id;
}
async function registerDevice(token, householdId) {
  const r = await req('POST', '/devices/register', {
    token,
    body: { householdId, name: `기기-${RUN}`, platform: 'android' },
  });
  assert(r.status === 201 || r.status === 200, '장치 등록', r.status);
  return r.json?.collectToken;
}

/**
 * 카드문자 수집(text/plain 경로). `at`이 없으면 본문에 날짜를 넣지 않아
 * **승인시각 미파싱(approvedAt NULL)** 거래를 만든다.
 * `receivedAt`은 서버가 저장하는 수신 시각으로, 본문 날짜의 연도 추정 기준이 된다.
 */
async function ingest({ collectToken, merchant, amount, at, receivedAt, label }) {
  const lines = [`신한카드(1234)승인`, `${krw(amount)}원 일시불`];
  if (at) lines.push(smsStamp(at));
  lines.push(merchant);
  const content = lines.join('\n');
  // 같은 (가맹점, 금액)을 여러 번 보내는 케이스가 있으므로 eventId에 label을 섞는다.
  const eventId = `review-${RUN}-${createHash('md5')
    .update(`${content}|${label ?? ''}`)
    .digest('hex')
    .slice(0, 12)}`;
  const headers = {
    'content-type': 'text/plain',
    authorization: `Bearer ${collectToken}`,
    'x-event-id': eventId,
    'x-sender': '15778000',
  };
  if (receivedAt) headers['x-received-at'] = receivedAt.toISOString();
  const res = await fetch(`${BASE}${PREFIX}/mobile-events/card-sms-text`, {
    method: 'POST',
    headers,
    body: content,
  });
  assert(res.status === 200, `카드문자 수집 (${merchant} ${krw(amount)}원)`, res.status);
}

/** 가맹점명으로 승격된 거래를 찾는다(승격은 비동기라 폴링). */
async function findTxn(token, householdId, merchant) {
  const deadline = Date.now() + PROMOTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await req('GET', `/transactions?householdId=${householdId}&limit=100`, { token });
    const hit = (r.json?.items ?? []).find((t) => (t.merchantRaw ?? '').includes(merchant));
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

/* --- 세 경로 총액 읽기 ---------------------------------------------------- */

/**
 * 같은 달을 세 경로로 읽는다. ADR-0026의 단일 정의가 지켜지면 세 값이 같다.
 *  - analytics/monthly?month=
 *  - transactions/summary?from&to (월 경계)
 *  - budgets?month= 의 household 스코프 예산 spent
 */
async function threeWayTotals(token, householdId, month, budgetId) {
  const { from, to } = monthRange(month);
  const m = await req('GET', `/analytics/monthly?householdId=${householdId}&month=${month}`, { token });
  assert(m.status === 200, `analytics/monthly 200 (${month})`, m.status);

  const s = await req(
    'GET',
    `/transactions/summary?householdId=${householdId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { token },
  );
  assert(s.status === 200, `transactions/summary 200 (${month})`, s.status);

  const b = await req('GET', `/budgets?householdId=${householdId}&month=${month}`, { token });
  assert(b.status === 200, `budgets 200 (${month})`, b.status);
  const budget = (b.json?.items ?? []).find((x) => x.id === budgetId);

  return {
    analytics: m.json?.totalNet,
    summary: s.json?.totalNet,
    budget: budget?.spent,
    count: m.json?.transactionCount,
  };
}

function assertThreeWay(totals, expected, label) {
  assert(
    totals.analytics === expected &&
      totals.summary === expected &&
      totals.budget === expected,
    `${label} — 3경로 총액이 모두 ${krw(expected)}원`,
    totals,
  );
}

async function monthsList(token, householdId) {
  const r = await req('GET', `/analytics/months?householdId=${householdId}`, { token });
  assert(r.status === 200, 'analytics/months 200', r.status);
  return r.json;
}

/* --- 본문 ----------------------------------------------------------------- */

async function main() {
  console.log(`=== verify-monthly-review (ADR-0026) ===\nBASE=${BASE} RUN=${RUN}`);

  step(0, 'API health');
  {
    let ok = false;
    try {
      ok = (await fetch(`${BASE}${PREFIX}/health/live`)).ok;
    } catch {
      ok = false;
    }
    assert(ok, 'API live');
  }

  const now = new Date();
  const thisMonth = monthKey(now);
  const prevMonth = addMonths(thisMonth, -1);
  // 전월 15일 12:00 KST — 월 경계에서 흔들리지 않는 안전한 중간 지점.
  const prevMonthDate = new Date(`${prevMonth}-15T12:00:00+09:00`);

  step(1, '준비 — 계정·가족·장치·가족 전체 예산');
  const token = await registerUser('a');
  const householdId = await createHousehold(token, `회고집-${RUN}`);
  const collectToken = await registerDevice(token, householdId);
  const budgetId = await (async () => {
    const r = await req('POST', '/budgets', {
      token,
      body: { householdId, scopeType: 'household', amount: 10_000_000 },
    });
    assert(r.status === 201 || r.status === 200, '가족 전체 예산 생성', r.status);
    return r.json?.id;
  })();

  step(2, `거래 수집 — 당월 2건 + 전월 1건(${prevMonth})`);
  const A = { merchant: '김밥천국', amount: 8_500 };
  const B = { merchant: '이마트', amount: 34_200 };
  const P = { merchant: '교촌치킨', amount: 21_000 };
  await ingest({ collectToken, ...A, at: new Date(now.getTime() - 120 * 60_000), label: 'A' });
  await ingest({ collectToken, ...B, at: new Date(now.getTime() - 60 * 60_000), label: 'B' });
  // 전월 거래: 본문 날짜와 수신 시각을 모두 전월로 → approvedAt이 전월이 된다.
  await ingest({
    collectToken,
    ...P,
    at: prevMonthDate,
    receivedAt: new Date(prevMonthDate.getTime() + 60_000),
    label: 'P',
  });

  step(3, '승격 확인');
  const txA = await findTxn(token, householdId, A.merchant);
  const txB = await findTxn(token, householdId, B.merchant);
  const txP = await findTxn(token, householdId, P.merchant);
  assert(txA && txB && txP, '세 거래 모두 승격됨', {
    A: txA?.id, B: txB?.id, P: txP?.id,
  });
  assert(
    txP?.approvedAt != null && monthKeyOf(txP.approvedAt) === prevMonth,
    `전월 거래의 approvedAt이 ${prevMonth}`,
    txP?.approvedAt,
  );

  const thisMonthTotal = A.amount + B.amount;

  step(4, '월 목록 — 거래 있는 달만 오름차순 + 그 달 총액');
  {
    const months = await monthsList(token, householdId);
    assert(months?.timezone === TIMEZONE, `timezone = ${TIMEZONE}`, months?.timezone);
    const keys = (months?.items ?? []).map((i) => i.month);
    assert(
      keys.length === 2 && keys[0] === prevMonth && keys[1] === thisMonth,
      `달 목록 = [${prevMonth}, ${thisMonth}] (오름차순)`,
      keys,
    );
    const byMonth = new Map((months?.items ?? []).map((i) => [i.month, i]));
    assert(byMonth.get(prevMonth)?.net === P.amount, `${prevMonth} net = ${krw(P.amount)}원`, byMonth.get(prevMonth));
    assert(byMonth.get(prevMonth)?.count === 1, `${prevMonth} count = 1`, byMonth.get(prevMonth));
    assert(byMonth.get(thisMonth)?.net === thisMonthTotal, `${thisMonth} net = ${krw(thisMonthTotal)}원`, byMonth.get(thisMonth));
    assert(byMonth.get(thisMonth)?.count === 2, `${thisMonth} count = 2`, byMonth.get(thisMonth));
  }

  step(5, '같은 달 총액이 3경로에서 일치 (당월·전월)');
  {
    const cur = await threeWayTotals(token, householdId, thisMonth, budgetId);
    assertThreeWay(cur, thisMonthTotal, `${thisMonth}`);
    const prev = await threeWayTotals(token, householdId, prevMonth, budgetId);
    assertThreeWay(prev, P.amount, `${prevMonth}`);
  }

  step(6, '승인시각 미파싱(approvedAt NULL) 거래가 3경로 모두에 잡힌다');
  {
    // 본문에 날짜가 없는 문자 → 파서 'timestamp not found' → approvedAt NULL로 승격.
    const C = { merchant: '무날짜상점', amount: 1_234 };
    await ingest({ collectToken, ...C, label: 'C' });
    const txC = await findTxn(token, householdId, C.merchant);
    assert(txC != null, '무날짜 거래 승격됨');
    assert(txC?.approvedAt == null, 'approvedAt이 NULL', txC?.approvedAt);

    const after = await threeWayTotals(token, householdId, thisMonth, budgetId);
    // 이 단정이 이번 변경의 핵심이다. 통일 전에는 analytics만 증가하고
    // summary/budget은 strict approvedAt 비교라 이 거래를 통째로 떨어뜨렸다.
    assertThreeWay(after, thisMonthTotal + C.amount, '무날짜 거래 반영 후');
  }

  step(7, '자산이동(선불 충전)은 3경로·월목록·이상지출에서 빠진다');
  const runningTotal = thisMonthTotal + 1_234;
  {
    // '선불' 키워드 → transfer 카테고리(is_transfer) → 지출 합계에서 제외.
    // 금액을 크게 잡아 이상지출(평균 3배) 후보가 되게 만든다 — 그래도 안 나와야 한다.
    const T = { merchant: '모바일티머니선불', amount: 500_000 };
    await ingest({ collectToken, ...T, at: new Date(now.getTime() - 30 * 60_000), label: 'T' });
    const txT = await findTxn(token, householdId, T.merchant);
    assert(txT != null, '자산이동 거래 승격됨(이력은 남는다)');

    const after = await threeWayTotals(token, householdId, thisMonth, budgetId);
    assertThreeWay(after, runningTotal, '자산이동 주입 후(불변)');

    const months = await monthsList(token, householdId);
    const cur = (months?.items ?? []).find((i) => i.month === thisMonth);
    assert(cur?.net === runningTotal, `월목록 net도 불변 = ${krw(runningTotal)}원`, cur);

    const ins = await req(
      'GET',
      `/ai/monthly-insights?householdId=${householdId}&month=${thisMonth}`,
      { token },
    );
    assert(ins.status === 200, 'monthly-insights 200', ins.status);
    const anomalies = (ins.json?.insights ?? []).filter((i) => i.kind === 'anomaly');
    assert(
      anomalies.every((i) => !i.message.includes('티머니')),
      '이상지출에 자산이동 가맹점이 등장하지 않음',
      anomalies,
    );
  }

  step(8, "중복 '의심'은 합계에 포함된다(자동 제외 금지)");
  {
    // 같은 카드·같은 금액·근접 시각을 다른 eventId로 보내 2차 중복 판정을 유도한다.
    const D = { merchant: '중복상점', amount: 7_700 };
    const at = new Date(now.getTime() - 20 * 60_000);
    await ingest({ collectToken, ...D, at, label: 'D1' });
    await sleep(1_500);
    await ingest({ collectToken, ...D, at, label: 'D2' });
    await sleep(3_000);

    const r = await req('GET', `/transactions?householdId=${householdId}&limit=100`, { token });
    const dups = (r.json?.items ?? []).filter((t) => (t.merchantRaw ?? '').includes(D.merchant));
    const suspected = dups.filter((t) => t.status === 'duplicate_suspected');
    const expected = runningTotal + D.amount * dups.length;
    const after = await threeWayTotals(token, householdId, thisMonth, budgetId);

    if (suspected.length > 0) {
      assertThreeWay(after, expected, `duplicate_suspected ${suspected.length}건 포함`);
    } else {
      skip(
        'duplicate_suspected 생성 확인',
        `승격된 ${dups.length}건이 모두 approved — 중복 판정 조건(카드/시각 근접)에 걸리지 않았다`,
      );
      assertThreeWay(after, expected, '중복 후보 거래가 합계에 포함');
    }
  }

  step(9, '권한 — 타 가족 householdId로 월 목록 조회 → 403/404');
  {
    const otherToken = await registerUser('b');
    const r = await req('GET', `/analytics/months?householdId=${householdId}`, { token: otherToken });
    assert(r.status === 403 || r.status === 404, '타 가족 months → 403/404', r.status);
    const r2 = await req('GET', `/analytics/months?householdId=${randomUUID()}`, { token });
    assert(r2.status === 403 || r2.status === 404, '없는 가족 months → 403/404', r2.status);
    const r3 = await req('GET', '/analytics/months', { token });
    assert(r3.status === 400 || r3.status === 403 || r3.status === 404, 'householdId 누락 → 4xx', r3.status);
  }

  summary();
  if (failed === 0) {
    console.log('\n모든 필수 시나리오 통과 ✅');
    process.exit(0);
  }
  process.exit(1);
}

/** ISO 문자열 → `YYYY-MM` (KST). */
function monthKeyOf(iso) {
  return monthKey(new Date(iso));
}

main().catch((e) => {
  console.error('예기치 못한 오류:', e?.message ?? e);
  process.exit(1);
});
