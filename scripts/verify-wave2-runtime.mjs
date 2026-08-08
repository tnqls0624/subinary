#!/usr/bin/env node
// =============================================================================
// verify-wave2-runtime.mjs — Wave 2 보안·동시성 수정 7건 런타임 검증
// -----------------------------------------------------------------------------
// 라운드 2에서 고친 항목들은 **DB가 실제로 관여해야** 드러나는 결함이다(행 잠금
// 직렬화, 가드의 멤버십 조인, 부분 유니크 인덱스). 단위 테스트로는 재현되지 않으므로
// 살아있는 스택에 진짜 요청을 보내 확인한다. 동시성은 반드시 `Promise.all`이다 —
// 순차 호출은 이 버그들을 하나도 재현하지 못한다.
//
// 각 항목은 "수정이 없었다면 반드시 실패할" 단언을 갖는다:
//
//  V-1 [P0] `/v1/merchants` 공개범위 (merchant.service.ts)
//      네 번째 집계 API를 추가하며 공개범위 조건이 통째로 누락돼, 타인의 private
//      거래 **가맹점명과 금액**이 그대로 노출됐다. 수정 전이라면 B의 응답에 A의
//      private 이름이 나오고 총액이 11,111원만큼 커진다.
//
//  V-2 [P0] 초대 토큰 동시 수락 (household.service.ts)
//      이메일 미지정 초대를 두 사람이 동시에 수락하면 DB unique가 (household,user)
//      뿐이라 둘 다 커밋됐다. 초대 행 `FOR UPDATE`가 유일한 직렬화 지점이다.
//
//  V-3 [P0] 제거된 구성원의 장치 차단 (device-token.guard / device-hmac.guard)
//      가구에서 제거된 사람의 폰이 계속 카드 문자를 밀어 넣었다. 제거 트랜잭션이
//      장치를 함께 폐기하고, 가드의 멤버십 innerJoin이 최종 방어선이다.
//      → 장치를 SQL로 되살려 **가드만** 때리는 케이스를 따로 둔다(V-3d/V-3e).
//
//  V-4 [P0] 동시 취소 연결 금액 유실 (transaction.service.ts)
//      두 취소가 잠금 전 `cancelledAmount`를 같이 읽어 마지막 update만 남았다.
//      수정 전이라면 3,000+3,000이 3,000으로 뭉개져 순지출이 실제보다 크게 나온다.
//
//  V-5 [P1] Graph supersede 교차 workspace (graph.service.ts)
//      다른 workspace의 entity UUID로 관계를 만들 수 있었고 응답이 그 이름까지
//      돌려줬다. 거부 **순서**도 검증한다 — 기존 관계가 닫히면 안 된다.
//
//  V-6 [P1] 가구 전체 예산 동시 생성 (0048 부분 유니크)
//      household 스코프는 `scope_ref_id`가 NULL이라 3열 UNIQUE로 막히지 않았다.
//
//  V-7 [P1] 장치 secret 동시 회전 (device.service.ts + 0047 부분 유니크)
//      두 회전이 각각 active credential을 남겨, 서버가 고른 쪽과 클라이언트가 받은
//      secret이 달라 401이 났다. **응답의 secret과 collectToken이 함께 유효한가**가
//      이 버그의 실제 증상이다.
//
//  V-8      마이그레이션 0047·0048이 실제로 적용됐고 인덱스가 중복을 **거부**하는가
//
// -----------------------------------------------------------------------------
// ⚠️ 관습에서 벗어난 점: 기존 verify-* 스크립트의 `assert`는 첫 실패에서 즉시
//    프로세스를 끝낸다. 이 스크립트는 **항목 단위로 격리**한다 — 한 항목이 실패해도
//    나머지 6개의 판정을 남겨야 배포 판단에 쓸 수 있기 때문이다. 공용 준비 단계
//    (V-0)만 fail-fast이고, 최종 exit code는 기존과 동일하게 실패 시 1이다.
//
// ⚠️ 이 스크립트는 일회용 격리 스택에서만 실행할 것. psql 대상 컨테이너 이름에
//    `family-memory-ai`가 들어가면 하드 거부한다(운영 오염 방지).
// =============================================================================
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';
const TIMEZONE = 'Asia/Seoul';
/** 워커 승격 폴링(취소 거래는 수집 파이프라인을 통해야만 만들 수 있다). */
const PROMOTE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/**
 * 격리 스택 postgres 컨테이너(`docker compose -p fma-verify`가 만드는 이름).
 * 이 스크립트는 장치를 되살리고 중복 행을 밀어 넣는 파괴적 SQL을 쓴다 —
 * 대상이 잘못되면 치명적이라 운영 프로젝트 이름은 하드 거부한다
 * (verify-auth-hardening.mjs의 같은 가드).
 */
const PG_CONTAINER = process.env.VERIFY_PG_CONTAINER || 'fma-verify-postgres-1';
const PG_USER = process.env.VERIFY_PG_USER || 'family';
const PG_DB = process.env.VERIFY_PG_DB || 'family_memory';

let passed = 0;
let failed = 0;
/** 항목별 판정 — 리포트용. */
const results = [];
let current = null;

/** 항목 격리용 신호. 이걸로 던지면 그 항목만 실패 처리하고 다음으로 넘어간다. */
class ItemFailure extends Error {}

function summary() {
  console.log('\n────────────────────────────────────────');
  console.log(`요약: 통과 ${passed} · 실패 ${failed}`);
  console.log('────────────────────────────────────────');
  for (const r of results) {
    const mark = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⏭️ ' : '❌';
    console.log(`${mark} ${r.id} ${r.title}${r.note ? ` — ${r.note}` : ''}`);
  }
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
    // extra는 상태코드/개수/금액 등 비민감 정보만 전달한다.
    console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  if (current) {
    current.status = 'FAIL';
    current.note = current.note ?? msg;
    throw new ItemFailure(msg);
  }
  // 공용 준비 단계 실패 — 이후 판정이 전부 무의미하므로 즉시 중단한다.
  summary();
  console.error('\n준비 단계 실패. 스택 상태를 먼저 확인하세요.');
  process.exit(1);
}

function step(n, t) {
  console.log(`\n[${n}] ${t}`);
}

