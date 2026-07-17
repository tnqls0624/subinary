#!/usr/bin/env node
// =============================================================================
// verify-card-sms-token.mjs — 카드 문자 토큰 수집(단축어/MacroDroid) e2e 검증
// -----------------------------------------------------------------------------
// docs/addendum-card-sms-token-ingest.md §6 시나리오(1~7)를 실 스택 대상으로
// 실행한다. Node 내장 fetch + node:crypto 만 사용(외부 의존성 없음).
//
// HMAC 경로(verify-phase3.mjs)와 달리 서명 계산이 없다 — 단축어(iOS)/MacroDroid
// (Android)가 흉내낼 수 있는 "고정 헤더 + JSON POST"만 사용한다:
//
//   POST /v1/mobile-events/card-sms-token
//   Authorization: Bearer <collectToken>        ← 등록/회전 응답에서 1회 노출된 raw 토큰
//   Content-Type:  application/json
//   body:          { eventId, sender, content, receivedAt }   (cardSmsIngestRequest)
//
// 인증은 DeviceTokenGuard 가 `sha256(token)` 을 `registered_devices.collect_token_hash`
// (status='active')와 매칭해 처리한다. 실패는 원인 비노출 일반 401.
//
// 파싱은 BullMQ 워커에서 **비동기**로 처리되므로, 파싱 상태/결과는 최대 10초 폴링한다
// (GET /v1/card-sms-events, 사용자 Bearer). 멱등은 HMAC 경로와 동일하게
// CardSmsIngestService.ingest 의 UNIQUE(deviceId,eventId) 로 보장된다.
//
// 검증 시나리오(addendum §6):
//   1) userA 회원가입 + 가족 생성 + 장치 등록 → 등록 응답에 collectToken(1회 노출) 존재.
//   2) 유효 토큰 + 신한 승인 문자 → 200 accepted, processingStatus='queued'.
//   3) 폴링(≤10s): parseStatus='parsed', amount=12500(KRW 정수), type='approval', 가맹점 일치.
//   4) 동일 eventId 재전송 → duplicate:true(멱등), 목록에 중복 저장 없음.
//   5) 잘못된 토큰 → 401. Bearer 헤더 없음 → 401.
//   6) rotate-secret → 새 collectToken 발급. 옛 토큰 401 / 새 토큰 200.
//   7) revoke device → (현재) 토큰 401.
//
// 실행법:
//   1) 전체 스택 기동(진행자가 사전 수행): docker compose up -d --build
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-card-sms-token.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-card-sms-token.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
//
// 로그에는 카드 문자 원문 전체 / collect 토큰 원문·해시 / secret / 비밀번호를 출력하지
// 않는다(PRD §11 — 운영 로그엔 eventId/상태만). 실패 상세는 비민감 정보(상태코드 등)만 남긴다.
// =============================================================================

import { randomBytes } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌(409)을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// 비동기 파싱 폴링 상한(addendum §0/§6 = 10초) + 폴링 간격.
const PARSE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

let passed = 0;
let failed = 0;

// ── 샘플 카드 문자(파서 포맷과 일치, packages/card-parsers 실제 구현 기준) ─────
// 신한: content 에 '신한' 포함(ShinhanCardParser.supports), '승인' 키워드,
//       금액 `12,500원`→12500(BaseCardParser.parseAmount: 콤마 제거 후 정수 검증),
//       `MM/DD HH:mm`→occurredAt(Asia/Seoul), 가맹점=타임스탬프 뒤 토큰='스타벅스'.
const SAMPLE = {
  shinhanApproval: {
    sender: '15447200',
    content: '신한카드 승인 12,500원 일시불 07/15 19:32 스타벅스',
    expect: { transactionType: 'approval', amount: 12500, merchant: '스타벅스' },
  },
};

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
    // extra 는 상태코드/파싱상태 등 비민감 정보만 전달한다(원문/토큰/secret 금지).
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

