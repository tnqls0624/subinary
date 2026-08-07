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
//   4) 틀린 현재 비밀번호 → 4xx, 기존 비밀번호는 그대로 유효
//   5) 정상 변경 → 200, 새 비밀번호로 로그인 가능, 옛 비밀번호는 거부
//   6) 변경 시 기존 세션(refresh) 폐기
//
// (C) 재사용 유예가 로그아웃·비밀번호 변경을 살려내지 않는다 (8~10)
//
// (D) 유예 창 **밖** 재사용이 자동 로그아웃을 만들지 않는다 (11~13)
//   운영 DB 실측(2026-08-07): 465 세션 중 460이 revoked, 같은 초 동시 폐기 12회.
//   앱을 하루 넘게 안 열면 stale 토큰이 유예(24h)를 넘기고, 복귀 첫 refresh가 탈취로
//   오판돼 **다른 기기까지** 로그아웃됐다.
//     11) 창 밖 rotated 재제시 → 그 요청만 401, 다른 기기 세션은 살아 있다 ← 핵심
//     12) 서로 다른 죽은 토큰 3개가 짧은 창에 몰리면(클라이언트 1개로는 불가능한 모양)
//         여전히 전 세션 무효화 — 진짜 탈취 방어는 유지된다
//     13) revoked_reason IS NULL(0045 이전 행)은 기존 동작(전 세션 무효화) 유지
//   24시간을 기다릴 수 없으므로 격리 DB의 `revoked_at`을 48시간 전으로 밀어 재현한다
//   (`ageRevokedSessions`). 운영 컨테이너는 이름 가드로 차단한다.
//
// ⚠️ 이 스크립트는 rate-limit을 의도적으로 소진시킨다. 격리 스택에서만 실행할 것.
// =============================================================================
import { execFileSync } from 'node:child_process';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';
const NEW_PASSWORD = 'Passw0rd!456';
/** main.ts의 인증 경로 상한(분당). 이보다 넉넉히 넘겨 429를 확실히 만든다. */
const AUTH_LIMIT = 10;
/**
 * 격리 스택 postgres 컨테이너(검증 절차의 `-p fma-verify`가 만드는 이름).
 * 시간을 앞당기는 조작이라 대상 오염이 치명적이다 → 운영 프로젝트 이름은 하드 거부한다.
 */
const PG_CONTAINER = process.env.VERIFY_PG_CONTAINER || 'fma-verify-postgres-1';
const PG_USER = process.env.VERIFY_PG_USER || 'family';
const PG_DB = process.env.VERIFY_PG_DB || 'family_memory';

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

/**
 * 격리 스택 DB에 SQL 한 줄을 실행한다.
 *
 * HTTP만으로는 만들 수 없는 상태(하루가 지난 세션, 0045 이전 행)를 만들기 위해서다.
 * 시간을 앞당기는 조작이라 대상이 잘못되면 치명적이므로 운영 컨테이너는 하드 거부한다.
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

/** psql -c에는 바인딩이 없으므로 검증용 이메일 형태를 강제한다(인젝션 차단). */
function sqlEmail(email) {
  if (!/^[a-z0-9.+_-]+@example\.com$/.test(email)) {
    throw new Error(`검증용 이메일 형식이 아닙니다: ${email}`);
  }
  return `(SELECT id FROM users WHERE email = '${email}')`;
}

/**
 * 이 사용자의 폐기된 세션을 48시간 전에 죽은 것으로 만든다(유예 24h 밖으로 밀기).
 *
 * 유예 창 밖 동작을 검증하려면 하루를 기다리거나 시계를 조작해야 한다. 서버 시간을
 * 건드리면 JWT 만료·rate-limit까지 흔들리므로, 판정에 실제로 쓰이는 값 하나
 * (`user_sessions.revoked_at`)만 과거로 민다. 살아 있는 세션(`revoked_at IS NULL`)은
 * 건드리지 않으므로 "다른 기기가 살아 있는가" 검증이 오염되지 않는다.
 *
 * @returns 앞당긴 행 수 — 0이면 검증이 공회전한 것이라 호출부에서 실패시킨다.
 */
function ageRevokedSessions(email) {
  const out = runSql(`WITH aged AS (
      UPDATE user_sessions SET revoked_at = now() - interval '48 hours'
      WHERE revoked_at IS NOT NULL AND user_id = ${sqlEmail(email)}
      RETURNING 1
    ) SELECT count(*) FROM aged`);
  return Number.parseInt(out, 10);
}