async function item(id, title, fn) {
  console.log(`\n═══ ${id} ${title} ${'═'.repeat(Math.max(0, 46 - title.length))}`);
  current = { id, title, status: 'PASS', note: null };
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ItemFailure)) {
      failed += 1;
      current.status = 'FAIL';
      current.note = `예기치 못한 오류: ${error?.message ?? error}`;
      console.error(`  ✗ FAIL: 예기치 못한 오류 — ${error?.message ?? error}`);
    }
  }
  results.push(current);
  current = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const krw = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * 동시 실행 + **겹침 계측**.
 *
 * `Promise.all`을 썼다고 해서 두 요청이 실제로 서버에서 겹쳤다는 보장은 없다 —
 * 클라이언트 커넥션 풀이나 서버 큐가 직렬화하면 경합 창이 열리지 않고, 그러면
 * "수정 전에도 통과하는" 무의미한 테스트가 된다. 각 요청의 시작·종료를 재서
 * `min(end) - max(start) > 0`(둘 다 in-flight였던 구간)을 함께 단언한다.
 */
async function concurrently(thunks) {
  const spans = [];
  const results = await Promise.all(
    thunks.map(async (thunk) => {
      const start = performance.now();
      try {
        return await thunk();
      } finally {
        spans.push({ start, end: performance.now() });
      }
    }),
  );
  const overlapMs = Math.min(...spans.map((s) => s.end)) - Math.max(...spans.map((s) => s.start));
  return { results, overlapMs: Math.round(overlapMs * 100) / 100 };
}

/* -------------------------------------------------------------------------- */
/* SQL — 격리 스택 전용                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 격리 스택 DB에 SQL 한 줄을 실행한다.
 *
 * HTTP만으로는 만들 수 없는 상태(가드만 남기고 장치를 되살리기, graph 시드,
 * 인덱스 중복 주입)를 만들기 위해서다. 운영 컨테이너는 하드 거부한다.
 */
function runSql(sql) {
  if (/family-memory-ai/.test(PG_CONTAINER)) {
    throw new Error(`운영 컨테이너에는 실행할 수 없습니다: ${PG_CONTAINER}`);
  }
  return execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-qtAX', '-v', 'ON_ERROR_STOP=1', '-U', PG_USER, '-d', PG_DB, '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

/** 실패를 기대하는 SQL — 성공하면 null, 실패하면 stderr 문자열을 돌려준다. */
function runSqlExpectError(sql) {
  try {
    runSql(sql);
    return null;
  } catch (error) {
    return String(error?.stderr ?? error?.message ?? error);
  }
}

const sqlNum = (out) => Number.parseInt(out, 10);

/** psql -c에는 바인딩이 없다 — UUID 형식을 강제해 인젝션을 차단한다. */
function sqlUuid(value) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(value))) {
    throw new Error(`UUID 형식이 아닙니다: ${value}`);
  }
  return `'${value}'`;
}
/** 같은 이유로 검증용 이메일 형태를 강제한다. */
function sqlEmail(email) {
  if (!/^[a-z0-9.+_-]+@example\.com$/.test(email)) {
    throw new Error(`검증용 이메일 형식이 아닙니다: ${email}`);
  }
  return `'${email}'`;
}
/** 이 스크립트가 만드는 라벨만 허용(영숫자·하이픈·밑줄) — 해시·인덱스명용. */
function sqlLabel(value) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(value))) {
    throw new Error(`허용되지 않는 라벨: ${value}`);
  }
  return `'${value}'`;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 인증 경로(`/v1/auth/(login|register|change-password)`)는 cf-connecting-ip 버킷
 * 10회/분이다(main.ts). 계정을 여럿 만들므로 등록마다 IP를 갈아 끼워 가짜 429를 막는다.
 */
let ipSeq = 0;
const IP_BASE = (Date.now() % 150) + 20;
const nextAuthHeaders = () => {
  ipSeq += 1;
  return { 'cf-connecting-ip': `198.18.${Math.floor(ipSeq / 200) + 1}.${(IP_BASE + ipSeq) % 250}` };
};

async function req(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return { status: 0, json: undefined, error: error?.message };
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
  return { status: res.status, json, text };
}

/* -------------------------------------------------------------------------- */
/* 도메인 헬퍼                                                                  */
/* -------------------------------------------------------------------------- */

async function registerUser(tag) {
  const email = `w2-${tag}-${RUN}@example.com`;
  const r = await req('POST', '/auth/register', {
    body: { email, password: PASSWORD, name: `W2 ${tag}` },
    headers: nextAuthHeaders(),
  });
  assert(r.status === 201 || r.status === 200, `회원가입 (${tag})`, r.status);
  return { email, token: r.json?.tokens?.accessToken, userId: r.json?.user?.id };
}

async function createHousehold(token, name) {
  const r = await req('POST', '/households', { token, body: { name } });
  assert(r.status === 201 || r.status === 200, `가족 생성 (${name})`, r.status);
  return r.json?.id;
}

/** 이메일 미지정 초대(누구나 수락 가능) — 동시 수락 검증의 전제. */
async function createInvitation(token, householdId, extra = {}) {
  const r = await req('POST', `/households/${householdId}/invitations`, {
    token,
    body: { role: 'member', expiresInHours: 24, ...extra },
  });
  assert(r.status === 201 || r.status === 200, '초대 생성', r.status);
  return { token: r.json?.token, invitationId: r.json?.invitationId };
}

const acceptInvitation = (token, inviteToken) =>
  req('POST', `/household-invitations/${inviteToken}/accept`, {
    token,
    body: { consent: true },
  });

async function memberIdOf(token, householdId, userId) {
  // 이 엔드포인트는 `{items}` 래퍼 없이 배열을 그대로 돌려준다(컨트롤러 반환형 MemberSummary[]).
  const r = await req('GET', `/households/${householdId}/members`, { token });
  assert(r.status === 200, '구성원 목록 조회', r.status);
  const hit = (Array.isArray(r.json) ? r.json : []).find((m) => m.userId === userId);
  assert(hit != null, '대상 구성원이 목록에 있다', { userId });
  return hit.memberId;
}

/** 승인 거래를 동기로 만든다(manual-fields는 approval만 지원). */
async function createApproval(token, householdId, merchant, amount, at = new Date()) {
  const r = await req('POST', '/card-sms/manual-fields', {
    token,
    body: {
      householdId,
      amount,
      currency: 'KRW',
      merchantRaw: merchant,
      occurredAt: at.toISOString(),
      transactionType: 'approval',
    },
  });
  assert(r.status === 201 || r.status === 200, `승인 거래 생성 (${merchant} ${krw(amount)}원)`, {
    status: r.status,
    body: r.json,
  });
  return r.json;
}

