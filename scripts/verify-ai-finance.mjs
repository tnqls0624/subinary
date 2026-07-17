#!/usr/bin/env node
// =============================================================================
// verify-ai-finance.mjs — 자연어 가계부 질의 + 월간 인사이트 e2e 검증 (mock 기준)
// -----------------------------------------------------------------------------
// AI_PROVIDER=mock 에서:
//  - POST /v1/ai/finance-query 가 근거(SQL 집계) 기반 답변을 200으로 반환하고,
//    답변 금액이 서버 집계값에서 온다(method='fallback', 실제 합계 문자열 포함).
//  - GET  /v1/ai/monthly-insights 가 200 + 구조(insights 배열, month 에코)를 반환.
//  - 권한: 타 가족 householdId 로 두 엔드포인트 모두 403.
// Node 내장 fetch + node:crypto 만 사용(외부 의존성 없음, verify-ai-category 스타일).
//
// 실행(권장): docker compose exec 로 컨테이너 내부에서 실행하거나, 호스트에서
//   node scripts/verify-ai-finance.mjs
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
  console.log('');
  console.log('────────────────────────────────────────');
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
  if (extra !== undefined) {
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

/** KRW 정수 → 천단위 콤마(카드문자 금액 표기). */
function krw(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 절대 시각 → Asia/Seoul `MM/DD HH:mm`(파서 DATETIME_RE 포맷). */
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

/** 이번 달(YYYY-MM, Asia/Seoul). */
function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}-${m}`;
}

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

/** 회원가입 → { token, userId }. */
async function registerUser(tag) {
  const email = `ai-fin-${tag}-${RUN}@example.com`;
  const res = await req('POST', '/auth/register', {
    body: { email, password: PASSWORD, name: `AiFin ${tag}` },
  });
  assert(res.status === 201 || res.status === 200, `회원가입 200/201 (${tag})`, res.status);
  const token = res.json?.tokens?.accessToken;
  assert(typeof token === 'string' && token.length > 0, `access token 발급 (${tag})`);
  return { token, email };
}

async function createHousehold(token, name) {
  const res = await req('POST', '/households', { token, body: { name } });
  assert(res.status === 201 || res.status === 200, `가족 생성 200/201 (${name})`, res.status);
  const id = res.json?.id;
  assert(typeof id === 'string', `householdId 확보 (${name})`);
  return id;
}

/** 장치 등록 → collectToken(간편 수집). */
async function registerDevice(token, householdId) {
  const res = await req('POST', '/devices/register', {
    token,
    body: { householdId, name: `기기-${RUN}`, platform: 'android' },
  });
  assert(res.status === 201 || res.status === 200, '장치 등록 200/201', res.status);
  const collectToken = res.json?.collectToken;
  assert(typeof collectToken === 'string' && collectToken.length > 0, 'collectToken 1회 노출');
  return collectToken;
}

/** 카드문자(text/plain) 수집. 신한 포맷 — 키워드 tier 로 분류돼 집계에 잡힌다. */
async function ingestCardSms({ collectToken, merchant, amount, at }) {
  const content = [
    `신한카드(1234)승인`,
    `${krw(amount)}원 일시불`,
    `${seoulMMDDHHmm(at)}`,
    merchant,
  ].join('\n');
  const eventId = `fin-${RUN}-${createHash('md5').update(content).digest('hex').slice(0, 10)}`;
  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}/mobile-events/card-sms-text`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${collectToken}`,
        'x-event-id': eventId,
        'x-sender': '15778000',
      },
      body: content,
    });
  } catch (err) {
    assert(false, '카드문자 수집 요청 실패', err?.message);
    return;
  }
  assert(res.status === 200, `카드문자 수집 200 (${merchant})`, res.status);
  return eventId;
}

/** 거래 목록에서 특정 가맹점 승격 완료까지 폴링. */
async function waitForTransaction(token, householdId, merchant) {
  const deadline = Date.now() + PROMOTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await req('GET', `/transactions?householdId=${householdId}&limit=50`, { token });
    const items = res.json?.items ?? [];
    if (items.some((t) => (t.merchantRaw ?? '').includes(merchant))) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function main() {
  console.log('=== verify-ai-finance (mock 기준) ===');
  console.log(`BASE=${BASE} RUN=${RUN}`);

  // health
  step(0, 'API health');
  {
    let ok = false;
    try {
      const r = await fetch(`${BASE}${PREFIX}/health/live`);
      ok = r.ok;
    } catch {
      ok = false;
    }
    assert(ok, 'API /health/live 응답');
  }

  step(1, '사용자/가족/장치 준비 + 거래 시딩(카드문자 수집)');
  const alice = await registerUser('alice');
  const householdId = await createHousehold(alice.token, `가계부-${RUN}`);
  const collectToken = await registerDevice(alice.token, householdId);

  // 서로 다른 금액/시각의 3건(식비 2 + 카페 1 유사). 이번 달로 배치.
  const now = Date.now();
  const minsAgo = (m) => new Date(now - m * 60_000);
  const SEED = [
    { merchant: '김밥천국', amount: 8_500, at: minsAgo(120) },
    { merchant: '스타벅스', amount: 5_600, at: minsAgo(90) },
    { merchant: '이마트', amount: 34_200, at: minsAgo(60) },
  ];
  for (const s of SEED) {
    await ingestCardSms({ collectToken, ...s });
  }
  const total = SEED.reduce((sum, s) => sum + s.amount, 0);

  step(2, '승격 완료 대기(3건 모두 거래로)');
  for (const s of SEED) {
    const ok = await waitForTransaction(alice.token, householdId, s.merchant);
    assert(ok, `거래 승격 확인: ${s.merchant}`);
  }

  const month = currentMonth();

  step(3, 'POST /ai/finance-query — 이번 달 총 지출');
  {
    const res = await req('POST', '/ai/finance-query', {
      token: alice.token,
      body: { householdId, question: '이번 달 총 지출 얼마야?' },
    });
    assert(res.status === 200, 'finance-query 200', res.status);
    assert(typeof res.json?.answer === 'string' && res.json.answer.length > 0, 'answer 문자열 존재');
    // provider 무관: mock='fallback', 실 LLM='llm' — 둘 다 유효.
    assert(['llm', 'fallback'].includes(res.json?.method), "method가 'llm' 또는 'fallback'", res.json?.method);
    // 핵심 불변식: 금액은 LLM이 아닌 서버 SQL 집계에서 온다(data.totalNet = 실제 합계).
    assert(res.json?.data?.totalNet === total, `data.totalNet = 실제 합계(${total})`, res.json?.data?.totalNet);
    // 폴백(mock) 답변은 집계 금액을 직접 포맷하므로 금액 문자열을 포함해야 한다.
    // LLM 답변은 표현이 자유로우므로 이 검사는 fallback 경로에서만 강제한다.
    if (res.json.method === 'fallback') {
      assert(res.json.answer.includes(krw(total)), `답변에 실제 합계 금액(${krw(total)}) 포함`, res.json.answer);
    }
  }

  step(4, 'POST /ai/finance-query — 카테고리(카페) 질의');
  {
    const res = await req('POST', '/ai/finance-query', {
      token: alice.token,
      body: { householdId, question: '이번 달 카페에 얼마 썼어?' },
    });
    assert(res.status === 200, 'finance-query(카페) 200', res.status);
    assert(typeof res.json?.answer === 'string', 'answer 존재');
    // 휴리스틱 폴백이 카테고리를 해석했으면 categorySlug 노출(해석 실패해도 200 답변은 보장).
    assert(res.json?.data?.aggregate !== undefined, 'data.aggregate 존재');
  }

  step(5, 'GET /ai/monthly-insights — 구조 검증');
  {
    const res = await req('GET', `/ai/monthly-insights?householdId=${householdId}&month=${month}`, {
      token: alice.token,
    });
    assert(res.status === 200, 'monthly-insights 200', res.status);
    assert(res.json?.month === month, `month 에코(${month})`, res.json?.month);
    assert(Array.isArray(res.json?.insights), 'insights 배열');
    assert(typeof res.json?.method === 'string', 'method 존재');
    // 각 insight 는 { kind, message } 형태.
    for (const ins of res.json.insights) {
      assert(
        ['trend', 'anomaly', 'budget'].includes(ins.kind) && typeof ins.message === 'string',
        `insight 구조 유효(kind=${ins?.kind})`,
      );
    }
  }

  step(6, '권한 — 타 가족 householdId 로 403');
  {
    const bob = await registerUser('bob');
    const bobHousehold = await createHousehold(bob.token, `밥가계부-${RUN}`);
    // alice 가 bob 의 household 를 조회 시도 → 403(멤버 아님).
    const q = await req('POST', '/ai/finance-query', {
      token: alice.token,
      body: { householdId: bobHousehold, question: '총 지출 얼마야?' },
    });
    assert(q.status === 403, 'finance-query 타 가족 → 403', q.status);
    const m = await req('GET', `/ai/monthly-insights?householdId=${bobHousehold}&month=${month}`, {
      token: alice.token,
    });
    assert(m.status === 403, 'monthly-insights 타 가족 → 403', m.status);
    // 존재하지 않는 household → 403(존재 비공개) 또는 404.
    const ghost = await req('POST', '/ai/finance-query', {
      token: alice.token,
      body: { householdId: randomUUID(), question: '얼마야?' },
    });
    assert(ghost.status === 403 || ghost.status === 404, '없는 household → 403/404', ghost.status);
  }

  summary();
  if (failed === 0) {
    console.log('\n모든 필수 시나리오 통과 ✅');
    process.exit(0);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('예기치 못한 오류:', err?.message ?? err);
  process.exit(1);
});
