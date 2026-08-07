#!/usr/bin/env node
// =============================================================================
// verify-auth-hardening.mjs — rate-limit 키 신뢰성 + 비밀번호 변경 e2e
// -----------------------------------------------------------------------------
// (A) rate-limit 우회 차단
//   인증 경로 버킷은 `cf-connecting-ip`로 나뉜다. 예전에는 `x-forwarded-for`의 첫
//   요소를 썼는데, Cloudflare는 클라이언트가 보낸 XFF를 지우지 않고 뒤에 append하므로
//   첫 요소는 공격자가 정하는 값이었다 — 매 요청 다른 값을 넣으면 버킷이 매번 새로
//   생겨 리밋이 무력화되고 argon2id로 CPU를 고갈시킬 수 있다.
//     1) 같은 cf-connecting-ip로 상한을 넘기면 429
//     2) 그 상태에서 **XFF만 바꿔도 계속 429**(우회 불가) ← 핵심
//     3) cf-connecting-ip를 바꾸면 새 버킷(429 해제)
//
// (B) 비밀번호 변경
//     4) 틀린 현재 비밀번호 → 4xx, 기존 비밀번호는 그대로 유효
//     5) 정상 변경 → 200, 새 비밀번호로 로그인 가능, 옛 비밀번호는 거부
//     6) 변경 시 기존 세션(refresh) 폐기
//
// ⚠️ 이 스크립트는 rate-limit을 의도적으로 소진시킨다. 격리 스택에서만 실행할 것.
// =============================================================================
const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';
const NEW_PASSWORD = 'Passw0rd!456';
/** main.ts의 인증 경로 상한(분당). 이보다 넉넉히 넘겨 429를 확실히 만든다. */
const AUTH_LIMIT = 10;

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

