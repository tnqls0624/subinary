/**
 * LLM 전송 전 원문 마스킹 (ADR-0023 §7).
 *
 * **불변식: `maskForLlm(x).length === x.length`.** span 추출은 LLM이 마스킹본에서 고른
 * 인용구를 **원문**에서 다시 찾아 오프셋을 확정한다. 마스킹이 길이를 바꾸면 마스킹
 * 지점 이후의 모든 오프셋이 밀려 `resolveQuote`가 조용히 잘못된 구간을 잘라낸다 —
 * 검증기가 통과시키는 오류라 가장 위험하다. 그래서 숫자를 같은 길이의 `•`로만 바꾸고
 * 구분자는 그대로 둔다(치환 결과 길이가 정의상 원본과 같다).
 *
 * 마스킹 대상은 **장문 숫자 식별자**(카드번호·계좌번호·전화번호)뿐이다. 금액(`12,500원`)·
 * 날짜(`07/19`)·시각(`15:00`)·이미 마스킹된 뒤 4자리(`****1234`, `(1234)`)는 파싱에
 * 필요하므로 건드리지 않는다. `maskedCardNumber`는 LLM 응답에서 받지 않고 워커가
 * **원문에서 로컬 계산**하므로(spans.ts) 카드 숫자를 전부 가려도 기능 손실이 없다.
 */

/** 마스킹 문자. BMP 단일 코드유닛이라 `.length` 보존이 성립한다. */
const MASK_CHAR = '•';

/** 16자리 카드번호(구분자 유무 무관). */
const CARD_NUMBER_RE = /(?<!\d)\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?!\d)/g;
/**
 * 하이픈 구분 식별자(계좌 `110-123-456789` 등). 날짜(`2026-07-19`=8자리)를 삼키지
 * 않도록 **총 숫자 10자리 이상**일 때만 마스킹한다(정규식으로 표현 불가 → 치환기에서 판정).
 */
const HYPHENATED_ID_RE = /(?<!\d)\d{2,6}-\d{2,6}-\d{2,8}(?!\d)/g;
/** 구분자 없는 장문 숫자(전화번호·계좌). 쉼표 없는 10자리 이상은 금액이 아니다. */
const LONG_DIGIT_RUN_RE = /(?<!\d)\d{10,}(?!\d)/g;

/** 숫자만 같은 개수의 마스킹 문자로 치환한다(구분자 보존 → 길이 보존). */
function redactDigits(match: string): string {
  return match.replace(/\d/g, MASK_CHAR);
}

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/**
 * 외부 LLM 전송용으로 장문 숫자 식별자를 가린다. 반환 문자열 길이는 입력과 같다.
 *
 * @throws 길이가 보존되지 않으면 즉시 실패한다 — 조용히 어긋난 오프셋을 내보내느니
 *   호출부에서 터지는 편이 안전하다(호출부는 LLM 경로를 건너뛰고 사람 검토로 보낸다).
 */
export function maskForLlm(content: string): string {
  const masked = content
    .replace(CARD_NUMBER_RE, redactDigits)
    .replace(HYPHENATED_ID_RE, (match) => (digitCount(match) >= 10 ? redactDigits(match) : match))
    .replace(LONG_DIGIT_RUN_RE, redactDigits);

  if (masked.length !== content.length) {
    throw new Error('maskForLlm must preserve length');
  }
  return masked;
}
