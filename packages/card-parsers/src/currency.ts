/**
 * 통화(ISO 4217) 최소 단위(minor units) 헬퍼 — 이 패키지의 정본(canonical).
 *
 * 프로젝트 전역 금액 규약: 모든 금액은 "해당 통화의 minor units 정수"로 저장한다.
 *   major = minor / 10^exponent(currency)
 *   KRW/JPY 등 지수 0 통화는 minor == major (₩12,500 = 12500, 재변환 불필요).
 *   USD/EUR 등 지수 2 통화는 $22.00 = 2200.
 * 부동소수는 저장하지 않는다 — 파싱 시 {@link toMinorUnits}가 정수로 확정한다.
 *
 * ⚠️ 의도적 중복: `@family/card-parsers`는 의존성 없는 순수 패키지(shared/contracts
 * 미의존)라 `@family/shared`의 통화 헬퍼를 import할 수 없다. 지수표는 작고 안정적인
 * ISO4217 상수이므로 shared/web 표시층에 같은 표를 복사해 두되, "파서가 생산하는
 * minor-units의 스케일 정본은 여기"라는 원칙으로 드리프트를 관리한다.
 */

/** 한국 카드 문자에서 실제 등장하는 통화들의 ISO4217 minor-unit 지수. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  // 0-decimal (minor == major)
  KRW: 0,
  JPY: 0,
  VND: 0,
  // 2-decimal (대부분)
  USD: 2,
  EUR: 2,
  GBP: 2,
  CNY: 2,
  HKD: 2,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  CHF: 2,
  THB: 2,
  TWD: 2,
  PHP: 2,
  MYR: 2,
  NZD: 2,
  MOP: 2,
  IDR: 2,
  // 3-decimal (희귀)
  BHD: 3,
  KWD: 3,
  OMR: 3,
} as const;

/** 미등록 통화의 기본 지수(가장 흔한 2자리). */
const DEFAULT_EXPONENT = 2;

/** 문자 본문에서 통화 코드를 탐지할 때 쓰는 코드 목록(KRW 포함). */
export const KNOWN_CURRENCY_CODES: readonly string[] = Object.keys(CURRENCY_EXPONENTS);

/** 통화 코드 → minor-unit 지수. 미등록 통화는 기본 2. */
export function currencyExponent(code: string): number {
  return CURRENCY_EXPONENTS[code.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/**
 * major 단위 소수 문자열(예: "22.00", "1,234.5")을 해당 통화의 minor units 정수로
 * 변환한다. 소수 자릿수가 통화 지수보다 많으면 반올림하고 warning을 함께 돌려준다
 * (카드 문자는 통상 지수와 동일한 자릿수라 실무상 정확 일치). 안전정수 범위를
 * 벗어나면 값 없이 warning만 반환한다.
 */
export function toMinorUnits(raw: string, currency: string): { minor?: number; warning?: string } {
  const exp = currencyExponent(currency);
  const cleaned = raw.replace(/[,\s]/g, '');
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return { warning: `amount not parseable: ${raw}` };

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return { warning: `amount not parseable: ${raw}` };

  // 카드 금액 규모(<1e9, exp<=3)에서는 float 오차 없이 정확. 결과는 Math.round로
  // 반드시 정수로 확정한다(저장 불변식: minor units 정수).
  const minor = Math.round(value * 10 ** exp);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    return { warning: `amount out of safe range: ${raw}` };
  }

  const frac = match[2] ?? '';
  const warning =
    frac.length > exp
      ? `amount has ${frac.length} decimals; ${currency} expects ${exp} (rounded)`
      : undefined;
  return { minor, warning };
}