/** 폐기 사유를 지워 0045 이전(revoked_reason IS NULL) 행을 재현한다. */
function clearRevokedReason(email) {
  const out = runSql(`WITH cleared AS (
      UPDATE user_sessions SET revoked_reason = NULL
      WHERE revoked_at IS NOT NULL AND user_id = ${sqlEmail(email)}
      RETURNING 1
    ) SELECT count(*) FROM cleared`);
  return Number.parseInt(out, 10);
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
  // 단계 수가 늘면서 시각 기반 IP는 우연히 같은 값을 뽑아 앞 단계의 소진된 버킷을
  // 물려받을 수 있다(가짜 429 실패). 시작점만 랜덤하게 잡고 이후는 순차 증가시킨다.
  const ipBase = (Date.now() % 100) + 10;
  let ipSeq = 0;
  const H = { 'cf-connecting-ip': `192.0.2.${ipBase}` };
  const nextIp = () => {
    ipSeq += 1;
    H['cf-connecting-ip'] = `192.0.2.${ipBase + ipSeq}`;
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
  async function loginRaw(pw, as = email) {
    const res = await fetch(`${BASE}${PREFIX}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({ email: as, password: pw }),
    });
    const body = await res.json().catch(() => undefined);
    // logout은 쿠키뿐 아니라 access token도 요구한다(전역 AccessTokenGuard).
    return {
      status: res.status,
      cookie: cookieOf(res),
      accessToken: body?.tokens?.accessToken,
    };
  }
  /** 회전 결과 쿠키까지 돌려준다 — 회전 후 새 세션의 생존을 이어서 확인해야 한다. */
  async function refreshWith(cookie) {
    // content-type이 json이면 body가 없을 때 Fastify가 400을 낸다(빈 객체 명시).
    const res = await fetch(`${BASE}${PREFIX}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `refresh_token=${cookie}`, ...H },
      body: '{}',
    });
    return { status: res.status, cookie: cookieOf(res) };
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
      after.status >= 400,
      '로그아웃한 토큰으로 refresh → 4xx (유예가 살려내지 않는다)',
      after.status,
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
      bAfter.status >= 400,
      '기기 B의 refresh → 4xx (모든 기기 로그아웃이 실제로 성립)',
      bAfter.status,
    );
  }

  step(10, '회전으로 죽은 세션은 유예가 계속 적용된다(자동 로그아웃 없음)');
  {
    nextIp();
    const s = await loginRaw(PASSWORD);
    assert(s.cookie != null, '로그인');
    const first = await refreshWith(s.cookie);
    assert(first.status === 200, '정상 회전 200', first.status);
    // 회전으로 죽은 옛 토큰을 다시 제시 → 유예로 복구되어야 한다(다중 탭 시나리오).
    const reuse = await refreshWith(s.cookie);
    assert(reuse.status === 200, '회전된 옛 토큰 재사용 → 200 복구(유예 유지)', reuse.status);
  }

  // ── (D) 유예 창 밖 재사용이 자동 로그아웃을 만들지 않는다 ────────────────────
  step(11, '핵심 — 유예 창 밖의 rotated 재사용은 다른 기기 세션을 죽이지 않는다');
  {
    nextIp();
    // 기기 A: 회전까지 마친 뒤 옛 토큰을 그대로 들고 있는 상태(모바일 회전 응답 유실).
    const deviceA = await loginRaw(PASSWORD);
    assert(deviceA.cookie != null, '기기 A 로그인');
    const deviceB = await loginRaw(PASSWORD);
    assert(deviceB.cookie != null, '기기 B 로그인');

    const rotated = await refreshWith(deviceA.cookie);
    assert(rotated.status === 200, '기기 A 회전 200', rotated.status);
    assert(rotated.cookie != null, '기기 A 새 토큰 수신');

    // 하루가 지난 것으로 만든다(유예 24h 밖). 살아 있는 세션은 건드리지 않는다.
    const aged = ageRevokedSessions(email);
    assert(aged > 0, 'revoked_at을 48시간 전으로 이동(대상 행 존재)', aged);

    const stale = await refreshWith(deviceA.cookie);
    assert(stale.status === 401, '창 밖 옛 토큰 → 이 요청만 401', stale.status);

    // 수정 전에는 여기서 revokeAllSessions가 돌아 기기 B와 웹까지 함께 죽었다.
    const bAlive = await refreshWith(deviceB.cookie);
    assert(bAlive.status === 200, '다른 기기(B) 세션은 살아 있다 ← 자동 로그아웃 제거', bAlive.status);

    const aAlive = await refreshWith(rotated.cookie);
    assert(aAlive.status === 200, '기기 A의 현재 세션도 살아 있다', aAlive.status);
  }

  step(12, '진짜 탈취 신호(서로 다른 죽은 토큰 3개/15분)에는 전 세션 무효화가 유지된다');
  {
    nextIp();
    // 폭주 카운터는 사용자 단위라 앞 단계의 기록과 섞이지 않도록 새 계정을 쓴다.
    const burstEmail = `burst-${RUN}@example.com`;
    const reg = await raw('/auth/register', {
      body: { email: burstEmail, password: PASSWORD, name: 'Burst Test' },
      headers: H,
    });
    assert(reg.status === 201 || reg.status === 200, '폭주 검증용 계정 생성', reg.status);

    // 서로 다른 세션 3개를 만들어 각각 회전시킨다 → 죽은 토큰 3개(클라이언트 하나로는
    // 만들 수 없는 상태: 정상 클라이언트는 refresh 토큰을 한 개만 들고 있다).
    const dead = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await loginRaw(PASSWORD, burstEmail);
      assert(s.cookie != null, `죽일 세션 ${i + 1} 로그인`);
      const r = await refreshWith(s.cookie);
      assert(r.status === 200, `세션 ${i + 1} 회전 200`, r.status);
      dead.push(s.cookie);
    }
    // 피해자 세션: 폭주가 감지되면 이 세션까지 끊겨야 한다.
    let victim = await loginRaw(PASSWORD, burstEmail);
    assert(victim.cookie != null, '피해자 세션 로그인');

    const aged = ageRevokedSessions(burstEmail);
    assert(aged >= 3, '죽은 토큰 3개를 유예 창 밖으로 이동', aged);

    for (let i = 0; i < 2; i += 1) {
      const r = await refreshWith(dead[i]);
      assert(r.status === 401, `죽은 토큰 ${i + 1}번째 재제시 → 401`, r.status);
      const alive = await refreshWith(victim.cookie);
      assert(alive.status === 200, `임계값 전(${i + 1}건)에는 다른 세션 생존`, alive.status);
      victim = { cookie: alive.cookie };
    }

    const third = await refreshWith(dead[2]);
    assert(third.status === 401, '죽은 토큰 3번째 재제시 → 401', third.status);
    const afterBurst = await refreshWith(victim.cookie);
    assert(
      afterBurst.status === 401,
      '임계값 도달 → 전 세션 무효화(탈취 방어 유지)',
      afterBurst.status,
    );
  }

  step(13, 'revoked_reason IS NULL(0045 이전 행)은 기존 동작(전 세션 무효화)을 유지한다');
  {
    nextIp();
    // 사유를 모르는 옛 행에 새 완화 정책을 소급 적용하지 않는다는 결정의 회귀 검증.
    const legacyEmail = `legacy-${RUN}@example.com`;
    const reg = await raw('/auth/register', {
      body: { email: legacyEmail, password: PASSWORD, name: 'Legacy Test' },
      headers: H,
    });
    assert(reg.status === 201 || reg.status === 200, '0045 이전 재현용 계정 생성', reg.status);

    const deviceA = await loginRaw(PASSWORD, legacyEmail);
    const deviceB = await loginRaw(PASSWORD, legacyEmail);
    assert(deviceA.cookie != null && deviceB.cookie != null, '기기 A·B 로그인');

    const rotated = await refreshWith(deviceA.cookie);
    assert(rotated.status === 200, '기기 A 회전 200', rotated.status);

    const cleared = clearRevokedReason(legacyEmail);
    assert(cleared > 0, 'revoked_reason을 NULL로(0045 이전 행 재현)', cleared);
    const aged = ageRevokedSessions(legacyEmail);
    assert(aged > 0, 'revoked_at을 48시간 전으로 이동', aged);

    const stale = await refreshWith(deviceA.cookie);
    assert(stale.status === 401, '창 밖 재제시 → 401', stale.status);
    const bAfter = await refreshWith(deviceB.cookie);
    assert(bAfter.status === 401, '다른 기기 세션도 무효화(기존 동작 보존)', bAfter.status);
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
