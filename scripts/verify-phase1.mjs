#!/usr/bin/env node
// =============================================================================
// verify-phase1.mjs — Phase 1(인증 & 가족) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase1-build-spec.md §6 시나리오(1~14)를 실 스택 대상으로 실행한다.
// Node 내장 fetch만 사용(외부 의존성 없음). set-cookie 를 수동 파싱/보관해
// refresh 회전 검증에 사용한다.
//
// 실행법:
//   1) 전체 스택 기동(진행자가 사전 수행):
//        cp .env.example .env   # 최초 1회
//        docker compose up -d --build   # migrate → api/worker/web 기동
//   2) api 준비 확인:
//        curl -s http://localhost:3001/v1/health/live
//   3) 본 스크립트 실행:
//        node scripts/verify-phase1.mjs
//        # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase1.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
//
// 주의(§6 12번): 초대 만료는 서버 시간을 조작할 수 없으므로, revoke 후 수락이
// 4xx 로 차단되는지로 "재사용/취소 초대 차단"을 대체 검증한다.
// 로그에는 토큰/비밀번호/해시 원문을 출력하지 않는다(Secret 미노출).
// =============================================================================

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌(409)을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

let passed = 0;
let failed = 0;

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
    // extra 는 상태코드/에러코드 등 비민감 정보만 전달한다(토큰/비밀번호 금지).
    console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  summary();
  console.error('\n검증 실패. 위 항목을 확인하세요.');
  process.exit(1);
}

function step(n, title) {
  console.log(`\n[${n}] ${title}`);
}

/**
 * 응답의 set-cookie 헤더들을 원본 문자열 배열로 반환한다.
 * Node 18.14+/22 의 undici Headers.getSetCookie() 우선 사용, 없으면 get() 폴백.
 */
function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie();
  }
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * set-cookie 배열에서 refresh_token 쿠키를 수동 파싱한다.
 * 반환: { value, cleared } | null
 *  - cleared: Max-Age=0 또는 값이 비어 있으면(clearCookie) true.
 */
function parseRefreshCookie(setCookies) {
  for (const c of setCookies) {
    const firstPart = c.split(';')[0];
    const eq = firstPart.indexOf('=');
    if (eq === -1) continue;
    const name = firstPart.slice(0, eq).trim();
    const value = firstPart.slice(eq + 1).trim();
    if (name !== 'refresh_token') continue;
    const lower = c.toLowerCase();
    const cleared = value === '' || /(^|;\s*)max-age=0(\s*;|$)/.test(lower);
    return { value, cleared };
  }
  return null;
}

/** 저장한 refresh 쿠키 값을 Cookie 헤더 문자열로 만든다. */
function cookieHeader(refreshValue) {
  return `refresh_token=${refreshValue}`;
}

/**
 * HTTP 요청 헬퍼. body 가 있으면 JSON 직렬화, token 이 있으면 Bearer,
 * refresh 가 있으면 Cookie 헤더로 전송한다.
 * 반환: { status, json, setCookies }
 */
async function req(method, path, { token, body, refresh } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (refresh) headers.cookie = cookieHeader(refresh);

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
  return { status: res.status, json, setCookies: getSetCookies(res) };
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(false, `API(${BASE}) 준비되지 않음 — health/live 실패`, lastErr);
}

function email(label) {
  return `${label}-${RUN}@example.com`.toLowerCase();
}

async function register(label) {
  const em = email(label);
  const res = await req('POST', '/auth/register', {
    body: { email: em, password: PASSWORD, name: label },
  });
  return { res, email: em };
}