/** 헤더를 직접 제어하는 저수준 요청(rate-limit 키 검증용). */
async function raw(path, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${PREFIX}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

/** 로그인 시도(실패해도 됨) — 버킷 소진용. */
function loginAttempt(headers) {
  return raw('/auth/login', {
    body: { email: `nobody-${RUN}@example.com`, password: 'wrong-password' },
    headers,
  });
}

async function main() {
  console.log(`=== verify-auth-hardening ===\nBASE=${BASE} RUN=${RUN}`);

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

  // --- (A) rate-limit 키 신뢰성 ------------------------------------------
  // 각 단계가 서로의 버킷을 오염시키지 않도록 IP를 RUN마다 다르게 잡는다.
  const attackerIp = `203.0.113.${(Date.now() % 200) + 10}`;
  const otherIp = `198.51.100.${(Date.now() % 200) + 10}`;

  step(1, `같은 cf-connecting-ip로 인증 상한(${AUTH_LIMIT}/분) 소진 → 429`);
  let sawLimit = false;
  for (let i = 0; i < AUTH_LIMIT + 4; i += 1) {
    const r = await loginAttempt({ 'cf-connecting-ip': attackerIp });
    if (r.status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert(sawLimit, `${AUTH_LIMIT + 4}회 이내에 429 발생`);

  step(2, '핵심 — x-forwarded-for만 바꿔도 우회되지 않는다');
  {
    // 예전 구현(XFF 첫 요소)이라면 매번 새 버킷이 생겨 200/401이 돌아왔다.
    let bypassed = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = await loginAttempt({
        'cf-connecting-ip': attackerIp,
        'x-forwarded-for': `10.0.0.${i}, ${attackerIp}`,
      });
      if (r.status !== 429) bypassed += 1;
    }
    assert(
      bypassed === 0,
      'XFF를 매번 바꿔도 5회 모두 429(리밋 우회 불가)',
      { bypassed },
    );
  }

  step(3, 'cf-connecting-ip가 다르면 별도 버킷(정상 사용자는 안 막힌다)');
  {
    const r = await loginAttempt({ 'cf-connecting-ip': otherIp });
    assert(r.status !== 429, '다른 IP는 429가 아니다', r.status);
  }

  // --- (B) 비밀번호 변경 ---------------------------------------------------
  // 위에서 인증 버킷을 소진했으므로, 이후 요청은 리밋에 걸리지 않는 새 IP로 보낸다.
  // 인증 버킷은 10회/분이고 이 스크립트는 단계마다 로그인을 여러 번 한다. 단계별로
  // cf-connecting-ip를 갈아 끼워 서로의 버킷을 소진하지 않게 한다(리밋이 정확히
  // IP 단위로 나뉜다는 것은 위 [3]에서 이미 검증했다).
  const H = { 'cf-connecting-ip': `192.0.2.${(Date.now() % 200) + 10}` };
  let ipSeq = 0;
  const nextIp = () => {
    ipSeq += 1;
    H['cf-connecting-ip'] = `192.0.2.${((Date.now() + ipSeq * 7) % 200) + 10}`;
  };
  const email = `pw-${RUN}@example.com`;

  step(4, '준비 — 계정 생성');
  let accessToken;
  {
    const r = await raw('/auth/register', {
      body: { email, password: PASSWORD, name: 'PW Test' },
      headers: H,
    });
    assert(r.status === 201 || r.status === 200, '회원가입', r.status);
    accessToken = r.json?.tokens?.accessToken;
    assert(typeof accessToken === 'string', 'access token 수신');
  }

  step(5, '틀린 현재 비밀번호 → 거부 + 기존 비밀번호는 그대로 유효');
  {
    const r = await raw('/auth/change-password', {
      body: { currentPassword: 'definitely-wrong', newPassword: NEW_PASSWORD },
      headers: { ...H, authorization: `Bearer ${accessToken}` },
    });
    assert(r.status >= 400 && r.status < 500, '틀린 비밀번호 → 4xx', r.status);

    const login = await raw('/auth/login', {
      body: { email, password: PASSWORD },
      headers: H,
    });
    assert(login.status === 200 || login.status === 201, '기존 비밀번호로 여전히 로그인됨', login.status);
    accessToken = login.json?.tokens?.accessToken ?? accessToken;
  }

  step(6, '정상 변경 → 새 비밀번호로 로그인, 옛 비밀번호는 거부');
  {
    const r = await raw('/auth/change-password', {
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      headers: { ...H, authorization: `Bearer ${accessToken}` },
    });
    assert(r.status === 200, '변경 200', r.status);
    assert(r.json?.success === true, 'success: true', r.json);

    const oldLogin = await raw('/auth/login', {
      body: { email, password: PASSWORD },
      headers: H,
    });
    assert(oldLogin.status >= 400, '옛 비밀번호 로그인 거부', oldLogin.status);

    const newLogin = await raw('/auth/login', {
      body: { email, password: NEW_PASSWORD },
      headers: H,
    });
    assert(
      newLogin.status === 200 || newLogin.status === 201,
      '새 비밀번호로 로그인 성공',
      newLogin.status,
    );
  }

  step(7, '쿠키 없는 refresh는 거부');
  {
    const r = await raw('/auth/refresh', { headers: H });
    assert(r.status >= 400, '쿠키 없는 refresh는 거부', r.status);
  }

  // ── (C) 재사용 유예가 로그아웃·비밀번호 변경을 살려내지 않는다 ──────────────
  // 유예(REFRESH_REUSE_GRACE_MS = 24h)는 다중 탭 동시 회전과 모바일 회전 응답 유실을
  // 자동 로그아웃으로 처리하지 않으려고 도입했다. 그런데 `revokedAt`만 보면 명시적
  // 로그아웃과 비밀번호 변경까지 유예 대상이 되어, 24시간 동안 같은 토큰으로 세션을
  // 다시 받을 수 있었다("모든 기기에서 로그아웃"이 거짓이 된다).
  // → `revokedReason='rotated'`일 때만 유예한다.
  const cookieOf = (res) => {
    const raw = res.headers?.get?.('set-cookie') ?? '';
    const m = /refresh_token=([^;]+)/.exec(raw);
    return m?.[1] && m[1] !== '' ? m[1] : undefined;
  };
  /** set-cookie를 읽어야 하므로 fetch를 직접 쓴다. */
  async function loginRaw(pw) {
    const res = await fetch(`${BASE}${PREFIX}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({ email, password: pw }),
    });
    const body = await res.json().catch(() => undefined);
    // logout은 쿠키뿐 아니라 access token도 요구한다(전역 AccessTokenGuard).
    return {
      status: res.status,
      cookie: cookieOf(res),
      accessToken: body?.tokens?.accessToken,
    };
  }
  async function refreshWith(cookie) {
    const res = await fetch(`${BASE}${PREFIX}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `refresh_token=${cookie}`, ...H },
      body: '{}',
    });
    return res.status;
  }

  step(8, '로그아웃한 refresh는 유예 없이 즉시 거부된다');
  {
    nextIp();
    const session = await loginRaw(NEW_PASSWORD);
    assert(session.status === 200 || session.status === 201, '로그인', session.status);
    assert(session.cookie != null, 'refresh 쿠키 수신');

    // content-type을 json으로 두고 body를 비우면 Fastify가 400을 낸다(빈 객체 명시).
    const out = await fetch(`${BASE}${PREFIX}/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `refresh_token=${session.cookie}`,
        authorization: `Bearer ${session.accessToken}`,
        ...H,
      },
      body: '{}',
    });
    assert(out.status === 200 || out.status === 204, '로그아웃', out.status);

    const after = await refreshWith(session.cookie);
    assert(
      after >= 400,
      '로그아웃한 토큰으로 refresh → 4xx (유예가 살려내지 않는다)',
      after,
    );
  }

  step(9, '비밀번호 변경으로 죽은 다른 기기 세션도 즉시 거부된다');
  {
    nextIp();
    // 기기 A·B 두 세션을 만들고, A에서 비밀번호를 바꾼 뒤 B의 refresh를 시도한다.
    const deviceB = await loginRaw(NEW_PASSWORD);
    assert(deviceB.cookie != null, '기기 B 로그인');
    const deviceA = await loginRaw(NEW_PASSWORD);
    assert(deviceA.status === 200 || deviceA.status === 201, '기기 A 로그인');

    const loginA = await raw('/auth/login', { body: { email, password: NEW_PASSWORD }, headers: H });
    const tokenA = loginA.json?.tokens?.accessToken;
    const changed = await raw('/auth/change-password', {
      body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD },
      headers: { ...H, authorization: `Bearer ${tokenA}` },
    });
    assert(changed.status === 200, '기기 A에서 비밀번호 변경', changed.status);

    const bAfter = await refreshWith(deviceB.cookie);
    assert(
      bAfter >= 400,
      '기기 B의 refresh → 4xx (모든 기기 로그아웃이 실제로 성립)',
      bAfter,
    );
  }

  step(10, '회전으로 죽은 세션은 유예가 계속 적용된다(자동 로그아웃 없음)');
  {
    nextIp();
    const s = await loginRaw(PASSWORD);
    assert(s.cookie != null, '로그인');
    const first = await fetch(`${BASE}${PREFIX}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `refresh_token=${s.cookie}`, ...H },
      body: '{}',
    });
    assert(first.status === 200, '정상 회전 200', first.status);
    // 회전으로 죽은 옛 토큰을 다시 제시 → 유예로 복구되어야 한다(다중 탭 시나리오).
    const reuse = await refreshWith(s.cookie);
    assert(reuse === 200, '회전된 옛 토큰 재사용 → 200 복구(유예 유지)', reuse);
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