const setVisibility = (token, txnId, visibility) =>
  req('PATCH', `/transactions/${txnId}`, { token, body: { visibility } });

async function registerDevice(token, householdId, name) {
  const r = await req('POST', '/devices/register', {
    token,
    body: { householdId, name, platform: 'android' },
  });
  assert(r.status === 201 || r.status === 200, `장치 등록 (${name})`, r.status);
  return r.json;
}

/* --- 장치 인증 두 경로 ------------------------------------------------------ */

/** 수집 토큰(Bearer) 경로. 본문 없는 연결 확인. */
const tokenPing = (collectToken) =>
  fetch(`${BASE}${PREFIX}/mobile-events/ping-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${collectToken}` },
  }).then((r) => r.status);

/**
 * HMAC 경로. `X-Signature = HMAC-SHA256(secret, "${ts}.${nonce}.${rawBody}")`,
 * ts는 epoch 초. nonce는 (device, nonce) 유니크라 요청마다 새로 만든다.
 * content-type이 json이면 Fastify가 빈 본문에 400을 내므로 `{}`를 명시한다.
 */
function hmacPing(deviceId, secret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const body = '{}';
  const signature = createHmac('sha256', secret)
    .update(`${ts}.${nonce}.${body}`, 'utf8')
    .digest('hex');
  return fetch(`${BASE}${PREFIX}/mobile-events/ping`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-id': deviceId,
      'x-timestamp': ts,
      'x-nonce': nonce,
      'x-signature': signature,
    },
    body,
  }).then((r) => r.status);
}

/* --- 카드 문자 수집(취소 거래 생성용) --------------------------------------- */

function smsStamp(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}

/**
 * 카드 문자를 수집 파이프라인에 태운다. 취소 거래는 manual-fields가 지원하지 않아
 * 이 경로가 유일하다.
 *
 * ⚠️ 워커는 (가맹점 정규화명 + 카드 + 유일 매칭)일 때 취소를 자동 연결한다
 * (transaction-promotion.service.ts). V-4는 **수동 연결**을 검증하므로 취소의
 * 가맹점명을 승인과 다르게 지어 자동 연결 후보를 0개로 만든다.
 */
async function ingestSms(collectToken, content, label) {
  const eventId = `w2-${RUN}-${createHash('sha256').update(`${content}|${label}`).digest('hex').slice(0, 16)}`;
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
  return res.status;
}

const cancellationSms = (merchant, amount, at) =>
  ['현대카드 승인취소', `${krw(amount)}원 일시불`, smsStamp(at), merchant].join('\n');

