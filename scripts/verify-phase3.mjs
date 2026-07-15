#!/usr/bin/env node
// =============================================================================
// verify-phase3.mjs — Phase 3(카드 문자 수집 & 파싱) 완료 조건 e2e 검증
// -----------------------------------------------------------------------------
// docs/phase3-build-spec.md §8.2 시나리오(1~9)를 실 스택 대상으로 실행한다.
// Node 내장 fetch + node:crypto 만 사용(외부 의존성 없음).
//
// 장치 HMAC 서명 프로토콜(Phase 2 §1.2 / verify-phase2.mjs 와 동일):
//   서명 대상 payload = `${X-Timestamp}.${X-Nonce}.${rawBody}`  (원본 바이트)
//   X-Signature       = HMAC-SHA256(secret, payload) 의 hex digest
//   요청 body 는 서명한 bodyString 과 **정확히 동일 바이트**로 전송한다
//   (JSON.stringify 결과 문자열을 그대로 fetch body 로 사용).
//   헤더: X-Device-Id / X-Timestamp / X-Nonce / X-Signature, Content-Type application/json.
//
// 파싱은 BullMQ 워커에서 **비동기**로 처리되므로, 파싱 상태/결과는 최대 10초 폴링한다
// (GET /v1/card-sms-events). 폴링 대상은 수집 응답의 eventId(장치 이벤트 id 문자열)이다.
//
// 검증 시나리오(스펙 §8.2):
//   1) userA 회원가입 + 가족 생성 + 장치 등록(raw secret 1회 수신).
//   2) 신한 승인 문자 전송(HMAC) → 200 accepted queued.
//   3) 폴링(≤10s): parseStatus='parsed', amount=12500(KRW 정수), type='approval', 가맹점 일치.
//   4) 동일 eventId 재전송 → duplicate:true(멱등), 목록에 중복 저장 없음.
//   5) 신한 취소 문자 → parsed, transactionType='cancellation'.
//   6) KB 승인 문자 → parsed, amount=8900, 가맹점 일치.
//   7) 비카드(파싱 불가) 문자 → parse_failed, 상세 조회로 원문 확인 가능.
//   8) 보안: userB(비멤버)가 card-sms-events?householdId=A 조회 → 403.
//   9) 금액 정수/통화 KRW 검증(각 파싱 결과에 대해 재확인).
//
// 실행법:
//   1) 전체 스택 기동(진행자가 사전 수행): docker compose up -d --build
//   2) api 준비 확인: curl -s http://localhost:3001/v1/health/live
//   3) node scripts/verify-phase3.mjs
//      # 다른 호스트/포트: API_BASE_URL=http://localhost:3001 node scripts/verify-phase3.mjs
//
// 종료 코드: 전부 통과 → 0, 하나라도 실패 → 1(첫 실패 지점에서 즉시 종료).
//
// 로그에는 원문 전체 / secret 원문·암호문 / 서명 / 토큰 / 비밀번호를 출력하지 않는다
// (PRD §11 — 운영 로그엔 eventId/해시/상태만). 실패 상세는 비민감 정보(상태코드 등)만 남긴다.
// =============================================================================

import { createHmac, randomBytes } from 'node:crypto';

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const PREFIX = '/v1';

// 재실행 시 이메일 UNIQUE 충돌(409)을 피하기 위한 실행별 접미사.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Passw0rd!123';

// 비동기 파싱 폴링 상한(스펙 §0/§8.2 = 10초) + 폴링 간격.
const PARSE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

let passed = 0;
let failed = 0;

