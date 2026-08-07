#!/usr/bin/env node
// =============================================================================
// verify-transaction-search.mjs — 거래 검색(q) e2e 검증
// -----------------------------------------------------------------------------
// `GET /v1/transactions?q=` 는 가맹점(원문·정규화)과 메모를 부분 일치로 찾는다.
//
// 이 스크립트가 지키는 계약:
//  1) 가맹점 부분 일치 · 대소문자 무시
//  2) 메모 일치(사용자가 나중에 적은 메모로도 찾을 수 있어야 한다)
//  3) 다른 필터(기간·상태)와 **AND**로 결합
//  4) **타인의 summary_only 거래는 검색 대상에서 제외** ← 프라이버시 경계.
//     응답에서 가맹점이 null로 가려지는 것만으로는 부족하다 — 결과의 **존재 자체**가
//     "그 사람이 거기 갔다"를 알려준다.
//  5) 와일드카드(`%`, `_`)는 리터럴로 취급(전체 매칭으로 새지 않는다)
//  6) 공백만 입력하면 필터가 걸리지 않는다(전체 목록)
//  7) 페이지네이션 커서와 함께 동작
// =============================================================================
import { createHash } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';
const TIMEZONE = 'Asia/Seoul';
const PROMOTE_TIMEOUT_MS = 15_000;
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
  const email = `search-${tag}-${RUN}@example.com`;
  const r = await req('POST', '/auth/register', {
    body: { email, password: PASSWORD, name: `Search ${tag}` },
  });
  assert(r.status === 201 || r.status === 200, `회원가입 (${tag})`, r.status);
  return { token: r.json?.tokens?.accessToken, email };
}
async function createHousehold(token, name) {
  const r = await req('POST', '/households', { token, body: { name } });
  assert(r.status === 201 || r.status === 200, `가족 생성 (${name})`, r.status);
  return r.json?.id;
}
async function registerDevice(token, householdId, name) {
  const r = await req('POST', '/devices/register', {
    token,
    body: { householdId, name, platform: 'android' },
  });
  assert(r.status === 201 || r.status === 200, `장치 등록 (${name})`, r.status);
  return r.json?.collectToken;
}
async function ingest({ collectToken, merchant, amount, at, label }) {
  const content = [
    '신한카드(1234)승인',
    `${krw(amount)}원 일시불`,
    smsStamp(at),
    merchant,
  ].join('\n');
  const eventId = `search-${RUN}-${createHash('md5').update(`${content}|${label}`).digest('hex').slice(0, 12)}`;
  const res = await fetch(`${BASE}${PREFIX}/mobile-events/card-sms-text`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      authorization: `Bearer ${collectToken}`,
      'x-event-id': eventId,
      'x-sender': '15778000',
    },
    body: content,
  });
  assert(res.status === 200, `수집 (${merchant})`, res.status);
}
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
/** 검색 결과의 가맹점 목록(원문 기준). */
async function search(token, householdId, q, extra = '') {
  const r = await req(
    'GET',
    `/transactions?householdId=${householdId}&limit=100&q=${encodeURIComponent(q)}${extra}`,
    { token },
  );
  assert(r.status === 200, `검색 200 (q="${q}")`, r.status);
  return (r.json?.items ?? []);
}