/**
 * HTTP 헬퍼. body 가 있으면 JSON 직렬화(+ Content-Type), token 이 있으면 `Bearer <token>`
 * 을 Authorization 으로 전송한다. token 을 생략하면 Authorization 헤더 자체를 붙이지 않는다.
 * 사용자 Bearer(accessToken)와 장치 collect 토큰(Bearer) 모두 동일 헬퍼를 쓴다.
 * 반환: { status, json }.
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
    await sleep(1000);
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

/**
 * 토큰 수집 요청(POST /v1/mobile-events/card-sms-token, DeviceTokenGuard 경유).
 * collectToken 이 undefined 면 Authorization 헤더 없이 전송한다(§6-5 Bearer 없음 검증용).
 * 반환: { status, json }.
 */
function ingestWithToken(collectToken, { eventId, sender, content, receivedAt }) {
  return req('POST', '/mobile-events/card-sms-token', {
    token: collectToken,
    body: { eventId, sender, content, receivedAt },
  });
}

/**
 * 목록 응답에서 배열을 추출한다. 조회 API 가 bare 배열([...]) 또는
 * 페이지네이션 래퍼({ items:[...] } / { data:[...] })로 응답해도 안전하게 처리한다.
 */
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

/** 가족의 카드 문자 이벤트 목록(summary). 사용자 Bearer 필요. */
async function listEvents(token, householdId) {
  const qs = new URLSearchParams({ householdId });
  const res = await req('GET', `/card-sms-events?${qs.toString()}`, { token });
  return { status: res.status, list: extractList(res.json), raw: res.json };
}

/**
 * eventId 로 이벤트가 파싱 종료 상태(pending 이 아닌 상태)에 도달할 때까지 폴링(≤10s).
 * 반환: 해당 이벤트 summary(없으면 마지막 관측 상태와 함께 null).
 */
