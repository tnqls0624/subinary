/**
 * 러너 키트: 결과 JSON. 브랜드 무관 — 허용 오류 코드·stage 거르기·untyped 오류 분류는 인자로 받는다.
 * 'operation_unknown'·'runtime_unavailable' 은 브랜드가 아니라 API 계약 공용 코드다.
 */

/** error.name 의 영문자만, 40자까지. message·stack·URL·화면 글자는 보지 않는다. */
export function sanitizeErrorName(error) {
  const raw = error && typeof error === 'object' && typeof error.name === 'string'
    ? error.name
    : '';
  const letters = raw.replace(/[^A-Za-z]/gu, '').slice(0, 40);
  return letters.length > 0 ? letters : null;
}

/**
 * 실패 JSON 의 공용부 { ok, error, reason?, errorName?, stage? } 를 이 키 순서로 만든다.
 * - error: allowedCodes 밖이면 operation_unknown
 * - reason: error 가 runtime_unavailable 이고 failureReason 이 있으면 그것, 아니면 classify(error) 의
 *   { reason, errorName }(null 이면 싣지 않는다)
 * - stage: 호출자가 자기 허용 목록으로 거른 값(없으면 싣지 않는다)
 * 레이아웃 진단은 브랜드마다 허용 토큰이 달라 여기서 받지 않는다. 진입 파일이 맨 뒤 키로 붙인다.
 */
export function buildFailurePayload({ error, code, allowedCodes, failureReason, stage, classify }) {
  const payload = { ok: false, error: allowedCodes?.has(code) ? code : 'operation_unknown' };
  if (failureReason && payload.error === 'runtime_unavailable') {
    payload.reason = failureReason;
  } else {
    const untyped = classify?.(error);
    if (untyped) {
      payload.reason = untyped.reason;
      if (untyped.errorName) payload.errorName = untyped.errorName;
    }
  }
  if (stage) payload.stage = stage;
  return payload;
}

/** 공백 없는 한 줄 JSON 하나만 쓴다(API 가 stdout 전체를 한 번에 해석한다). */
export function writeResult(payload, out = process.stdout) {
  out.write(JSON.stringify(payload));
}