/** 승격된 거래를 가맹점 원문으로 찾는다(워커 비동기). */
async function waitForTxn(token, householdId, merchant) {
  const deadline = Date.now() + PROMOTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await req('GET', `/transactions?householdId=${householdId}&limit=100`, { token });
    const hit = (r.json?.items ?? []).find((t) => (t.merchantRaw ?? '') === merchant);
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

/** 승인 행의 현재 금액 상태를 DB에서 직접 읽는다(응답만 믿지 않는다). */
function txnAmountsFromDb(id) {
  const out = runSql(
    `SELECT amount||'|'||cancelled_amount||'|'||net_amount||'|'||status
       FROM card_transactions WHERE id = ${sqlUuid(id)}`,
  );
  const [amount, cancelled, net, status] = out.split('|');
  return {
    amount: Number(amount),
    cancelledAmount: Number(cancelled),
    netAmount: Number(net),
    status,
  };
}

/* ========================================================================== */
/* 검증 본문                                                                    */
/* ========================================================================== */

async function main() {
  console.log(`=== verify-wave2-runtime ===\nBASE=${BASE} PG=${PG_CONTAINER} RUN=${RUN}`);

  /* --- V-0 공용 준비 (fail-fast) ------------------------------------------ */
  step(0, '스택 상태 + 공용 가구(A/B) 준비');
  {
    let live = false;
    try {
      live = (await fetch(`${BASE}${PREFIX}/health/live`)).ok;
    } catch {
      live = false;
    }
    assert(live, 'API live');
    assert(runSql('SELECT 1') === '1', `psql 접속 (${PG_CONTAINER})`);
  }

  const userA = await registerUser('a');
  const userB = await registerUser('b');
  const householdA = await createHousehold(userA.token, `W2 가구 ${RUN}`);
  {
    const invite = await createInvitation(userA.token, householdA);
    const joined = await acceptInvitation(userB.token, invite.token);
    assert(joined.status === 200 || joined.status === 201, 'B가 가구 A에 합류', joined.status);
  }
  const memberA = await memberIdOf(userA.token, householdA, userA.userId);
  const memberB = await memberIdOf(userA.token, householdA, userB.userId);
  console.log(`  · householdA=${householdA} memberA=${memberA} memberB=${memberB}`);

  /* --- V-1 -------------------------------------------------------------- */
  await item('V-1', '가맹점 API가 타인의 private 거래를 감추는가', async () => {
    const PRIVATE_AMOUNT = 11_111;
    const SUMMARY_AMOUNT = 22_222;
    const HOUSEHOLD_AMOUNT = 33_333;
    const names = {
      priv: `W2PRIV${RUN.toUpperCase().replace(/-/g, '')}`,
      summ: `W2SUMM${RUN.toUpperCase().replace(/-/g, '')}`,
      hh: `W2HH${RUN.toUpperCase().replace(/-/g, '')}`,
    };

    step(1.1, '준비 — A가 공개범위 3종 거래를 만든다');
    const priv = await createApproval(userA.token, householdA, names.priv, PRIVATE_AMOUNT);
    const summ = await createApproval(userA.token, householdA, names.summ, SUMMARY_AMOUNT);
    const hh = await createApproval(userA.token, householdA, names.hh, HOUSEHOLD_AMOUNT);
    // 정규화 결과를 기대키로 쓴다(normalizeMerchant가 이름을 바꿔도 검증이 흔들리지 않게).
    const key = { priv: priv.merchantNormalized, summ: summ.merchantNormalized, hh: hh.merchantNormalized };
    for (const [id, visibility] of [[priv.id, 'private'], [summ.id, 'summary_only'], [hh.id, 'household']]) {
      const r = await setVisibility(userA.token, id, visibility);
      assert(r.status === 200, `공개범위 지정 → ${visibility}`, r.status);
    }

    step(1.2, '대조군 — A 본인 시점에서는 3건 모두 보인다');
    const asA = await req('GET', `/merchants?householdId=${householdA}`, { token: userA.token });
    assert(asA.status === 200, 'A: GET /v1/merchants 200', asA.status);
    const aItems = new Map((asA.json?.items ?? []).map((m) => [m.name, m]));
    assert(aItems.get(key.priv)?.netTotal === PRIVATE_AMOUNT, `A: 본인 private 보임 (${krw(PRIVATE_AMOUNT)}원)`, aItems.get(key.priv));
    assert(aItems.get(key.summ)?.netTotal === SUMMARY_AMOUNT, `A: 본인 summary_only 보임 (${krw(SUMMARY_AMOUNT)}원)`, aItems.get(key.summ));
    assert(aItems.get(key.hh)?.netTotal === HOUSEHOLD_AMOUNT, `A: household 보임 (${krw(HOUSEHOLD_AMOUNT)}원)`, aItems.get(key.hh));

    step(1.3, '핵심 — B 시점에서 A의 private은 이름도 금액도 없다');
    const asB = await req('GET', `/merchants?householdId=${householdA}`, { token: userB.token });
    assert(asB.status === 200, 'B: GET /v1/merchants 200', asB.status);
    const bItems = asB.json?.items ?? [];
    const bNames = bItems.map((m) => m.name);
    assert(!bNames.includes(key.priv), 'B: A의 private 가맹점명이 응답에 없다', bNames);
    assert(!bNames.includes(key.summ), 'B: A의 summary_only 원래 이름이 응답에 없다', bNames);

    const redacted = bItems.find((m) => m.name === '(비공개)');
    assert(redacted != null, "B: '(비공개)' 버킷이 존재한다(analytics와 같은 라벨)", bNames);
    assert(
      redacted.netTotal === SUMMARY_AMOUNT,
      `B: summary_only 금액은 유지된다 (${krw(SUMMARY_AMOUNT)}원)`,
      redacted,
    );

    const hhRow = bItems.find((m) => m.name === key.hh);
    assert(hhRow?.netTotal === HOUSEHOLD_AMOUNT, `B: household 건은 정상 표시 (${krw(HOUSEHOLD_AMOUNT)}원)`, hhRow);

    step(1.4, '금액 유출 — 이름만 가리고 합산하면 여전히 유출이다');
    const bTotal = bItems.reduce((sum, m) => sum + m.netTotal, 0);
    assert(
      bTotal === SUMMARY_AMOUNT + HOUSEHOLD_AMOUNT,
      `B 응답 총액 = ${krw(SUMMARY_AMOUNT + HOUSEHOLD_AMOUNT)}원 (private ${krw(PRIVATE_AMOUNT)}원 미포함)`,
      { bTotal, items: bItems.map((m) => `${m.name}:${m.netTotal}`) },
    );
  });

  /* --- V-2 -------------------------------------------------------------- */
  await item('V-2', '초대 토큰 하나로 두 사용자가 가입되지 않는가', async () => {
    step(2.1, '준비 — 별도 가구 + 이메일 미지정 초대');
    const owner = await registerUser('inv-owner');
    const hh = await createHousehold(owner.token, `W2 초대 ${RUN}`);
    const raceA = await registerUser('inv-1');
    const raceB = await registerUser('inv-2');
    const invite = await createInvitation(owner.token, hh);
    assert(typeof invite.token === 'string' && invite.token.length > 0, '원시 초대 토큰 수신');

    step(2.2, '핵심 — 서로 다른 두 계정이 동시에 수락');
    const { results: [r1, r2], overlapMs } = await concurrently([
      () => acceptInvitation(raceA.token, invite.token),
      () => acceptInvitation(raceB.token, invite.token),
    ]);
    assert(overlapMs > 0, `두 수락 요청이 실제로 겹쳤다 (${overlapMs}ms)`, { overlapMs });
    const oks = [r1, r2].filter((r) => r.status === 200 || r.status === 201);
    const rejected = [r1, r2].filter((r) => r.status >= 400 && r.status < 500);
    assert(oks.length === 1, '정확히 1건만 성공', { r1: r1.status, r2: r2.status });
    assert(rejected.length === 1, '나머지 1건은 4xx', { r1: r1.status, r2: r2.status });

    step(2.3, 'DB로 확인 — 응답만 믿지 않는다');
    const active = sqlNum(
      runSql(`SELECT count(*) FROM household_members WHERE household_id = ${sqlUuid(hh)} AND status = 'active'`),
    );
    assert(active === 2, '활성 구성원 = 2명(생성자 + 승자 1명)', { active });
    const accepted = sqlNum(
      runSql(`SELECT count(*) FROM household_invitations WHERE household_id = ${sqlUuid(hh)} AND status = 'accepted'`),
    );
    assert(accepted === 1, '초대 1건이 accepted로 소모됨', { accepted });

    step(2.4, '회귀 — 이미 활성인 멤버가 새 pending 초대를 수락하면 멱등 성공');
    // 초대가 accepted가 되면 본인이라도 409다(상태 검사가 멤버십 검사보다 앞선다).
    // 멱등 경로는 "pending 초대 + 이미 active인 멤버" 조합에서만 도달한다.
    const winnerToken = (r1.status < 400 ? raceA : raceB).token;
    const invite2 = await createInvitation(owner.token, hh);
    const again = await acceptInvitation(winnerToken, invite2.token);
    assert(again.status === 200 || again.status === 201, '기존 멤버 재수락 → 성공(멱등)', again.status);
    const activeAfter = sqlNum(
      runSql(`SELECT count(*) FROM household_members WHERE household_id = ${sqlUuid(hh)} AND status = 'active'`),
    );
    assert(activeAfter === 2, '멱등 수락 후에도 활성 구성원 2명(중복 행 없음)', { activeAfter });

    step(2.5, '회귀 — 에러 의미론(revoked→410, accepted→409)');
    const revokeInvite = await createInvitation(owner.token, hh);
    const revoked = await req('DELETE', `/households/${hh}/invitations/${revokeInvite.invitationId}`, {
      token: owner.token,
    });
    assert(revoked.status === 200 || revoked.status === 204, '초대 폐기', revoked.status);
    const outsider = await registerUser('inv-3');
    const onRevoked = await acceptInvitation(outsider.token, revokeInvite.token);
    assert(onRevoked.status === 410, 'revoked 초대 → 410', onRevoked.status);
    const onAccepted = await acceptInvitation(outsider.token, invite.token);
    assert(onAccepted.status === 409, 'accepted 초대 → 409', onAccepted.status);
  });

  /* --- V-3 -------------------------------------------------------------- */
  await item('V-3', '탈퇴·제거된 구성원의 장치가 수집을 못 하는가', async () => {
    step(3.1, '준비 — 별도 가구에 구성원 X와 그 장치');
    const owner = await registerUser('dev-owner');
    const hh = await createHousehold(owner.token, `W2 장치 ${RUN}`);
    const guest = await registerUser('dev-guest');
    const invite = await createInvitation(owner.token, hh);
    const joined = await acceptInvitation(guest.token, invite.token);
    assert(joined.status === 200 || joined.status === 201, 'X가 가구에 합류', joined.status);
    const guestMemberId = await memberIdOf(owner.token, hh, guest.userId);
    const device = await registerDevice(guest.token, hh, `X의 폰 ${RUN}`);
    const collectToken = device.collectToken;
    const secret = device.secret;
    const deviceId = device.deviceId;

    step(3.2, '대조군 — 활성 구성원의 장치는 두 경로 모두 성공');
    assert((await tokenPing(collectToken)) === 200, '대조군: collect token ping 200');
    assert((await hmacPing(deviceId, secret)) === 200, '대조군: HMAC ping 200');
    const smsAt = new Date();
    const okSms = await ingestSms(
      collectToken,
      ['신한카드(1234)승인', '5,000원 일시불', smsStamp(smsAt), `W2DEVOK${RUN.replace(/-/g, '')}`].join('\n'),
      'v3-control',
    );
    assert(okSms === 200, '대조군: 카드 문자 수집 200', okSms);

    step(3.3, '핵심 — 구성원 제거 후 같은 토큰/secret으로 재시도');
    const removed = await req('DELETE', `/households/${hh}/members/${guestMemberId}`, { token: owner.token });
    assert(removed.status === 200 || removed.status === 204, '구성원 제거', removed.status);

    const afterSms = await ingestSms(
      collectToken,
      ['신한카드(1234)승인', '6,000원 일시불', smsStamp(new Date()), `W2DEVNG${RUN.replace(/-/g, '')}`].join('\n'),
      'v3-after',
    );
    assert(afterSms === 401, '제거 후 카드 문자 수집 → 401', afterSms);
    assert((await tokenPing(collectToken)) === 401, '제거 후 collect token ping → 401');
    assert((await hmacPing(deviceId, secret)) === 401, '제거 후 HMAC ping → 401');

    step(3.4, 'DB — 제거 트랜잭션이 장치·자격증명을 함께 폐기했다');
    const deviceRow = runSql(
      `SELECT status||'|'||coalesce(collect_token_hash,'NULL') FROM registered_devices WHERE id = ${sqlUuid(deviceId)}`,
    );
    const [devStatus, devHash] = deviceRow.split('|');
    assert(devStatus === 'revoked', "registered_devices.status = 'revoked'", devStatus);
    assert(devHash === 'NULL', 'collect_token_hash = NULL(유출된 Bearer 토큰 무효화)', devHash);
    const activeCreds = sqlNum(
      runSql(`SELECT count(*) FROM device_credentials WHERE device_id = ${sqlUuid(deviceId)} AND status = 'active'`),
    );
    assert(activeCreds === 0, 'active device_credentials = 0', { activeCreds });

    step(3.5, '가드 단독 — 장치를 되살려도(멤버십은 removed) 가드가 막는다');
    // 위 3.3은 제거 트랜잭션이 장치를 죽여서 통과할 수도 있다. 가드의 멤버십 조인
    // 자체를 때리려면 "장치는 active인데 소유 구성원은 removed"인 상태가 필요하다 —
    // 0047 이전에 만들어진 장치나 다른 경로로 생긴 누락이 정확히 이 모양이다.
    const restoreHash = createHash('sha256').update(collectToken, 'utf8').digest('hex');
    runSql(
      `UPDATE registered_devices SET status = 'active', revoked_at = NULL,
         collect_token_hash = ${sqlLabel(restoreHash)}
       WHERE id = ${sqlUuid(deviceId)}`,
    );
    runSql(
      `UPDATE device_credentials SET status = 'active', revoked_at = NULL
       WHERE device_id = ${sqlUuid(deviceId)}
         AND id = (SELECT id FROM device_credentials WHERE device_id = ${sqlUuid(deviceId)}
                   ORDER BY created_at DESC LIMIT 1)`,
    );
    const revived = runSql(
      `SELECT status FROM registered_devices WHERE id = ${sqlUuid(deviceId)}`,
    );
    assert(revived === 'active', '장치를 active로 되살림(멤버십은 removed 유지)', revived);
    const memberStatus = runSql(
      `SELECT status FROM household_members WHERE id = ${sqlUuid(guestMemberId)}`,
    );
    assert(memberStatus === 'removed', '구성원은 여전히 removed', memberStatus);

    assert(
      (await tokenPing(collectToken)) === 401,
      '핵심: 되살린 장치도 collect token 경로 401 (device-token.guard 멤버십 조인)',
    );
    assert(
      (await hmacPing(deviceId, secret)) === 401,
      '핵심: 되살린 장치도 HMAC 경로 401 (device-hmac.guard 멤버십 조인)',
    );
    const revivedSms = await ingestSms(
      collectToken,
      ['신한카드(1234)승인', '7,000원 일시불', smsStamp(new Date()), `W2DEVRV${RUN.replace(/-/g, '')}`].join('\n'),
      'v3-revived',
    );
    assert(revivedSms === 401, '핵심: 되살린 장치의 카드 문자 수집도 401', revivedSms);
  });

  /* --- V-4 -------------------------------------------------------------- */
  await item('V-4', '동시 취소 연결이 금액을 유실하지 않는가', async () => {
    step(4.1, '준비 — 취소 거래 생성용 장치(수집 파이프라인 경유)');
    const device = await registerDevice(userA.token, householdA, `W2 취소기 ${RUN}`);
    const tag = RUN.replace(/-/g, '').toUpperCase();
    /** 취소 문자를 태우고 승격된 **미연결** 취소 거래를 돌려준다. */
    const makeCancellation = async (label, amount) => {
      const merchant = `W2CXL${label}${tag}`;
      const status = await ingestSms(
        device.collectToken,
        cancellationSms(merchant, amount, new Date()),
        `v4-${label}`,
      );
      assert(status === 200, `취소 문자 수집 (${label})`, status);
      const txn = await waitForTxn(userA.token, householdA, merchant);
      assert(txn != null, `취소 거래 승격 대기 (${label})`, { merchant });
      assert(txn.transactionType === 'cancellation', `승격 결과가 cancellation (${label})`, txn.transactionType);
      assert(
        txn.parentTransactionId === null,
        `자동 연결되지 않았다 — 수동 연결 검증의 전제 (${label})`,
        txn.parentTransactionId,
      );
      assert(txn.amount === amount, `취소 금액 ${krw(amount)}원 (${label})`, txn.amount);
      return txn;
    };

    step(4.2, '대조군 — 순차 연결 1건은 정확히 반영된다');
    {
      const approval = await createApproval(userA.token, householdA, `W2APRCTL${tag}`, 10_000);
      const cancel = await makeCancellation('CTL', 3_000);
      const r = await req('POST', `/transactions/${cancel.id}/link-cancellation`, {
        token: userA.token,
        body: { approvalTransactionId: approval.id },
      });
      assert(r.status === 200, '대조군: 연결 200', { status: r.status, body: r.json });
      const db = txnAmountsFromDb(approval.id);
      assert(db.cancelledAmount === 3_000 && db.netAmount === 7_000, '대조군: 3,000 / 7,000', db);
      assert(db.status === 'partially_cancelled', "대조군: status = 'partially_cancelled'", db.status);
    }

    step(4.3, '핵심 — 취소 3,000원 2건을 동시에 연결 (3회 반복)');
    // 유실 갱신은 확률적이다. 수정 전 코드가 한 번쯤 운좋게 맞을 수는 있어도
    // 3라운드 연속으로 맞을 수는 없다 — 반복이 곧 이 테스트의 검출력이다.
    const ROUNDS = 3;
    const linkedRounds = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const approval = await createApproval(userA.token, householdA, `W2APRRACE${round}${tag}`, 10_000);
      const c1 = await makeCancellation(`R${round}A`, 3_000);
      const c2 = await makeCancellation(`R${round}B`, 3_000);
      const { results: [l1, l2], overlapMs } = await concurrently([
        () => req('POST', `/transactions/${c1.id}/link-cancellation`, {
          token: userA.token, body: { approvalTransactionId: approval.id },
        }),
        () => req('POST', `/transactions/${c2.id}/link-cancellation`, {
          token: userA.token, body: { approvalTransactionId: approval.id },
        }),
      ]);
      assert(overlapMs > 0, `[R${round}] 두 연결 요청이 실제로 겹쳤다 (${overlapMs}ms)`, { overlapMs });
      assert(l1.status === 200 && l2.status === 200, `[R${round}] 두 연결 모두 200(잔액 충분)`, {
        l1: l1.status, l2: l2.status,
      });
      const raced = txnAmountsFromDb(approval.id);
      assert(raced.cancelledAmount === 6_000, `[R${round}] cancelled_amount = 6,000 (수정 전이라면 3,000)`, raced);
      assert(raced.netAmount === 4_000, `[R${round}] net_amount = 4,000 (수정 전이라면 7,000)`, raced);
      linkedRounds.push({ approvalId: approval.id, c1, c2 });
    }

    step(4.4, '삭제 역산 — 연결된 취소 2건을 동시에 삭제');
    {
      const { approvalId, c1, c2 } = linkedRounds[0];
      const { results: [d1, d2], overlapMs } = await concurrently([
        () => req('DELETE', `/transactions/${c1.id}`, { token: userA.token }),
        () => req('DELETE', `/transactions/${c2.id}`, { token: userA.token }),
      ]);
      assert(overlapMs > 0, `두 삭제 요청이 실제로 겹쳤다 (${overlapMs}ms)`, { overlapMs });
      assert(d1.status === 200 && d2.status === 200, '두 삭제 모두 200', { d1: d1.status, d2: d2.status });
      const restored = txnAmountsFromDb(approvalId);
      assert(restored.cancelledAmount === 0, 'cancelled_amount = 0으로 정확히 복원', restored);
      assert(restored.netAmount === 10_000, 'net_amount = 10,000으로 복원', restored);
    }

    step(4.5, '잔액 초과 — 6,000원 취소 2건 동시 연결은 한 건만 통과');
    const approval2 = await createApproval(userA.token, householdA, `W2APROVER${tag}`, 10_000);
    const o1 = await makeCancellation('O1', 6_000);
    const o2 = await makeCancellation('O2', 6_000);
    const { results: [x1, x2], overlapMs: overCross } = await concurrently([
      () => req('POST', `/transactions/${o1.id}/link-cancellation`, {
        token: userA.token, body: { approvalTransactionId: approval2.id },
      }),
      () => req('POST', `/transactions/${o2.id}/link-cancellation`, {
        token: userA.token, body: { approvalTransactionId: approval2.id },
      }),
    ]);
    assert(overCross > 0, `두 연결 요청이 실제로 겹쳤다 (${overCross}ms)`, { overCross });
    const okCount = [x1, x2].filter((r) => r.status === 200).length;
    const rejectedCount = [x1, x2].filter((r) => r.status >= 400 && r.status < 500).length;
    assert(okCount === 1, '정확히 1건만 성공', { x1: x1.status, x2: x2.status });
    assert(rejectedCount === 1, '나머지 1건은 4xx(잔액 초과 거부)', { x1: x1.status, x2: x2.status });
    const over = txnAmountsFromDb(approval2.id);
    assert(over.cancelledAmount === 6_000, 'cancelled_amount = 6,000 (12,000이 아니다)', over);
    assert(over.netAmount === 4_000, 'net_amount = 4,000 (음수 잔액 없음)', over);
  });

  /* --- V-5 -------------------------------------------------------------- */
  await item('V-5', 'Graph supersede가 교차 workspace를 거부하는가', async () => {
    step(5.1, '준비 — workspace 2개를 SQL로 시드(생성 API가 없다)');
    // 엔티티/관계는 규칙 기반 추출 파이프라인으로만 생기고 직접 생성 API가 없다.
    // supersede 경계 검증에 필요한 최소 구조만 직접 넣는다.
    const w1 = randomUUID();
    const w2 = randomUUID();
    const e1 = randomUUID();
    const e2 = randomUUID();
    const x1 = randomUUID();
    const r1 = randomUUID();
    const r2 = randomUUID();
    const ownerId = runSql(`SELECT id FROM users WHERE email = ${sqlEmail(userA.email)}`);
    assert(/^[0-9a-f-]{36}$/.test(ownerId), 'A의 user id 조회', ownerId);

    runSql(`INSERT INTO workspaces (id, owner_user_id, kind, name) VALUES
      (${sqlUuid(w1)}, ${sqlUuid(ownerId)}, 'personal', 'w2-ws1-${RUN}'),
      (${sqlUuid(w2)}, ${sqlUuid(ownerId)}, 'personal', 'w2-ws2-${RUN}')`);
    runSql(`INSERT INTO entities (id, workspace_id, type, name, canonical_name) VALUES
      (${sqlUuid(e1)}, ${sqlUuid(w1)}, 'person', 'w2-e1', 'w2-e1-${RUN}'),
      (${sqlUuid(e2)}, ${sqlUuid(w1)}, 'person', 'w2-e2', 'w2-e2-${RUN}'),
      (${sqlUuid(x1)}, ${sqlUuid(w2)}, 'person', 'w2-x1', 'w2-x1-${RUN}')`);
    runSql(`INSERT INTO relationships (id, workspace_id, source_entity_id, target_entity_id, type, valid_from) VALUES
      (${sqlUuid(r1)}, ${sqlUuid(w1)}, ${sqlUuid(e1)}, ${sqlUuid(e2)}, 'relates_to', now()),
      (${sqlUuid(r2)}, ${sqlUuid(w1)}, ${sqlUuid(e1)}, ${sqlUuid(e2)}, 'relates_to', now())`);

    step(5.2, '대조군 — 같은 workspace 안에서는 supersede가 동작한다');
    const ok = await req('POST', `/graph/relationships/${r1}/supersede`, {
      token: userA.token,
      body: { sourceEntityId: e1, targetEntityId: e2, type: 'works_on' },
    });
    assert(ok.status === 201 || ok.status === 200, '대조군: supersede 201', { status: ok.status, body: ok.json });
    const closed = runSql(
      `SELECT coalesce(valid_until::text, 'NULL') FROM relationships WHERE id = ${sqlUuid(r1)}`,
    );
    assert(closed !== 'NULL', '대조군: 기존 관계가 닫혔다(valid_until 설정)', closed);

    step(5.3, '핵심 — 다른 workspace의 entity로 supersede 시도');
    const before = sqlNum(runSql(`SELECT count(*) FROM relationships WHERE workspace_id = ${sqlUuid(w1)}`));
    const cross = await req('POST', `/graph/relationships/${r2}/supersede`, {
      token: userA.token,
      body: { sourceEntityId: x1, targetEntityId: e2, type: 'works_on' },
    });
    assert(cross.status === 404, '교차 workspace supersede → 404(존재 여부도 흘리지 않는다)', {
      status: cross.status,
      body: cross.json,
    });

    step(5.4, '순서 버그 — 거부됐는데 기존 관계가 닫히면 안 된다');
    const stillOpen = runSql(
      `SELECT coalesce(valid_until::text, 'NULL') FROM relationships WHERE id = ${sqlUuid(r2)}`,
    );
    assert(stillOpen === 'NULL', '거부 후 기존 관계의 valid_until은 여전히 NULL', stillOpen);
    const after = sqlNum(runSql(`SELECT count(*) FROM relationships WHERE workspace_id = ${sqlUuid(w1)}`));
    assert(after === before, '거부 후 새 relationship 행이 생기지 않았다', { before, after });
    const leaked = sqlNum(
      runSql(`SELECT count(*) FROM relationships WHERE source_entity_id = ${sqlUuid(x1)} OR target_entity_id = ${sqlUuid(x1)}`),
    );
    assert(leaked === 0, '다른 workspace의 entity를 참조하는 관계가 없다', { leaked });
  });

  /* --- V-6 -------------------------------------------------------------- */
  await item('V-6', '가구 전체 예산 동시 생성이 1건만 남는가', async () => {
    step(6.1, '준비 — 예산 전용 가구');
    const owner = await registerUser('bud-owner');
    const hh = await createHousehold(owner.token, `W2 예산 ${RUN}`);

    step(6.2, '핵심 — household 스코프 예산 2건을 동시 생성');
    const { results: [b1, b2], overlapMs } = await concurrently([
      () => req('POST', '/budgets', {
        token: owner.token,
        body: { householdId: hh, scopeType: 'household', amount: 500_000, name: 'W2 예산 1' },
      }),
      () => req('POST', '/budgets', {
        token: owner.token,
        body: { householdId: hh, scopeType: 'household', amount: 600_000, name: 'W2 예산 2' },
      }),
    ]);
    assert(overlapMs > 0, `두 생성 요청이 실제로 겹쳤다 (${overlapMs}ms)`, { overlapMs });
    const oks = [b1, b2].filter((r) => r.status === 200 || r.status === 201);
    assert(oks.length === 1, '정확히 1건만 성공', { b1: b1.status, b2: b2.status });
    const conflict = [b1, b2].find((r) => r.status >= 400);
    assert(conflict?.status === 409, '나머지는 409(중복 스코프)', {
      status: conflict?.status,
      body: conflict?.json,
    });

    step(6.3, 'DB — 가구 전체 예산 행은 1개');
    const rows = sqlNum(
      runSql(`SELECT count(*) FROM budgets WHERE household_id = ${sqlUuid(hh)} AND scope_type = 'household'`),
    );
    assert(rows === 1, 'budgets(household 스코프) = 1행 (수정 전이라면 2행)', { rows });

    step(6.4, '대조군 — 다른 스코프 예산 생성 경로는 살아 있다');
    const cat = await req('GET', `/categories?householdId=${hh}`, { token: owner.token });
    const categoryId = (Array.isArray(cat.json) ? cat.json : [])[0]?.id;
    assert(typeof categoryId === 'string', '카테고리 조회', { status: cat.status });
    const catBudget = await req('POST', '/budgets', {
      token: owner.token,
      body: { householdId: hh, scopeType: 'category', scopeRefId: categoryId, amount: 100_000 },
    });
    assert(
      catBudget.status === 200 || catBudget.status === 201,
      '대조군: category 스코프 예산은 정상 생성',
      { status: catBudget.status, body: catBudget.json },
    );
  });

  /* --- V-7 -------------------------------------------------------------- */
  await item('V-7', '장치 secret 동시 회전이 active credential을 1개로 유지하는가', async () => {
    step(7.1, '대조군 — 단일 회전은 새 secret이 통하고 옛 secret은 막힌다');
    const device = await registerDevice(userA.token, householdA, `W2 회전 ${RUN}`);
    const first = await req('POST', `/devices/${device.deviceId}/rotate-secret`, { token: userA.token });
    assert(first.status === 200 || first.status === 201, '대조군: 회전 200', first.status);
    assert(
      (await hmacPing(device.deviceId, first.json?.secret)) === 200,
      '대조군: 회전으로 받은 secret이 인증에 통과',
    );
    assert(
      (await hmacPing(device.deviceId, device.secret)) === 401,
      '대조군: 회전 이전 secret은 401',
    );

    step(7.2, '핵심 — 같은 장치에 회전 2건을 동시에');
    const { results: [r1, r2], overlapMs } = await concurrently([
      () => req('POST', `/devices/${device.deviceId}/rotate-secret`, { token: userA.token }),
      () => req('POST', `/devices/${device.deviceId}/rotate-secret`, { token: userA.token }),
    ]);
    assert(overlapMs > 0, `두 회전 요청이 실제로 겹쳤다 (${overlapMs}ms)`, { overlapMs });
    const okResponses = [r1, r2].filter((r) => r.status === 200 || r.status === 201);
    assert(okResponses.length >= 1, '적어도 한 회전은 성공', { r1: r1.status, r2: r2.status });

    const activeCount = sqlNum(
      runSql(
        `SELECT count(*) FROM device_credentials WHERE device_id = ${sqlUuid(device.deviceId)} AND status = 'active'`,
      ),
    );
    assert(activeCount === 1, 'active device_credentials = 정확히 1개', { activeCount });

    step(7.3, '핵심 — 성공 응답의 secret이 실제로 인증에 통과한다');
    // 이 버그의 실제 증상: 서버가 임의로 고른 credential과 클라이언트가 받은 secret이
    // 어긋나 401이 났다. secret과 collectToken은 같은 응답에서 왔으므로 **함께**
    // 유효하거나 함께 무효해야 한다(자기일관성).
    const checks = [];
    for (const r of okResponses) {
      const secretOk = (await hmacPing(device.deviceId, r.json?.secret)) === 200;
      const tokenOk = (await tokenPing(r.json?.collectToken)) === 200;
      checks.push({ secretOk, tokenOk });
      assert(
        secretOk === tokenOk,
        `응답 자기일관성: secret(${secretOk}) === collectToken(${tokenOk})`,
        { secretOk, tokenOk },
      );
    }
    assert(
      checks.filter((c) => c.secretOk).length === 1,
      '성공 응답 중 정확히 1건의 secret이 인증에 통과',
      checks,
    );
  });

  /* --- V-8 -------------------------------------------------------------- */
  await item('V-8', '마이그레이션 0047·0048이 실제로 적용됐는가', async () => {
    step(8.1, 'journal + 적용 이력');
    const applied = sqlNum(runSql('SELECT count(*) FROM drizzle.__drizzle_migrations'));
    assert(applied >= 49, `적용된 마이그레이션 ${applied}건 (0048까지 = 49건 이상)`, { applied });

    step(8.2, '인덱스 실재');
    for (const idx of ['device_credentials_device_active_unique', 'budgets_household_scope_unique']) {
      const found = runSql(`SELECT indexname FROM pg_indexes WHERE indexname = ${sqlLabel(idx)}`);
      assert(found === idx, `인덱스 존재: ${idx}`, found);
    }

    step(8.3, '핵심 — 인덱스가 실제로 중복을 거부하는가 (device_credentials)');
    const device = await registerDevice(userA.token, householdA, `W2 인덱스 ${RUN}`);
    // 등록이 이미 active credential 1개를 만들었다 — 깨끗한 상태에서 시작하려고 폐기한다.
    runSql(
      `UPDATE device_credentials SET status = 'revoked', revoked_at = now() WHERE device_id = ${sqlUuid(device.deviceId)}`,
    );
    const insertCred = `INSERT INTO device_credentials (device_id, secret_ciphertext, secret_iv, secret_auth_tag, key_version, status)
       VALUES (${sqlUuid(device.deviceId)}, 'deadbeef', 'cafe', 'f00d', 1, 'active')`;
    runSql(insertCred);
    const credErr = runSqlExpectError(insertCred);
    assert(credErr != null, '두 번째 active credential INSERT가 실패한다', credErr);
    assert(
      /duplicate key|device_credentials_device_active_unique/.test(credErr ?? ''),
      '실패 사유가 device_credentials_device_active_unique 위반',
      (credErr ?? '').split('\n')[0],
    );

    step(8.4, '핵심 — 인덱스가 실제로 중복을 거부하는가 (budgets)');
    const owner = await registerUser('idx-owner');
    const hh = await createHousehold(owner.token, `W2 인덱스예산 ${RUN}`);
    const ownerId = runSql(`SELECT id FROM users WHERE email = ${sqlEmail(owner.email)}`);
    const insertBudget = `INSERT INTO budgets (household_id, scope_type, amount, created_by)
       VALUES (${sqlUuid(hh)}, 'household', 123456, ${sqlUuid(ownerId)})`;
    runSql(insertBudget);
    const budgetErr = runSqlExpectError(insertBudget);
    assert(budgetErr != null, '두 번째 household 스코프 예산 INSERT가 실패한다', budgetErr);
    assert(
      /duplicate key|budgets_household_scope_unique/.test(budgetErr ?? ''),
      '실패 사유가 budgets_household_scope_unique 위반',
      (budgetErr ?? '').split('\n')[0],
    );
  });

  summary();
  if (failed === 0) {
    console.log('\n모든 필수 시나리오 통과 ✅');
    process.exit(0);
  }
  console.error(`\n검증 실패 ${failed}건. 위 항목을 확인하세요.`);
  process.exit(1);
}

main().catch((e) => {
  console.error('예기치 못한 오류:', e?.message ?? e);
  summary();
  process.exit(1);
});