async function pollUntilParsed(token, householdId, eventId) {
  const deadline = Date.now() + PARSE_TIMEOUT_MS;
  let lastStatus = 'not-listed';
  while (Date.now() < deadline) {
    const { status, list } = await listEvents(token, householdId);
    if (status === 200) {
      const found = list.find((e) => e?.eventId === eventId);
      if (found) {
        lastStatus = found.parseStatus;
        if (found.parseStatus && found.parseStatus !== 'pending') return { event: found };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { event: null, lastStatus };
}

/** KRW 정수 금액 공통 검증. */
function assertAmountKrw(ev, expectedAmount, label) {
  assert(Number.isInteger(ev?.amount), `${label} amount 는 정수(KRW, 부동소수 아님)`, ev?.amount);
  assert(ev?.amount === expectedAmount, `${label} amount === ${expectedAmount}`, ev?.amount);
  assert(ev?.currency === 'KRW', `${label} currency === 'KRW'`, ev?.currency);
}

// =============================================================================
async function main() {
  console.log(`카드 문자 토큰 수집 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  // ── 1) userA 회원가입 + 가족 생성 + 장치 등록 → collectToken 1회 노출 ──────
  step(1, 'userA 회원가입 + 가족 생성 + 장치 등록 → 응답에 collectToken(1회 노출) 존재');
  const userA = await registerUser('token-owner-a');
  const created = await req('POST', '/households', {
    token: userA.token,
    body: { name: `토큰검증 가족 ${RUN}` },
  });
  assert(created.status >= 200 && created.status < 300, '가족 생성 2xx', created.status);
  const householdId = created.json?.id;
  assert(typeof householdId === 'string' && householdId.length > 0, '가족 id 반환');

  const reg = await req('POST', '/devices/register', {
    token: userA.token,
    body: { householdId, name: 'A의 아이폰(단축어)', platform: 'ios' },
  });
  assert(reg.status === 201, '장치 등록 201', reg.status);
  const deviceId = reg.json?.deviceId;
  assert(typeof deviceId === 'string' && deviceId.length > 0, 'deviceId 반환');
  // HMAC secret 은 그대로 병행 노출(기존 경로 유지) — 값은 로그하지 않는다.
  assert(typeof reg.json?.secret === 'string' && reg.json.secret.length > 0, 'HMAC raw secret 병행 노출(값 미노출)');
  // 토큰 경로의 핵심: collectToken 이 등록 응답에 1회 노출된다(값은 로그하지 않는다).
  const collectToken = reg.json?.collectToken;
  assert(typeof collectToken === 'string' && collectToken.length > 0, '등록 응답에 collectToken 포함(1회 노출, 값 미노출)');

  const receivedAt = new Date().toISOString();

  // ── 2) 유효 토큰 + 신한 승인 문자 → 200 accepted queued ───────────────────
  step(2, '유효 collectToken(Bearer) + 신한 승인 문자 → 200 accepted, processingStatus=queued');
  const approvalEventId = `evt-token-shinhan-approval-${RUN}`;
  const ing = await ingestWithToken(collectToken, {
    eventId: approvalEventId,
    sender: SAMPLE.shinhanApproval.sender,
    content: SAMPLE.shinhanApproval.content,
    receivedAt,
  });
  assert(ing.status === 200, '수집 응답 200', ing.status);
  assert(ing.json?.accepted === true, 'accepted === true', ing.json?.accepted);
  assert(ing.json?.eventId === approvalEventId, '응답 eventId 일치');
  assert(ing.json?.processingStatus === 'queued', "processingStatus === 'queued'", ing.json?.processingStatus);
  assert(ing.json?.duplicate === false, 'duplicate === false(신규 수집)', ing.json?.duplicate);

  // ── 3) 비동기 파싱 결과 폴링(≤10s) → parsed + 금액/유형/가맹점 정확 ─────────
  step(3, '비동기 파싱 폴링(≤10s) → parseStatus=parsed, amount 정수, type=approval, 가맹점 일치');
  const { event: approvalEv, lastStatus: aLast } = await pollUntilParsed(userA.token, householdId, approvalEventId);
  assert(approvalEv !== null, '10초 내 신한 승인 파싱 완료(목록 조회 가능)', aLast);
  assert(approvalEv.parseStatus === 'parsed', "parseStatus === 'parsed'", approvalEv.parseStatus);
  assert(
    approvalEv.transactionType === SAMPLE.shinhanApproval.expect.transactionType,
    "transactionType === 'approval'",
    approvalEv.transactionType,
  );
  assertAmountKrw(approvalEv, SAMPLE.shinhanApproval.expect.amount, '신한 승인');
  assert(
    typeof approvalEv.merchantRaw === 'string' &&
      approvalEv.merchantRaw.includes(SAMPLE.shinhanApproval.expect.merchant),
    `merchantRaw 에 '${SAMPLE.shinhanApproval.expect.merchant}' 포함`,
    approvalEv.merchantRaw,
  );

  // ── 4) 동일 eventId 재전송 → 멱등(duplicate:true, 중복 저장 없음) ──────────
  step(4, '동일 eventId 재전송 → duplicate:true(멱등, CardSmsIngestService 재사용), 목록에 중복 저장 없음');
  const resend = await ingestWithToken(collectToken, {
    eventId: approvalEventId,
    sender: SAMPLE.shinhanApproval.sender,
    content: SAMPLE.shinhanApproval.content,
    receivedAt,
  });
  assert(resend.status === 200, '재전송 응답 200(멱등 성공)', resend.status);
  assert(resend.json?.accepted === true, '재전송 accepted === true', resend.json?.accepted);
  assert(resend.json?.duplicate === true, 'duplicate === true(멱등)', resend.json?.duplicate);
  assert(
    resend.json?.processingStatus === 'duplicate',
    "processingStatus === 'duplicate'",
    resend.json?.processingStatus,
  );

  const afterResend = await listEvents(userA.token, householdId);
  assert(afterResend.status === 200, '재전송 후 목록 조회 200', afterResend.status);
  const dupCount = afterResend.list.filter((e) => e?.eventId === approvalEventId).length;
  assert(dupCount === 1, '동일 eventId 이벤트는 정확히 1건(중복 저장 없음)', dupCount);

  // ── 5) 잘못된 토큰 → 401, Bearer 없음 → 401 ───────────────────────────────
  step(5, '잘못된 토큰 → 401, Bearer 헤더 없음 → 401(원인 비노출 일반 401)');
  // 형식만 유효한(64 hex) 임의 토큰 — DB 어느 장치와도 매칭되지 않는다.
  const bogusToken = randomBytes(32).toString('hex');
  const badTokenRes = await ingestWithToken(bogusToken, {
    eventId: `evt-token-bad-${RUN}`,
    sender: SAMPLE.shinhanApproval.sender,
    content: SAMPLE.shinhanApproval.content,
    receivedAt,
  });
  assert(badTokenRes.status === 401, '잘못된 토큰 → 401', badTokenRes.status);

  // token 미전달 → Authorization 헤더 자체가 없음(단축어가 헤더를 빠뜨린 상황).
  const noBearerRes = await ingestWithToken(undefined, {
    eventId: `evt-token-nobearer-${RUN}`,
    sender: SAMPLE.shinhanApproval.sender,
    content: SAMPLE.shinhanApproval.content,
    receivedAt,
  });
  assert(noBearerRes.status === 401, 'Bearer 헤더 없음 → 401', noBearerRes.status);

  // ── 6) rotate-secret → 새 collectToken. 옛 토큰 401 / 새 토큰 200 ──────────
  step(6, 'rotate-secret → 새 collectToken 발급. 옛 토큰 401(즉시 무효화) / 새 토큰 200');
  const rotated = await req('POST', `/devices/${deviceId}/rotate-secret`, { token: userA.token });
  assert(rotated.status === 200, 'rotate-secret 200', rotated.status);
  const rotatedToken = rotated.json?.collectToken;
  assert(typeof rotatedToken === 'string' && rotatedToken.length > 0, '회전 응답에 새 collectToken 포함(1회 노출, 값 미노출)');
  // 새 토큰이 옛 토큰과 다름을 값 노출 없이 확인한다.
  assert(rotatedToken !== collectToken, '회전 후 collectToken 이 이전과 다름(회전됨)');

  // 옛 토큰은 즉시 무효 — 신규 eventId 로 시도해도 401(중복이 아니라 인증 실패).
  const oldTokenRes = await ingestWithToken(collectToken, {
    eventId: `evt-token-old-after-rotate-${RUN}`,
    sender: SAMPLE.shinhanApproval.sender,
    content: SAMPLE.shinhanApproval.content,
    receivedAt,
  });
  assert(oldTokenRes.status === 401, '회전 후 옛 collectToken → 401', oldTokenRes.status);

  // 새 토큰은 정상 수락 — 신규 eventId 로 queued 200.
  const newTokenEventId = `evt-token-new-after-rotate-${RUN}`;
  const newTokenRes = await ingestWithToken(rotatedToken, {
    eventId: newTokenEventId,
    sender: SAMPLE.shinhanApproval.sender,
    content: SAMPLE.shinhanApproval.content,
    receivedAt,
  });
  assert(newTokenRes.status === 200, '회전 후 새 collectToken → 200', newTokenRes.status);
  assert(newTokenRes.json?.processingStatus === 'queued', "새 토큰 수집 processingStatus === 'queued'", newTokenRes.json?.processingStatus);
  assert(newTokenRes.json?.duplicate === false, '새 토큰 수집 duplicate === false(신규 eventId)', newTokenRes.json?.duplicate);

  // ── 7) revoke device → (현재) 토큰 401 ────────────────────────────────────
  step(7, 'revoke device(status=revoked) → 현재 collectToken 도 401(guard 가 status 검사)');
  const revoked = await req('DELETE', `/devices/${deviceId}`, { token: userA.token });
  assert(revoked.status === 200, 'revoke device 200', revoked.status);
  assert(revoked.json?.revoked === true, 'revoked === true', revoked.json?.revoked);

  const afterRevokeRes = await ingestWithToken(rotatedToken, {
    eventId: `evt-token-after-revoke-${RUN}`,
    sender: SAMPLE.shinhanApproval.sender,
    content: SAMPLE.shinhanApproval.content,
    receivedAt,
  });
  assert(afterRevokeRes.status === 401, '폐기 장치 collectToken → 401', afterRevokeRes.status);

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). 원문/토큰/secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