// ── 샘플 카드 문자(파서 포맷과 일치해야 함, 스펙 §3.1) ───────────────────────
// 신한: content 에 '신한' 포함, '승인'/'취소' 키워드, 금액 `12,500원`→12500,
//       `MM/DD HH:mm`→occurredAt(Asia/Seoul), 가맹점=문자 말미 토큰, 할부('일시불'→1개월).
// KB  : content 에 'KB'/'국민' 포함, 동일 필드 추출.
// 비카드: 카드사 키워드가 없어 어떤 파서도 supports 하지 않음 → transactionType='unknown'
//         → parse_failed(스펙 §6.4).
const SAMPLE = {
  shinhanApproval: {
    sender: '15447200',
    content: '신한카드 승인 12,500원 일시불 07/15 19:32 스타벅스',
    expect: { transactionType: 'approval', amount: 12500, merchant: '스타벅스' },
  },
  shinhanCancellation: {
    sender: '15447200',
    content: '신한카드 취소 12,500원 07/15 20:00 스타벅스',
    expect: { transactionType: 'cancellation', amount: 12500, merchant: '스타벅스' },
  },
  kookminApproval: {
    sender: '15881688',
    content: 'KB국민카드 승인 8,900원 07/15 12:10 김밥천국',
    expect: { transactionType: 'approval', amount: 8900, merchant: '김밥천국' },
  },
  // 카드사·거래 키워드가 없는 일반 안내 문자(인증번호). 어떤 파서도 매칭되지 않는다.
  nonCard: {
    sender: '15880000',
    content: '[Web발신] 인증번호 [572913] 를 입력해 주세요. 타인에게 알려주지 마세요.',
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
    // extra 는 상태코드/파싱상태 등 비민감 정보만 전달한다(원문/secret/서명 금지).
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
 * 사용자 인증(Bearer) HTTP 헬퍼. body 가 있으면 JSON 직렬화, token 이 있으면 Bearer 전송.
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

// ── 장치 HMAC 서명 헬퍼(클라이언트 측, verify-phase2.mjs 재사용) ─────────────

/** 현재 epoch seconds(문자열). X-Timestamp 는 정수 epoch seconds 문자열(Phase 2 §4.4). */
function nowSec() {
  return Math.floor(Date.now() / 1000).toString();
}

/** 매 요청 고유한 nonce(replay 차단 통과용). */
function newNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * 서명 레시피(Phase 2 §6):
 *   sign(secret, tsSec, nonce, bodyString) = HMAC-SHA256(secret, `${tsSec}.${nonce}.${bodyString}`) hex
 */
function sign(secret, tsSec, nonce, bodyString) {
  return createHmac('sha256', secret).update(`${tsSec}.${nonce}.${bodyString}`).digest('hex');
}

/**
 * 카드 문자 수집 요청(POST /v1/mobile-events/card-sms, HMAC 가드 경유).
 * body 는 서명한 bodyString 과 **동일 바이트**로 전송한다. 반환: { status, json }.
 */
async function ingestCardSms({ deviceId, secret }, { eventId, sender, content, receivedAt }) {
  const ts = nowSec();
  const nonce = newNonce();
  const body = JSON.stringify({ eventId, sender, content, receivedAt });
  const sig = sign(secret, ts, nonce, body);

  const headers = {
    'content-type': 'application/json',
    'x-device-id': deviceId,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': sig,
  };

  let res;
  try {
    res = await fetch(`${BASE}${PREFIX}/mobile-events/card-sms`, { method: 'POST', headers, body });
  } catch (err) {
    assert(false, 'card-sms 수집 요청 실패 — 서버 연결 불가', err?.message);
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

/**
 * 목록 응답에서 배열을 추출한다. P4 조회 API 가 bare 배열([...]) 또는
 * 페이지네이션 래퍼({ items:[...] } / { data:[...] })로 응답해도 안전하게 처리한다.
 */
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

/** 가족의 카드 문자 이벤트 목록(summary). status 필터는 옵션. */
async function listEvents(token, householdId, status) {
  const qs = new URLSearchParams({ householdId });
  if (status) qs.set('status', status);
  const res = await req('GET', `/card-sms-events?${qs.toString()}`, { token });
  return { status: res.status, list: extractList(res.json), raw: res.json };
}

/**
 * eventId 로 이벤트가 파싱 종료 상태(pending 이 아닌 상태)에 도달할 때까지 폴링(≤10s).
 * 반환: 해당 이벤트 summary(없으면 마지막 관측 정보와 함께 null).
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

/** KRW 정수 금액 공통 검증(스펙 §9). */
function assertAmountKrw(ev, expectedAmount, label) {
  assert(Number.isInteger(ev?.amount), `${label} amount 는 정수(KRW, 부동소수 아님)`, ev?.amount);
  assert(ev?.amount === expectedAmount, `${label} amount === ${expectedAmount}`, ev?.amount);
  assert(ev?.currency === 'KRW', `${label} currency === 'KRW'`, ev?.currency);
}

// =============================================================================
async function main() {
  console.log(`Phase 3 검증 시작 — 대상 ${BASE}${PREFIX} (run=${RUN})`);
  await waitForApi();

  // ── 1) userA 회원가입 + 가족 생성 + 장치 등록 ─────────────────────────────
  step(1, 'userA 회원가입 + 가족 생성 + 장치 등록(raw secret 1회 수신)');
  const userA = await registerUser('card-owner-a');
  const created = await req('POST', '/households', {
    token: userA.token,
    body: { name: `카드검증 가족 ${RUN}` },
  });
  assert(created.status >= 200 && created.status < 300, '가족 생성 2xx', created.status);
  const householdId = created.json?.id;
  assert(typeof householdId === 'string' && householdId.length > 0, '가족 id 반환');

  const reg = await req('POST', '/devices/register', {
    token: userA.token,
    body: { householdId, name: 'A의 아이폰', platform: 'ios' },
  });
  assert(reg.status === 201, '장치 등록 201', reg.status);
  const device = { deviceId: reg.json?.deviceId, secret: reg.json?.secret };
  assert(typeof device.deviceId === 'string' && device.deviceId.length > 0, 'deviceId 반환');
  assert(typeof device.secret === 'string' && device.secret.length > 0, 'raw secret 1회 노출');

  const receivedAt = new Date().toISOString();

  // ── 2) 신한 승인 문자 수집(HMAC) → 200 accepted queued ─────────────────────
  step(2, '신한 승인 문자 수집(HMAC 서명) → 200 accepted, processingStatus=queued');
  const approvalEventId = `evt-shinhan-approval-${RUN}`;
  const ing = await ingestCardSms(device, {
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
  assert(typeof approvalEv.occurredAt === 'string' && approvalEv.occurredAt.length > 0, 'occurredAt ISO 문자열 존재');
  assert(
    Number.isInteger(approvalEv.confidence) && approvalEv.confidence >= 0 && approvalEv.confidence <= 100,
    'confidence 0~100 정수',
    approvalEv.confidence,
  );

  // status 필터(parsed)로도 노출되는지 확인(검토용 필터 동작).
  const parsedFiltered = await listEvents(userA.token, householdId, 'parsed');
  assert(parsedFiltered.status === 200, 'status=parsed 필터 조회 200', parsedFiltered.status);
  assert(
    parsedFiltered.list.some((e) => e?.eventId === approvalEventId),
    'status=parsed 필터 목록에 신한 승인 포함',
  );

  // ── 4) 동일 eventId 재전송 → 멱등(duplicate:true, 중복 저장 없음) ──────────
  step(4, '동일 eventId 재전송 → duplicate:true(멱등), 목록에 중복 저장 없음');
  const resend = await ingestCardSms(device, {
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

  // ── 5) 신한 취소 문자 → parsed, transactionType=cancellation ───────────────
  step(5, '신한 취소 문자 → parsed, transactionType=cancellation');
  const cancelEventId = `evt-shinhan-cancel-${RUN}`;
  const cancelIng = await ingestCardSms(device, {
    eventId: cancelEventId,
    sender: SAMPLE.shinhanCancellation.sender,
    content: SAMPLE.shinhanCancellation.content,
    receivedAt,
  });
  assert(cancelIng.status === 200, '취소 문자 수집 200', cancelIng.status);
  assert(cancelIng.json?.duplicate === false, '취소 문자 신규 수집', cancelIng.json?.duplicate);
  const { event: cancelEv, lastStatus: cLast } = await pollUntilParsed(userA.token, householdId, cancelEventId);
  assert(cancelEv !== null, '10초 내 신한 취소 파싱 완료', cLast);
  assert(cancelEv.parseStatus === 'parsed', "취소 parseStatus === 'parsed'", cancelEv.parseStatus);
  assert(
    cancelEv.transactionType === SAMPLE.shinhanCancellation.expect.transactionType,
    "transactionType === 'cancellation'",
    cancelEv.transactionType,
  );
  assertAmountKrw(cancelEv, SAMPLE.shinhanCancellation.expect.amount, '신한 취소');

  // ── 6) KB 승인 문자 → parsed ───────────────────────────────────────────────
  step(6, 'KB국민카드 승인 문자 → parsed, amount 정수, 가맹점 일치');
  const kbEventId = `evt-kb-approval-${RUN}`;
  const kbIng = await ingestCardSms(device, {
    eventId: kbEventId,
    sender: SAMPLE.kookminApproval.sender,
    content: SAMPLE.kookminApproval.content,
    receivedAt,
  });
  assert(kbIng.status === 200, 'KB 문자 수집 200', kbIng.status);
  assert(kbIng.json?.duplicate === false, 'KB 문자 신규 수집', kbIng.json?.duplicate);
  const { event: kbEv, lastStatus: kLast } = await pollUntilParsed(userA.token, householdId, kbEventId);
  assert(kbEv !== null, '10초 내 KB 승인 파싱 완료', kLast);
  assert(kbEv.parseStatus === 'parsed', "KB parseStatus === 'parsed'", kbEv.parseStatus);
  assert(
    kbEv.transactionType === SAMPLE.kookminApproval.expect.transactionType,
    "KB transactionType === 'approval'",
    kbEv.transactionType,
  );
  assertAmountKrw(kbEv, SAMPLE.kookminApproval.expect.amount, 'KB 승인');
  assert(
    typeof kbEv.merchantRaw === 'string' && kbEv.merchantRaw.includes(SAMPLE.kookminApproval.expect.merchant),
    `KB merchantRaw 에 '${SAMPLE.kookminApproval.expect.merchant}' 포함`,
    kbEv.merchantRaw,
  );

  // ── 7) 비카드(파싱 불가) 문자 → parse_failed, 상세로 원문 확인 ─────────────
  step(7, '비카드(파싱 불가) 문자 → parse_failed, 상세 조회로 원문 확인 가능');
  const failEventId = `evt-noncard-${RUN}`;
  const failIng = await ingestCardSms(device, {
    eventId: failEventId,
    sender: SAMPLE.nonCard.sender,
    content: SAMPLE.nonCard.content,
    receivedAt,
  });
  assert(failIng.status === 200, '비카드 문자 수집 200', failIng.status);
  const { event: failEv, lastStatus: fLast } = await pollUntilParsed(userA.token, householdId, failEventId);
  assert(failEv !== null, '10초 내 비카드 문자 파싱 시도 완료', fLast);
  assert(failEv.parseStatus === 'parse_failed', "parseStatus === 'parse_failed'", failEv.parseStatus);

  // 상세 조회(GET /:id)로 원문(rawContent) 보존 확인.
  const detailRes = await req('GET', `/card-sms-events/${failEv.id}`, { token: userA.token });
  assert(detailRes.status === 200, '실패 이벤트 상세 조회 200', detailRes.status);
  assert(
    detailRes.json?.rawContent === SAMPLE.nonCard.content,
    '상세 rawContent 가 수집 원문과 일치(원문 보존)',
  );

  // parse_failed 필터로도 조회되는지 확인(검토 화면용).
  const failFiltered = await listEvents(userA.token, householdId, 'parse_failed');
  assert(failFiltered.status === 200, 'status=parse_failed 필터 조회 200', failFiltered.status);
  assert(
    failFiltered.list.some((e) => e?.eventId === failEventId),
    'status=parse_failed 필터 목록에 비카드 문자 포함',
  );

  // ── 8) 보안: userB(비멤버) 가 가족 A 이벤트 조회 → 403 ─────────────────────
  step(8, '보안: userB(비멤버)가 card-sms-events?householdId=A 조회 → 403');
  const userB = await registerUser('card-outsider-b');
  const bList = await req('GET', `/card-sms-events?householdId=${householdId}`, { token: userB.token });
  assert(bList.status === 403, '비멤버 목록 조회 403', bList.status);
  const bDetail = await req('GET', `/card-sms-events/${approvalEv.id}`, { token: userB.token });
  assert(bDetail.status === 403 || bDetail.status === 404, '비멤버 상세 조회 차단(403/404)', bDetail.status);

  // ── 9) 금액 정수/통화 KRW 재확인(스펙 §9) ─────────────────────────────────
  step(9, '금액 정수/통화 KRW 최종 재확인(모든 파싱 결과)');
  for (const [label, ev] of [
    ['신한 승인', approvalEv],
    ['신한 취소', cancelEv],
    ['KB 승인', kbEv],
  ]) {
    assert(Number.isInteger(ev?.amount), `${label} amount 정수`, ev?.amount);
    assert(ev?.currency === 'KRW', `${label} currency KRW`, ev?.currency);
  }

  // ── 완료 ──────────────────────────────────────────────────────────────────
  summary();
  console.log('\n모든 필수 시나리오 통과 ✅');
  process.exit(0);
}

main().catch((err) => {
  // 예기치 못한 예외(코드 버그 등). 원문/secret 미노출.
  console.error('\n예기치 못한 오류로 검증 중단:', err?.message ?? err);
  summary();
  process.exit(1);
});
