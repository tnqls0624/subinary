#!/usr/bin/env node
// =============================================================================
// verify-phase2.mjs — Phase 2(스마트폰 장치 & HMAC 인증) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase2-build-spec.md §6 시나리오(1~9, 선택 10)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + node:crypto 만 사용(외부 의존성 없음).
//
// 서명 프로토콜(스펙 §1.2 / §4.4):
//   서명 대상 payload = `${X-Timestamp}.${X-Nonce}.${rawBody}`  (원본 바이트)
//   X-Signature       = HMAC-SHA256(secret, payload) 의 hex digest
//   요청 body 는 서명한 bodyString 과 **정확히 동일 바이트**로 전송한다
//   (JSON.stringify 결과 문자열을 그대로 fetch body 로 사용).
//   헤더: X-Device-Id / X-Timestamp / X-Nonce / X-Signature, Content-Type application/json.
//
// 실행법:
//   1) 전체 스택 기동(진행자가 사전 수행):
//        cp .env.example .env   # 최초 1회(DEVICE_SECRET_ENC_KEY 등 device env 포함)
//        docker compose up -d --build   # migrate → api/worker/web 기동
//   2) api 준비 확인:
//        curl -s http://localhost:3001/v1/health/live
//   3) 본 스크립트 실행:
//        node scripts/verify-phase2.mjs
//        # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase2.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
//
// 로그에는 secret 원문/암호문/서명/키/토큰/비밀번호를 출력하지 않는다(Secret 미노출).
// HMAC 검증 실패는 서버가 일반 401 메시지("device authentication failed")로 응답한다.
// =============================================================================

import { createHmac, randomBytes } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌(409)을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

let passed = 0;
let failed = 0;
let optional = 0;