async function main() {
  console.log(`=== verify-transaction-search ===\nBASE=${BASE} RUN=${RUN}`);

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
  step(1, '준비 — 소유자 계정·가족·장치 + 거래 3건');
  const alice = await registerUser('alice');
  const householdId = await createHousehold(alice.token, `검색집-${RUN}`);
  const aliceDevice = await registerDevice(alice.token, householdId, `기기A-${RUN}`);

  const H = { merchant: '튼튼정형외과', amount: 45_000 };
  const C = { merchant: 'Starbucks 강남', amount: 6_300 };
  const G = { merchant: 'GS25 역삼점', amount: 3_200 };
  await ingest({ collectToken: aliceDevice, ...H, at: new Date(now - 180 * 60_000), label: 'h' });
  await ingest({ collectToken: aliceDevice, ...C, at: new Date(now - 120 * 60_000), label: 'c' });
  await ingest({ collectToken: aliceDevice, ...G, at: new Date(now - 60 * 60_000), label: 'g' });

  const txH = await findTxn(alice.token, householdId, H.merchant);
  const txC = await findTxn(alice.token, householdId, C.merchant);
  const txG = await findTxn(alice.token, householdId, G.merchant);
  assert(txH && txC && txG, '세 거래 승격됨');

  step(2, '가맹점 부분 일치');
  {
    const hits = await search(alice.token, householdId, '정형외과');
    assert(hits.length === 1, '부분 일치 1건', hits.map((h) => h.merchantRaw));
    assert(hits[0].id === txH.id, '튼튼정형외과가 매칭', hits[0]?.merchantRaw);
  }

  step(3, '대소문자 무시');
  {
    const lower = await search(alice.token, householdId, 'starbucks');
    assert(lower.some((h) => h.id === txC.id), '소문자로 Starbucks 매칭', lower.map((h) => h.merchantRaw));
    const upper = await search(alice.token, householdId, 'STARBUCKS');
    assert(upper.some((h) => h.id === txC.id), '대문자로도 매칭', upper.map((h) => h.merchantRaw));
  }

  step(4, '메모로도 찾을 수 있다');
  {
    const memo = `건강검진-${RUN}`;
    const r = await req('PATCH', `/transactions/${txG.id}`, {
      token: alice.token,
      body: { memo },
    });
    assert(r.status === 200, '메모 저장 200', r.status);
    const hits = await search(alice.token, householdId, memo);
    assert(hits.length === 1 && hits[0].id === txG.id, '메모로 매칭', hits.map((h) => h.merchantRaw));
  }

  step(5, '다른 필터와 AND 결합');
  {
    // 이번 달 + 검색어 → 매칭, 지난달 + 같은 검색어 → 0건.
    const seoulNow = new Date(now);
    const thisFrom = new Date(seoulNow.getTime() - 24 * 60 * 60_000).toISOString();
    const thisTo = new Date(seoulNow.getTime() + 60 * 60_000).toISOString();
    const inWindow = await search(
      alice.token, householdId, '정형외과',
      `&from=${encodeURIComponent(thisFrom)}&to=${encodeURIComponent(thisTo)}`,
    );
    assert(inWindow.length === 1, '기간 안 + 검색어 → 1건', inWindow.length);

    const oldFrom = new Date(seoulNow.getTime() - 400 * 24 * 60 * 60_000).toISOString();
    const oldTo = new Date(seoulNow.getTime() - 300 * 24 * 60 * 60_000).toISOString();
    const outWindow = await search(
      alice.token, householdId, '정형외과',
      `&from=${encodeURIComponent(oldFrom)}&to=${encodeURIComponent(oldTo)}`,
    );
    assert(outWindow.length === 0, '기간 밖 + 검색어 → 0건(AND)', outWindow.length);
  }

  step(6, '와일드카드는 리터럴 — 전체 매칭으로 새지 않는다');
  {
    const pct = await search(alice.token, householdId, '%');
    assert(pct.length === 0, "q='%' → 0건(전체 목록이 되면 안 된다)", pct.length);
    const underscore = await search(alice.token, householdId, '_');
    assert(underscore.length === 0, "q='_' → 0건", underscore.length);
  }

  step(7, '공백만 입력하면 필터가 걸리지 않는다');
  {
    const all = await req('GET', `/transactions?householdId=${householdId}&limit=100`, { token: alice.token });
    const blank = await search(alice.token, householdId, '   ');
    assert(
      blank.length === (all.json?.items ?? []).length,
      '공백 검색 = 전체 목록',
      { blank: blank.length, all: (all.json?.items ?? []).length },
    );
  }

  step(8, '프라이버시 — 타인의 summary_only 거래는 검색되지 않는다');
  {
    // bob을 가족에 초대해 그의 카드 거래를 summary_only로 만든다.
    const bob = await registerUser('bob');
    const inv = await req('POST', `/households/${householdId}/invitations`, {
      token: alice.token,
      body: { role: 'member' },
    });
    assert(inv.status >= 200 && inv.status < 300, '초대 생성', inv.status);
    const accept = await req('POST', `/household-invitations/${inv.json?.token}/accept`, {
      token: bob.token,
      body: { consent: true },
    });
    assert(accept.status >= 200 && accept.status < 300, 'bob 초대 수락', accept.status);

    const bobDevice = await registerDevice(bob.token, householdId, `기기B-${RUN}`);
    const SECRET = { merchant: '조용한산부인과', amount: 88_000 };
    await ingest({ collectToken: bobDevice, ...SECRET, at: new Date(now - 30 * 60_000), label: 's' });
    const bobTxn = await findTxn(bob.token, householdId, SECRET.merchant);
    assert(bobTxn != null, 'bob 거래 승격됨');

    // bob이 자기 거래를 summary_only로 바꾼다(금액은 공유, 가맹점은 비공개).
    const upd = await req('PATCH', `/transactions/${bobTxn.id}`, {
      token: bob.token,
      body: { visibility: 'summary_only' },
    });
    assert(upd.status === 200, 'summary_only로 변경', upd.status);

    // alice 목록에는 (마스킹된 채로) 보인다 — 금액은 공유되는 것이 설계다.
    const list = await req('GET', `/transactions?householdId=${householdId}&limit=100`, { token: alice.token });
    const maskedRow = (list.json?.items ?? []).find((t) => t.id === bobTxn.id);
    assert(maskedRow != null, 'alice 목록에 행은 존재(금액 공유)');
    assert(maskedRow?.masked === true, 'masked=true', maskedRow?.masked);
    assert(maskedRow?.merchantRaw === null, '가맹점은 가려짐', maskedRow?.merchantRaw);

    // ★ 핵심: 검색으로는 잡히면 안 된다. 잡히면 결과 존재만으로 내용이 새어나간다.
    const leak = await search(alice.token, householdId, '산부인과');
    assert(leak.length === 0, "alice가 '산부인과'로 검색 → 0건(존재 자체가 새면 안 된다)", leak.map((h) => h.id));

    // 본인은 자기 거래를 검색할 수 있어야 한다.
    const own = await search(bob.token, householdId, '산부인과');
    assert(own.length === 1 && own[0].id === bobTxn.id, 'bob 본인은 검색 가능', own.length);
  }

  step(9, '페이지네이션 — 검색 결과에도 커서가 동작한다');
  {
    const first = await req(
      'GET',
      `/transactions?householdId=${householdId}&limit=1&q=${encodeURIComponent('a')}`,
      { token: alice.token },
    );
    assert(first.status === 200, '검색 + limit=1 200', first.status);
    if (first.json?.nextCursor) {
      const second = await req(
        'GET',
        `/transactions?householdId=${householdId}&limit=1&q=${encodeURIComponent('a')}&cursor=${encodeURIComponent(first.json.nextCursor)}`,
        { token: alice.token },
      );
      assert(second.status === 200, '커서 페이지 200', second.status);
      assert(
        (second.json?.items ?? [])[0]?.id !== (first.json?.items ?? [])[0]?.id,
        '다음 페이지가 다른 행을 준다',
      );
    } else {
      assert(true, "커서 없음(매칭 1건 이하) — 페이지네이션 검증 생략");
    }
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