// =============================================================================
async function main() {
  console.log(`Phase 1 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  // ── 1) 회원가입 ownerA → 201, accessToken 수신 ────────────────────────────
  step(1, '회원가입 ownerA → 201, accessToken 수신');
  const a = await register('owner-a');
  assert(a.res.status === 201, 'ownerA 회원가입 응답이 201', a.res.status);
  const ownerAToken = a.res.json?.tokens?.accessToken;
  assert(typeof ownerAToken === 'string' && ownerAToken.length > 0, 'accessToken 문자열 수신');
  assert(a.res.json?.user?.email === a.email, 'user.email 이 소문자 정규화되어 반환');
  const ownerARefresh0 = parseRefreshCookie(a.res.setCookies);
  assert(!!ownerARefresh0 && !ownerARefresh0.cleared, 'refresh_token 쿠키 설정됨');

  // ── 2) 잘못된 비밀번호 로그인 → 401 ────────────────────────────────────────
  step(2, '잘못된 비밀번호 로그인 → 401(자격 존재 여부 비노출)');
  const badLogin = await req('POST', '/auth/login', {
    body: { email: a.email, password: 'definitely-wrong' },
  });
  assert(badLogin.status === 401, '잘못된 비밀번호는 401', badLogin.status);

  // ── 3) ownerA 가족 생성 → myRole owner ────────────────────────────────────
  step(3, 'ownerA 가족 생성 → myRole owner');
  const created = await req('POST', '/households', {
    token: ownerAToken,
    body: { name: `A네 가족 ${RUN}` },
  });
  assert(created.status >= 200 && created.status < 300, '가족 생성 2xx', created.status);
  const householdId = created.json?.id;
  assert(typeof householdId === 'string' && householdId.length > 0, '가족 id 반환');
  assert(created.json?.myRole === 'owner', 'myRole === owner', created.json?.myRole);

  // ── 4) GET /me → memberships 에 해당 가족 포함 ─────────────────────────────
  step(4, 'GET /auth/me → memberships 에 생성한 가족 포함');
  const me = await req('GET', '/auth/me', { token: ownerAToken });
  assert(me.status === 200, '/auth/me 200', me.status);
  const memberships = Array.isArray(me.json?.memberships) ? me.json.memberships : [];
  const mine = memberships.find((m) => m.householdId === householdId);
  assert(!!mine, 'memberships 에 생성 가족 존재');
  assert(mine?.role === 'owner', 'membership.role === owner', mine?.role);

  // ── 5) ownerA 초대 생성(role member) → raw token 수신 ─────────────────────
  step(5, 'ownerA 초대 생성(role member) → raw token 1회 수신');
  const inv = await req('POST', `/households/${householdId}/invitations`, {
    token: ownerAToken,
    body: { role: 'member' },
  });
  assert(inv.status >= 200 && inv.status < 300, '초대 생성 2xx', inv.status);
  const inviteToken = inv.json?.token;
  assert(typeof inviteToken === 'string' && inviteToken.length > 0, 'raw 초대 token 수신');
  assert(inv.json?.role === 'member', '초대 role === member', inv.json?.role);
  assert(
    typeof inv.json?.acceptUrlPath === 'string' && inv.json.acceptUrlPath.includes('/accept'),
    'acceptUrlPath 반환',
  );

  // ── 6) userB 회원가입 → accessToken ───────────────────────────────────────
  step(6, 'userB 회원가입 → accessToken');
  const b = await register('user-b');
  assert(b.res.status === 201, 'userB 회원가입 201', b.res.status);
  const userBToken = b.res.json?.tokens?.accessToken;
  assert(typeof userBToken === 'string' && userBToken.length > 0, 'userB accessToken 수신');

  // ── 7) userB 초대 수락(consent:true) → member 합류 ────────────────────────
  step(7, 'userB 초대 수락(consent:true) → member 합류');
  const accept = await req('POST', `/household-invitations/${inviteToken}/accept`, {
    token: userBToken,
    body: { consent: true },
  });
  assert(accept.status >= 200 && accept.status < 300, '초대 수락 2xx', accept.status);
  assert(accept.json?.myRole === 'member', '합류 myRole === member', accept.json?.myRole);

  // ── 8) userB GET /households/:id → 200 (myRole member) ────────────────────
  step(8, 'userB GET /households/:id → 200(myRole member)');
  const bGet = await req('GET', `/households/${householdId}`, { token: userBToken });
  assert(bGet.status === 200, 'userB 가족 조회 200', bGet.status);
  assert(bGet.json?.myRole === 'member', 'myRole === member', bGet.json?.myRole);

  // ── 9) 보안: userC(비멤버) GET /households/:id → 403 ──────────────────────
  step(9, '보안: userC(비멤버) 가족 조회 → 403');
  const c = await register('user-c');
  assert(c.res.status === 201, 'userC 회원가입 201', c.res.status);
  const userCToken = c.res.json?.tokens?.accessToken;
  const cGet = await req('GET', `/households/${householdId}`, { token: userCToken });
  assert(cGet.status === 403, '비멤버 접근 403', cGet.status);

  // ── 10) 보안: userB(member)가 초대 생성 → 403 ─────────────────────────────
  step(10, '보안: userB(member)의 초대 생성 → 403(owner 전용)');
  const bInvite = await req('POST', `/households/${householdId}/invitations`, {
    token: userBToken,
    body: { role: 'member' },
  });
  assert(bInvite.status === 403, 'member 의 owner 전용 API 403', bInvite.status);

  // ── 11) 보안: 동일 초대 토큰 재수락 → 4xx(재사용 차단) ────────────────────
  step(11, '보안: 이미 수락된 토큰을 userC가 재수락 → 4xx(재사용 차단)');
  const reAccept = await req('POST', `/household-invitations/${inviteToken}/accept`, {
    token: userCToken,
    body: { consent: true },
  });
  assert(reAccept.status >= 400 && reAccept.status < 500, '재사용 초대 토큰 4xx', reAccept.status);

  // ── 12) 보안: revoke 후 수락 → 4xx(만료 대체 검증) ────────────────────────
  step(12, '보안: 초대 생성 → revoke → 수락 시도 → 4xx(만료 대체 검증)');
  const inv2 = await req('POST', `/households/${householdId}/invitations`, {
    token: ownerAToken,
    body: { role: 'member' },
  });
  assert(inv2.status >= 200 && inv2.status < 300, '2차 초대 생성 2xx', inv2.status);
  const inv2Token = inv2.json?.token;
  const inv2Id = inv2.json?.invitationId;
  assert(typeof inv2Token === 'string' && inv2Token.length > 0, '2차 초대 token 수신');
  assert(typeof inv2Id === 'string' && inv2Id.length > 0, '2차 초대 invitationId 수신');

  const revoke = await req('DELETE', `/households/${householdId}/invitations/${inv2Id}`, {
    token: ownerAToken,
  });
  assert(revoke.status >= 200 && revoke.status < 300, '초대 revoke 2xx', revoke.status);

  const d = await register('user-d');
  assert(d.res.status === 201, 'userD 회원가입 201', d.res.status);
  const userDToken = d.res.json?.tokens?.accessToken;
  const acceptRevoked = await req('POST', `/household-invitations/${inv2Token}/accept`, {
    token: userDToken,
    body: { consent: true },
  });
  assert(
    acceptRevoked.status >= 400 && acceptRevoked.status < 500,
    '취소된 초대 수락 4xx',
    acceptRevoked.status,
  );

  // ── 13) refresh 회전 + 이전 refresh 재사용 차단 ───────────────────────────
  step(13, 'refresh: 회전(새 accessToken + 새 쿠키), 이전 refresh 재사용 → 401');
  const refresh1 = await req('POST', '/auth/refresh', { refresh: ownerARefresh0.value });
  assert(refresh1.status === 200, 'refresh 200', refresh1.status);
  const rotatedToken = refresh1.json?.tokens?.accessToken;
  assert(typeof rotatedToken === 'string' && rotatedToken.length > 0, '새 accessToken 수신');
  const ownerARefresh1 = parseRefreshCookie(refresh1.setCookies);
  assert(!!ownerARefresh1 && !ownerARefresh1.cleared, '새 refresh_token 쿠키 설정');
  assert(
    ownerARefresh1.value !== ownerARefresh0.value,
    'refresh 토큰이 회전됨(이전 값과 다름)',
  );

  const reuseOld = await req('POST', '/auth/refresh', { refresh: ownerARefresh0.value });
  assert(reuseOld.status === 401, '이전 refresh 재사용 401', reuseOld.status);

  // ── 14) logout → 이후 refresh 401 ─────────────────────────────────────────
  step(14, 'logout → 이후 refresh 401');
  // 재사용 탐지(13번)로 ownerA의 모든 세션이 무효화되므로, 깨끗한 로그아웃 검증을
  // 위해 새로 로그인해 살아있는 세션을 확보한 뒤 로그아웃한다.
  const relogin = await req('POST', '/auth/login', {
    body: { email: a.email, password: PASSWORD },
  });
  assert(relogin.status === 200, '재로그인 200', relogin.status);
  const reloginToken = relogin.json?.tokens?.accessToken;
  const reloginRefresh = parseRefreshCookie(relogin.setCookies);
  assert(!!reloginRefresh && !reloginRefresh.cleared, '재로그인 refresh 쿠키 설정');

  const logout = await req('POST', '/auth/logout', {
    token: reloginToken,
    refresh: reloginRefresh.value,
  });
  assert(logout.status === 200, 'logout 200', logout.status);
  const logoutCookie = parseRefreshCookie(logout.setCookies);
  assert(!logoutCookie || logoutCookie.cleared, 'logout 시 refresh 쿠키 제거');

  const afterLogout = await req('POST', '/auth/refresh', { refresh: reloginRefresh.value });
  assert(afterLogout.status === 401, 'logout 이후 refresh 401', afterLogout.status);

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). Secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
