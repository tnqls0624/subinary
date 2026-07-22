/**
 * Money helpers (minor units).
 *
 * 프로젝트 전역 금액 규약: 모든 금액은 "해당 통화의 minor units 정수"로 저장한다
 * (부동소수·소수점 없음). `major = amount / 10^exponent(currency)`.
 *   - KRW/JPY 등 지수 0 통화: minor == major (₩12,500 = 12500, 재변환 불필요).
 *   - USD/EUR 등 지수 2 통화: $22.00 = 2200.
 * KRW 전용이던 과거 규약의 상위집합이다(KRW 지수 0이라 기존 정수값이 그대로 유효).
 *
 * ⚠️ 지수표는 `@family/card-parsers`(의존성 없는 순수 파서)에도 동일 복사본이 있다.
 * 파서는 shared를 import할 수 없어 불가피한 중복이며, 값 자체는 안정적인 ISO4217
 * 상수다. 표시/집계층(worker·web·mobile)은 이 파일을 단일 원천으로 공유한다.
 */

/** 한국 카드 문자에서 등장하는 통화들의 ISO4217 minor-unit 지수. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  KRW: 0,
  JPY: 0,
  VND: 0,
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
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

const DEFAULT_EXPONENT = 2;

/** 통화 코드 → minor-unit 지수. 미등록 통화는 기본 2. */
export function currencyExponent(code: string): number {
  return CURRENCY_EXPONENTS[code.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/** minor units 정수 → major 실수 금액(표시 전용). KRW/JPY는 지수 0이라 그대로. */
export function minorToMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}

/**
 * minor units 금액을 통화별로 포맷한다.
 *   - KRW: `12,500원`(기존 표기 유지, 지수 0 → 나눗셈 없음).
 *   - 그 외: Intl 통화 포맷(`$22.00`, `€22.00`, `¥2,200`) — narrowSymbol.
 * KRW에 나눗셈을 적용하지 않아 이중변환(₩12,500→₩125) 위험이 없다.
 */
export function formatMoney(minor: number, currency = 'KRW'): string {
  const code = (currency || 'KRW').toUpperCase();
  const safe = Number.isFinite(minor) ? Math.round(minor) : 0;
  const exp = currencyExponent(code);
  const major = safe / 10 ** exp;

  if (code === 'KRW') {
    return `${new Intl.NumberFormat('ko-KR').format(Math.round(major))}원`;
  }
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(major);
}

/**
 * Assert that a value is a valid amount (a safe integer in minor units).
 * Throws a `TypeError` for non-finite values and non-integers. 통화 무관 — minor
 * units도 정수이므로 KRW/외화 모두에 유효하다(과거 `assertKrwInteger` 이름 유지).
 */
export function assertKrwInteger(v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`amount must be a finite number, received: ${String(v)}`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new TypeError(`amount must be an integer within the safe integer range, received: ${v}`);
  }
}

/** {@link assertKrwInteger}의 통화 중립 별칭(minor units 정수 검증). 신규 코드용. */
export const assertMinorUnits = assertKrwInteger;

/**
 * Sum a list of integer amounts (minor units). 동일 통화 전제 — 통화가 섞인
 * 리스트를 넘기면 무의미한 합이 되므로 호출측이 통화를 통일해 전달해야 한다.
 * Every element is validated via {@link assertKrwInteger}; the running total is
 * also guarded against exceeding `Number.MAX_SAFE_INTEGER`.
 */
export function sumKrw(values: number[]): number {
  let total = 0;
  for (const value of values) {
    assertKrwInteger(value);
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('sum exceeded the safe integer range');
    }
  }
  return total;
}
