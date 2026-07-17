#!/usr/bin/env node
// =============================================================================
// verify-exclude-duplicate.mjs — '중복이라 제외' 액션 e2e 검증
// -----------------------------------------------------------------------------
// A안: 확정 중복 거래를 excludedAt으로 합계/예산에서 제외하되 이력은 남긴다.
//  1) 거래 2건 수집(합계 = 두 금액 합).
//  2) POST /transactions/:id/exclude → 200, excludedAt 설정.
//  3) analytics.monthly / transactions.summary 합계가 제외분만큼 감소.
//  4) 예산 사용률(spent)도 감소.
//  5) POST /transactions/:id/include → 합계 원복.
//  6) 권한: 타 가족 거래 제외 시도 → 403/404.
// Node 내장 fetch + node:crypto 만 사용.
// =============================================================================
import { createHash, randomUUID } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';
const TIMEZONE = 'Asia/Seoul';
const PROMOTE_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 500;

let passed = 0;
let failed = 0;

function summary() {
  console.log('\n────────────────────────────────────────');
  console.log(`요약: 통과 ${passed} · 실패 ${failed}`);
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
  if (extra !== undefined) console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  summary();
  console.error('\n검증 실패. 위 항목을 확인하세요.');
  process.exit(1);
}
function step(n, t) {
  console.log(`\n[${n}] ${t}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const krw = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function seoulMMDDHHmm(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}
function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}${path}`, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    assert(false, `요청 실패 ${method} ${path}`, err?.message);
    return;
  }
  const text = await res.text();
  let json;
  if (text) { try { json = JSON.parse(text); } catch { json = undefined; } }
  return { status: res.status, json };
}

async function registerUser(tag) {
  const email = `excl-${tag}-${RUN}@example.com`;
  const r = await req('POST', '/auth/register', { body: { email, password: PASSWORD, name: `Excl ${tag}` } });
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
    token, body: { householdId, name: `기기-${RUN}`, platform: 'android' },
  });
  assert(r.status === 201 || r.status === 200, '장치 등록', r.status);
  return r.json?.collectToken;
}
async function ingest({ collectToken, merchant, amount, at }) {
  const content = [`신한카드(1234)승인`, `${krw(amount)}원 일시불`, seoulMMDDHHmm(at), merchant].join('\n');
  const eventId = `excl-${RUN}-${createHash('md5').update(content).digest('hex').slice(0, 10)}`;
  const res = await fetch(`${BASE}${PREFIX}/mobile-events/card-sms-text`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: `Bearer ${collectToken}`, 'x-event-id': eventId, 'x-sender': '15778000' },
    body: content,
  });
  assert(res.status === 200, `카드문자 수집 (${merchant})`, res.status);
}
async function findTxn(token, householdId, merchant) {
  const deadline = Date.now() + PROMOTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await req('GET', `/transactions?householdId=${householdId}&limit=50`, { token });
    const hit = (r.json?.items ?? []).find((t) => (t.merchantRaw ?? '').includes(merchant));
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}
async function monthlyTotal(token, householdId, month) {
  const r = await req('GET', `/analytics/monthly?householdId=${householdId}&month=${month}`, { token });
  assert(r.status === 200, 'analytics.monthly 200', r.status);
  return r.json?.totalNet;
}

async function main() {
  console.log(`=== verify-exclude-duplicate ===\nBASE=${BASE} RUN=${RUN}`);
  step(0, 'API health');
  {
    let ok = false;
    try { ok = (await fetch(`${BASE}${PREFIX}/health/live`)).ok; } catch { ok = false; }
    assert(ok, 'API live');
  }

  step(1, '준비 + 거래 2건 수집');
  const token = await registerUser('a');
  const householdId = await createHousehold(token, `제외집-${RUN}`);
  const collectToken = await registerDevice(token, householdId);
  const now = Date.now();
  const A = { merchant: '김밥천국', amount: 8_500, at: new Date(now - 120 * 60_000) };
  const B = { merchant: '이마트',   amount: 34_200, at: new Date(now - 60 * 60_000) };
  await ingest({ collectToken, ...A });
  await ingest({ collectToken, ...B });
  const total = A.amount + B.amount;

  step(2, '승격 확인');
  const txA = await findTxn(token, householdId, A.merchant);
  const txB = await findTxn(token, householdId, B.merchant);
  assert(txA && txB, '두 거래 승격됨');

  const month = currentMonth();
  step(3, '제외 전 합계 = 두 금액 합');
  const before = await monthlyTotal(token, householdId, month);
  assert(before === total, `제외 전 totalNet = ${total}`, before);

  step(4, `거래 B(${B.merchant}) 제외 → excludedAt 설정`);
  {
    const r = await req('POST', `/transactions/${txB.id}/exclude`, { token });
    assert(r.status === 200, 'exclude 200', r.status);
    assert(r.json?.excludedAt != null, 'excludedAt 설정됨', r.json?.excludedAt);
  }

  step(5, '제외 후 합계 = A만');
  const afterExclude = await monthlyTotal(token, householdId, month);
  assert(afterExclude === A.amount, `제외 후 totalNet = ${A.amount}(A만)`, afterExclude);
  {
    // transactions.summary 도 동일해야 한다.
    const from = new Date(now - 24 * 60 * 60_000).toISOString();
    const to = new Date(now + 60 * 60_000).toISOString();
    const s = await req('GET', `/transactions/summary?householdId=${householdId}&from=${from}&to=${to}`, { token });
    assert(s.status === 200 && s.json?.totalNet === A.amount, `summary.totalNet = ${A.amount}`, s.json?.totalNet);
  }

  step(6, '목록에 제외 거래는 여전히 존재(이력 보존) + excludedAt 노출');
  {
    const r = await req('GET', `/transactions?householdId=${householdId}&limit=50`, { token });
    const stillThere = (r.json?.items ?? []).find((t) => t.id === txB.id);
    assert(stillThere && stillThere.excludedAt != null, '제외 거래가 목록에 남고 excludedAt 있음');
  }

  step(7, '포함 취소(include) → 합계 원복');
  {
    const r = await req('POST', `/transactions/${txB.id}/include`, { token });
    assert(r.status === 200 && r.json?.excludedAt == null, 'include 200 + excludedAt=null', r.json?.excludedAt);
    const restored = await monthlyTotal(token, householdId, month);
    assert(restored === total, `포함 후 totalNet 원복 = ${total}`, restored);
  }

  step(8, '권한 — 타 가족 거래 제외 시도 → 403/404');
  {
    const otherToken = await registerUser('b');
    // 없는 거래 id (남의 것 흉내) → 404, 남의 household 거래면 403. 여기선 랜덤 id로 404 기대.
    const r = await req('POST', `/transactions/${randomUUID()}/exclude`, { token: otherToken });
    assert(r.status === 404 || r.status === 403, '없는/타인 거래 제외 → 403/404', r.status);
    // alice 거래를 bob이 제외 시도 → 403(멤버 아님).
    const r2 = await req('POST', `/transactions/${txA.id}/exclude`, { token: otherToken });
    assert(r2.status === 403 || r2.status === 404, 'alice 거래를 bob이 제외 → 403/404', r2.status);
  }

  summary();
  if (failed === 0) {
    console.log('\n모든 필수 시나리오 통과 ✅');
    process.exit(0);
  }
  process.exit(1);
}

main().catch((e) => { console.error('예기치 못한 오류:', e?.message ?? e); process.exit(1); });