function summary() {
  console.log('');
  console.log('────────────────────────────────────────');
  console.log(`요약: 통과 ${passed} · 실패 ${failed} · 선택 ${optional}`);
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
    // extra 는 상태코드/에러코드 등 비민감 정보만 전달한다(secret/토큰/서명 금지).
    console.error(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  summary();
  console.error('\n검증 실패. 위 항목을 확인하세요.');
  process.exit(1);
}

/**
 * 선택(§6 10번) 시나리오용 비치명적 검사.
 * 환경(bodyLimit 등)에 따라 코드가 달라질 수 있어, 불일치해도 경고만 남기고 종료하지 않는다.
 */
function softCheck(cond, msg, extra) {
  optional += 1;
  if (cond) {
    console.log(`  ✓ (선택) ${msg}`);
    return;
  }
  console.warn(`  ⚠ (선택) 미충족: ${msg}`);
  if (extra !== undefined) {
    console.warn(`         상세: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
}

function step(n, title) {
  console.log(`\n[${n}] ${title}`);
}

/**
 * HTTP 요청 헬퍼(장치 관리 라우트 = Bearer 인증). body 가 있으면 JSON 직렬화,
 * token 이 있으면 Bearer 로 전송한다. 반환: { status, json }.
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(false, `API(${BASE}) 준비되지 않음 — health/live 실패`, lastErr);
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

// ── HMAC 서명 헬퍼(클라이언트 측) ───────────────────────────────────────────

/** 현재 epoch seconds(문자열). X-Timestamp 는 정수 epoch seconds 문자열로 규정(스펙 §4.4). */
function nowSec() {
  return Math.floor(Date.now() / 1000).toString();
}

/** 매 요청 고유한 nonce(재사용 테스트 제외). */
function newNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * 서명 레시피(스펙 §6):
 *   sign(secret, tsSec, nonce, bodyString) = HMAC-SHA256(secret, `${tsSec}.${nonce}.${bodyString}`) hex
 */
function sign(secret, tsSec, nonce, bodyString) {
  return createHmac('sha256', secret).update(`${tsSec}.${nonce}.${bodyString}`).digest('hex');
}

/**
 * mobile-events ping 요청(HMAC 가드 경유). 옵션으로 각 요소를 주입해
 * 잘못된 서명 / 만료 timestamp / nonce 재사용 / 잘못된 Content-Type 등을 재현한다.
 *
 * 반환: { status, json }.
 * body 는 서명한 bodyString 과 **동일 바이트**로 전송한다.
 */
async function ping(opts = {}) {
  const {
    deviceId,
    secret,
    ts = nowSec(),
    nonce = newNonce(),
    body = JSON.stringify({ source: 'verify-phase2' }),
    signature, // 지정 시 서명 강제(잘못된 서명 재현용)
    contentType = 'application/json', // null 이면 헤더 생략
  } = opts;

  const sig = signature ?? sign(secret, ts, nonce, body);

  const headers = {
    'x-device-id': deviceId,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': sig,
  };
  if (contentType !== null) headers['content-type'] = contentType;

  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}/mobile-events/ping`, {
      method: 'POST',
      headers,
      body,
    });
  } catch (err) {
    assert(false, 'ping 요청 실패 — 서버 연결 불가', err?.message);
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

// =============================================================================
async function main() {
  console.log(`Phase 2 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  // ── 1) userA 회원가입 + 가족 생성 ─────────────────────────────────────────
  step(1, 'userA 회원가입 + 가족 생성 → accessToken, householdId 확보');
  const userA = await registerUser('device-owner-a');
  const created = await req('POST', '/households', {
    token: userA.token,
    body: { name: `장치검증 가족 ${RUN}` },
  });
  assert(created.status >= 200 && created.status < 300, '가족 생성 2xx', created.status);
  const householdId = created.json?.id;
  assert(typeof householdId === 'string' && householdId.length > 0, '가족 id 반환');

  // ── 2) 장치 등록 → raw secret 1회 수신, deviceId 확보 ──────────────────────
  step(2, '장치 등록 → raw secret(1회) 수신, deviceId 확보');
  const reg = await req('POST', '/devices/register', {
    token: userA.token,
    body: { householdId, name: 'A의 아이폰', platform: 'ios' },
  });
  assert(reg.status === 201, '장치 등록 201', reg.status);
  const deviceId = reg.json?.deviceId;
  const secret1 = reg.json?.secret;
  assert(typeof deviceId === 'string' && deviceId.length > 0, 'deviceId 반환');
  assert(typeof secret1 === 'string' && secret1.length > 0, 'raw secret 1회 노출');
  assert(reg.json?.algorithm === 'HMAC-SHA256', "algorithm === 'HMAC-SHA256'", reg.json?.algorithm);
  assert(typeof reg.json?.signingRecipe === 'string', 'signingRecipe 안내 문자열 반환');
  assert(reg.json?.device?.id === deviceId, 'device.id === deviceId');
  assert(reg.json?.device?.status === 'active', '등록 장치 status active', reg.json?.device?.status);

  // 장치 목록에 등록 장치가 노출되고, credential material 은 포함되지 않는다.
  const list = await req('GET', `/devices?householdId=${householdId}`, { token: userA.token });
  assert(list.status === 200, '장치 목록 200', list.status);
  const devices = Array.isArray(list.json) ? list.json : [];
  const listed = devices.find((d) => d?.id === deviceId);
  assert(!!listed, '목록에 등록 장치 존재');
  assert(
    listed !== undefined && !('secret' in listed) && !('secretCiphertext' in listed),
    '목록 응답에 secret/암호문 미포함',
  );

  // ── 3) 정상 서명 ping → 200 ────────────────────────────────────────────────
  step(3, '정상 서명 ping → 200(authenticated, deviceId/householdId 일치)');
  const ok = await ping({ deviceId, secret: secret1 });
  assert(ok.status === 200, '정상 서명 ping 200', ok.status);
  assert(ok.json?.authenticated === true, 'authenticated === true', ok.json?.authenticated);
  assert(ok.json?.deviceId === deviceId, '응답 deviceId 일치');
  assert(ok.json?.householdId === householdId, '응답 householdId 일치');
  assert(typeof ok.json?.receivedAt === 'string', 'receivedAt ISO 문자열 반환');

  // ── 4) 잘못된 서명 → 401 ───────────────────────────────────────────────────
  step(4, '잘못된 서명 → 401');
  // 올바른 길이(64 hex)지만 값이 다른 서명을 주입한다(timingSafeEqual 불일치 → 401).
  const tamperedSig = sign(secret1, nowSec(), newNonce(), 'tampered-payload');
  const badSig = await ping({ deviceId, secret: secret1, signature: tamperedSig });
  assert(badSig.status === 401, '잘못된 서명 401', badSig.status);

  // ── 5) 만료 Timestamp(now-600s) → 401 ─────────────────────────────────────
  step(5, '만료 timestamp(now-600s, 기본 허용오차 300s 초과) → 401');
  const expiredTs = (Math.floor(Date.now() / 1000) - 600).toString();
  // 서명 자체는 만료 ts 로 정확히 계산한다(실패 원인은 오직 timestamp 만료).
  const expired = await ping({ deviceId, secret: secret1, ts: expiredTs });
  assert(expired.status === 401, '만료 timestamp 401', expired.status);

  // ── 6) Nonce 재사용 → 2번째 401 ────────────────────────────────────────────
  step(6, 'Nonce 재사용(동일 nonce 2회) → 1번째 200, 2번째 401(replay 차단)');
  const replayTs = nowSec();
  const replayNonce = newNonce();
  const replayBody = JSON.stringify({ source: 'verify-phase2', case: 'replay' });
  const first = await ping({ deviceId, secret: secret1, ts: replayTs, nonce: replayNonce, body: replayBody });
  assert(first.status === 200, 'nonce 최초 사용 200', first.status);
  const second = await ping({ deviceId, secret: secret1, ts: replayTs, nonce: replayNonce, body: replayBody });
  assert(second.status === 401, 'nonce 재사용 401', second.status);

  // ── 7) Secret 회전 → 옛 secret 401, 새 secret 200 ─────────────────────────
  step(7, 'Secret 회전 → 옛 secret 서명 401, 새 secret 서명 200');
  const rotate = await req('POST', `/devices/${deviceId}/rotate-secret`, { token: userA.token });
  assert(rotate.status === 200, 'secret 회전 200', rotate.status);
  const secret2 = rotate.json?.secret;
  assert(typeof secret2 === 'string' && secret2.length > 0, '회전 새 secret 1회 노출');
  assert(secret2 !== secret1, '새 secret 이 이전과 다름');

  const oldAfterRotate = await ping({ deviceId, secret: secret1 });
  assert(oldAfterRotate.status === 401, '회전 후 옛 secret 서명 401', oldAfterRotate.status);
  const newAfterRotate = await ping({ deviceId, secret: secret2 });
  assert(newAfterRotate.status === 200, '회전 후 새 secret 서명 200', newAfterRotate.status);

  // ── 8) 권한: userB 가 userA 장치 rotate/delete → 403 ──────────────────────
  //  (장치가 아직 active 인 상태에서 검증. 권한은 서비스 계층 actorUserId 로 강제.)
  step(8, '권한: userB(비소유자)가 userA 장치 rotate/delete → 403');
  const userB = await registerUser('device-user-b');
  const bRotate = await req('POST', `/devices/${deviceId}/rotate-secret`, { token: userB.token });
  assert(bRotate.status === 403, '남의 장치 rotate 403', bRotate.status);
  const bDelete = await req('DELETE', `/devices/${deviceId}`, { token: userB.token });
  assert(bDelete.status === 403, '남의 장치 delete 403', bDelete.status);

  // ── 9) 폐기 장치: DELETE 후 정상 서명도 401 ────────────────────────────────
  step(9, '폐기 장치: userA DELETE → 이후 정상 서명(새 secret)도 401');
  const del = await req('DELETE', `/devices/${deviceId}`, { token: userA.token });
  assert(del.status === 200, '장치 폐기 200', del.status);
  const afterRevoke = await ping({ deviceId, secret: secret2 });
  assert(afterRevoke.status === 401, '폐기 장치 정상 서명도 401', afterRevoke.status);

  // ── 10) (선택) 잘못된 Content-Type / body 초과 ─────────────────────────────
  // 환경(bodyLimit 등)에 민감하므로 비치명적 검사(softCheck)로 다룬다.
  step(10, '(선택) 잘못된 Content-Type → 401/415, body 초과 → 413');
  const optReg = await req('POST', '/devices/register', {
    token: userA.token,
    body: { householdId, name: 'A의 안드로이드', platform: 'android' },
  });
  if (optReg.status === 201 && typeof optReg.json?.deviceId === 'string') {
    const optDeviceId = optReg.json.deviceId;
    const optSecret = optReg.json.secret;

    // (a) 잘못된 Content-Type: 서명은 유효하지만 content-type 이 json 이 아님.
    const wrongCt = await ping({
      deviceId: optDeviceId,
      secret: optSecret,
      contentType: 'text/plain',
    });
    softCheck(
      wrongCt.status === 401 || wrongCt.status === 415,
      '잘못된 Content-Type → 401 또는 415',
      wrongCt.status,
    );

    // (b) body 초과: 기본 bodyLimit(16384) 초과 → Fastify 413(가드 도달 전).
    const oversizedBody = JSON.stringify({ source: 'verify-phase2', pad: 'x'.repeat(20000) });
    const oversized = await ping({
      deviceId: optDeviceId,
      secret: optSecret,
      body: oversizedBody,
    });
    softCheck(oversized.status === 413, 'body 초과 → 413', oversized.status);

    // 정리(best-effort): 선택 테스트용 장치 폐기.
    await req('DELETE', `/devices/${optDeviceId}`, { token: userA.token });
  } else {
    console.log('  · (선택) 추가 장치 등록 실패로 선택 시나리오 건너뜀', optReg.status);
  }

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). Secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
