#!/usr/bin/env node
// =============================================================================
// verify-decline-dismiss.mjs — 결제 실패 묶음 '확인했어요' e2e 검증
// -----------------------------------------------------------------------------
// `resolvedAt`(자동 판정)은 마지막 거절 이후 같은 가맹점 승인이 있을 때만 채워진다.
// 정기결제를 해지한 경우처럼 승인이 영구히 오지 않는 실패는 영원히 미해결로 남아
// 홈 배너가 사라지지 않았다(실측: 버핏서울 106,000원 — 18일째 상단 고정).
//
// 이 스크립트가 지키는 계약:
//  1) 같은 (가맹점, 금액) 거절 2건이 1묶음으로 모이고 unresolvedCount=1
//  2) dismiss → dismissedAt 설정 + unresolvedCount=0 (목록에는 이력으로 남는다)
//  3) undismiss → 원복 (가역적 — excludedAt과 같은 규약)
//  4) **dismiss 이후 새 거절이 오면 다시 노출된다** ← 영구 무시가 아니라는 핵심 계약
//  5) dismiss 멱등(2회 호출해도 행이 쌓이지 않는다)
//  6) 가맹점 미파싱(merchant=null) 묶음도 닫을 수 있다
//  7) 권한: 타 가족 → 403/404
// =============================================================================
import { createHash, randomUUID } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';
const TIMEZONE = 'Asia/Seoul';
const PARSE_TIMEOUT_MS = 15_000;
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
  if (extra !== undefined) {
    console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  summary();
  console.error('\n검증 실패. 위 항목을 확인하세요.');
  process.exit(1);
}
function step(n, t) {
  console.log(`\n[${n}] ${t}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const krw = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function smsStamp(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
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
  const email = `dismiss-${tag}-${RUN}@example.com`;
  const r = await req('POST', '/auth/register', {
    body: { email, password: PASSWORD, name: `Dismiss ${tag}` },
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
 * 승인거절 문자를 수집한다. 전용 파서(신한)가 `승인거절`을 declined로 판정하고,
 * declined는 거래로 승격되지 않아 `card_sms_events`에만 남는다.
 * `merchant`를 생략하면 가맹점을 파싱할 수 없는 거절이 된다(묶음 키의 NULL 케이스).
 */
async function ingestDecline({ collectToken, merchant, amount, at, label }) {
  const content = merchant
    ? `신한카드(1234) 승인거절 ${smsStamp(at)} ${merchant} ${krw(amount)}원 잔액부족`
    : `신한카드(1234) 승인거절 ${krw(amount)}원 잔액부족`;
  const eventId = `dismiss-${RUN}-${createHash('md5')
    .update(`${content}|${label}`)
    .digest('hex')
    .slice(0, 12)}`;
  const res = await fetch(`${BASE}${PREFIX}/mobile-events/card-sms-text`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      authorization: `Bearer ${collectToken}`,
      'x-event-id': eventId,
      'x-sender': '15778000',
      'x-received-at': at.toISOString(),
    },
    body: content,
  });
  assert(res.status === 200, `거절 문자 수집 (${merchant ?? '가맹점없음'} ${krw(amount)}원 · ${label})`, res.status);
}

async function declines(token, householdId) {
  const r = await req('GET', `/card-sms-events/declines?householdId=${householdId}`, { token });
  assert(r.status === 200, 'declines 200', r.status);
  return r.json;
}

/** 묶음이 목록에 나타날 때까지 폴링(파싱은 비동기). */
async function waitForGroup(token, householdId, merchant, minAttempts) {
  const deadline = Date.now() + PARSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const list = await declines(token, householdId);
    const hit = (list?.items ?? []).find((i) =>
      merchant === null ? i.merchant === null : i.merchant === merchant,
    );
    if (hit && hit.attempts >= minAttempts) return { list, hit };
    await sleep(POLL_INTERVAL_MS);
  }
  return { list: null, hit: null };
}

async function main() {
  console.log(`=== verify-decline-dismiss ===\nBASE=${BASE} RUN=${RUN}`);

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

  const now = Date.now();
  step(1, '준비 — 계정·가족·장치');
  const token = await registerUser('a');
  const householdId = await createHousehold(token, `실패집-${RUN}`);
  const collectToken = await registerDevice(token, householdId);

  step(2, '같은 (가맹점, 금액) 거절 2건 → 1묶음');
  const M = '버핏서울';
  const AMOUNT = 106_000;
  await ingestDecline({ collectToken, merchant: M, amount: AMOUNT, at: new Date(now - 48 * 60 * 60_000), label: 'd1' });
  await ingestDecline({ collectToken, merchant: M, amount: AMOUNT, at: new Date(now - 24 * 60 * 60_000), label: 'd2' });
  const { list, hit } = await waitForGroup(token, householdId, M, 2);
  assert(hit != null, '묶음이 목록에 나타남', list);
  assert(hit.attempts === 2, '2번 거절로 묶임', hit?.attempts);
  assert(hit.resolvedAt === null, 'resolvedAt=null (후속 승인 없음)', hit?.resolvedAt);
  assert(hit.dismissedAt === null, 'dismissedAt=null (아직 확인 안 함)', hit?.dismissedAt);
  assert(list.unresolvedCount === 1, 'unresolvedCount=1', list?.unresolvedCount);

  step(3, "dismiss → dismissedAt 설정 + unresolvedCount=0");
  {
    const r = await req('POST', '/card-sms-events/declines/dismiss', {
      token,
      body: { householdId, merchant: M, amount: AMOUNT },
    });
    assert(r.status === 200, 'dismiss 200', r.status);
    assert(r.json?.dismissedAt != null, '응답에 dismissedAt', r.json);

    const after = await declines(token, householdId);
    const g = after.items.find((i) => i.merchant === M);
    assert(g?.dismissedAt != null, '목록에 dismissedAt 노출', g);
    assert(g?.attempts === 2, '이력(시도 횟수)은 보존', g?.attempts);
    assert(after.unresolvedCount === 0, 'unresolvedCount=0 (배너가 닫힌다)', after?.unresolvedCount);
  }

  step(4, 'dismiss 멱등 — 2회 호출해도 상태 동일');
  {
    const r = await req('POST', '/card-sms-events/declines/dismiss', {
      token,
      body: { householdId, merchant: M, amount: AMOUNT },
    });
    assert(r.status === 200, '두 번째 dismiss도 200', r.status);
    const after = await declines(token, householdId);
    assert(after.unresolvedCount === 0, '여전히 unresolvedCount=0', after?.unresolvedCount);
    assert(
      after.items.filter((i) => i.merchant === M).length === 1,
      '묶음이 중복 생성되지 않음(NULLS NOT DISTINCT UNIQUE)',
      after.items.length,
    );
  }

  step(5, 'undismiss → 원복(가역적)');
  {
    const r = await req('POST', '/card-sms-events/declines/undismiss', {
      token,
      body: { householdId, merchant: M, amount: AMOUNT },
    });
    assert(r.status === 200 && r.json?.dismissedAt === null, 'undismiss 200 + dismissedAt=null', r.json);
    const after = await declines(token, householdId);
    const g = after.items.find((i) => i.merchant === M);
    assert(g?.dismissedAt === null, '목록도 원복', g);
    assert(after.unresolvedCount === 1, 'unresolvedCount=1로 복귀', after?.unresolvedCount);
  }

  step(6, '핵심 — dismiss 이후 새 거절이 오면 다시 노출된다');
  {
    await req('POST', '/card-sms-events/declines/dismiss', {
      token,
      body: { householdId, merchant: M, amount: AMOUNT },
    });
    const closed = await declines(token, householdId);
    assert(closed.unresolvedCount === 0, '닫힌 상태 확인', closed?.unresolvedCount);

    // 확인 표시 이후의 새 시도(수신 시각이 dismiss 시점보다 뒤).
    await ingestDecline({ collectToken, merchant: M, amount: AMOUNT, at: new Date(Date.now() + 1_000), label: 'd3' });
    const { hit: reopened } = await waitForGroup(token, householdId, M, 3);
    assert(reopened != null, '새 거절이 묶음에 반영됨', reopened);
    assert(
      reopened.dismissedAt === null,
      '새 거절로 dismissedAt이 해제됨(영구 무시가 아니다)',
      reopened,
    );
    const after = await declines(token, householdId);
    assert(after.unresolvedCount === 1, '배너가 다시 켜진다', after?.unresolvedCount);
  }

  step(7, '가맹점 미파싱(merchant=null) 묶음도 닫을 수 있다');
  {
    const NO_M_AMOUNT = 33_300;
    await ingestDecline({ collectToken, merchant: null, amount: NO_M_AMOUNT, at: new Date(now - 6 * 60 * 60_000), label: 'n1' });
    const { hit: nullGroup } = await waitForGroup(token, householdId, null, 1);
    if (nullGroup == null) {
      // 파서가 가맹점을 뽑아냈다면 이 케이스는 성립하지 않는다 — 조용히 넘기지 않고 알린다.
      assert(false, 'merchant=null 묶음 생성(파서가 가맹점을 만들어내지 않아야 함)');
    }
    const r = await req('POST', '/card-sms-events/declines/dismiss', {
      token,
      body: { householdId, merchant: null, amount: nullGroup.amount },
    });
    assert(r.status === 200, 'merchant=null dismiss 200', r.status);
    const after = await declines(token, householdId);
    const g = after.items.find((i) => i.merchant === null);
    assert(g?.dismissedAt != null, 'NULL 묶음도 dismissedAt 설정됨', g);
  }

  step(8, '권한 — 타 가족 묶음 dismiss 시도 → 403/404');
  {
    const otherToken = await registerUser('b');
    const r = await req('POST', '/card-sms-events/declines/dismiss', {
      token: otherToken,
      body: { householdId, merchant: M, amount: AMOUNT },
    });
    assert(r.status === 403 || r.status === 404, '타 가족 dismiss → 403/404', r.status);
    const r2 = await req('POST', '/card-sms-events/declines/dismiss', {
      token,
      body: { householdId: randomUUID(), merchant: M, amount: AMOUNT },
    });
    assert(r2.status === 403 || r2.status === 404, '없는 가족 dismiss → 403/404', r2.status);
  }

  summary();
  if (failed === 0) {
    console.log('\n모든 필수 시나리오 통과 ✅');
    process.exit(0);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('예기치 못한 오류:', e?.message ?? e);
  process.exit(1);
});
