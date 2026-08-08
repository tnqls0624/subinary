/**
 * 금액 산술 — ADR-0027 §3의 환산 공식 **단일 구현**.
 *
 * API·worker·복구 작업이 이 한 함수를 공유해야 1원 차이가 생기지 않는다. 현재는
 * 승격 경로가 `Math.round(major * rate)`를 자기 안에서 하고 있어(부동소수), 같은
 * 입력이 실행 환경에 따라 다른 값을 낼 수 있다.
 *
 * 공식(ADR-0027 §3): 원통화 minor units `M`, ISO 4217 지수 `e`, 12자리 정수 스케일
 * 환율 `R`일 때 KRW = `M × R / (10^e × 10^12)`를 **ROUND_HALF_UP**.
 *
 * 전 구간 bigint인 이유: `M × R`은 USD 1,000,000.00 × 1,400원이면 1.4e20으로
 * `Number.MAX_SAFE_INTEGER`(9e15)를 훌쩍 넘는다. number로 중간값을 잡으면 그 순간
 * 정밀도가 날아가고, 날아간 자리가 곧 반올림 경계다.
 */
import { currencyExponent, toSeoulString } from '@family/shared';

/** 환율 고정 소수 스케일 — `fx_rate_snapshots.rate`가 `numeric(24,12)`다. */
export const FX_RATE_SCALE = 12;

const FX_RATE_SCALE_FACTOR = 10n ** BigInt(FX_RATE_SCALE);

/**
 * 금액 계약이 환산을 허용하는 통화 목록.
 *
 * **지수 값 자체는 여기 두지 않는다** — `@family/shared`의 ISO 매핑에서만 가져온다
 * (ADR-0027 §3 "지수는 한 ISO 매핑에서만"). 여기 있는 것은 "어느 통화를 지원하는가"
 * 뿐이고, 그마저도 {@link moneyCurrencyExponent}가 shared에 위임한다.
 *
 * 그런데도 목록이 따로 필요한 이유: shared의 `currencyExponent`는 **미등록 통화에
 * 기본값 2를 돌려준다.** 표시·포맷에는 합리적인 폴백이지만 금액 계약에서는 금지다 —
 * 모르는 통화를 지수 2로 가정해 환산하면 100배 틀린 금액이 조용히 저장된다.
 * ADR-0027 §3은 "통화나 지수를 모르면 환산하지 않고 검토로 보낸다"고 정한다.
 *
 * `money-math.test.ts`가 이 목록과 shared의 매핑이 어긋나지 않는지 검사한다.
 */
export const MONEY_SUPPORTED_CURRENCIES = [
  'KRW',
  'JPY',
  'VND',
  'USD',
  'EUR',
  'GBP',
  'CNY',
  'HKD',
  'AUD',
  'CAD',
  'SGD',
  'CHF',
  'THB',
  'TWD',
  'PHP',
  'MYR',
  'NZD',
  'MOP',
  'IDR',
  'BHD',
  'KWD',
  'OMR',
] as const;

const SUPPORTED = new Set<string>(MONEY_SUPPORTED_CURRENCIES);

/** 금액 계약의 집계 통화. 저장 통화는 항상 이것이다(v2-1 CHECK). */
export const MONEY_SETTLEMENT_CURRENCY = 'KRW';

/**
 * 통화의 minor-unit 지수. **모르는 통화는 null** — 호출자는 환산하지 말고 검토로
 * 보내야 한다(ADR-0027 §3).
 */
export function moneyCurrencyExponent(code: string): number | null {
  const upper = code.toUpperCase();
  return SUPPORTED.has(upper) ? currencyExponent(upper) : null;
}

/** 계약이 지원하는 통화인지. */
export function isSupportedMoneyCurrency(code: string): boolean {
  return SUPPORTED.has(code.toUpperCase());
}

/**
 * `numeric(24,12)` 문자열을 12자리 정수 스케일 bigint로 읽는다.
 *
 * 드라이버가 이 컬럼을 문자열로 주는 것은 의도된 설계다(schema.ts 주석) — `Number`로
 * 받는 순간 십진 환율이 이진 부동소수로 뭉개진다. 그러니 여기서도 `Number`를 거치지
 * 않고 문자열을 직접 파싱한다.
 *
 * 지수 표기(`1.3e3`)를 받지 않는 이유: numeric 컬럼은 지수 표기로 오지 않고, 받아
 * 주면 "어디서 온 값인지 모르는" 문자열까지 통과시키게 된다.
 *
 * @returns 스케일된 정수 환율. 형식이 어긋나거나 0 이하면 null.
 */
export function parseFxRate(rate: string | number): bigint | null {
  const text = typeof rate === 'number' ? String(rate) : rate;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;

  const whole = match[1];
  const fraction = match[2] ?? '';
  // 스케일보다 긴 소수부는 자르지 않고 거부한다. 자르면 그 순간 "저장된 환율"과
  // "계산에 쓴 환율"이 달라지고, 감사에서 그 차이를 설명할 근거가 없다.
  if (fraction.length > FX_RATE_SCALE) return null;

  const scaled =
    BigInt(whole) * FX_RATE_SCALE_FACTOR +
    BigInt(fraction.padEnd(FX_RATE_SCALE, '0') || '0');
  return scaled > 0n ? scaled : null;
}

/** 환산 실패 사유 — shadow 분류와 검토 라우팅이 이 값을 그대로 쓴다. */
export type MoneyConversionFailure =
  /** 계약이 지원하지 않는 통화(지수를 모른다). */
  | 'unsupported_currency'
  /** 환율 문자열이 `numeric(24,12)` 형식이 아니거나 0 이하. */
  | 'invalid_rate'
  /** minor units가 정수가 아니거나 음수. */
  | 'invalid_minor_units'
  /** 환산 결과가 안전정수 범위를 넘음(`bigint` 전환 ADR의 대상). */
  | 'krw_out_of_range';

export type MoneyConversion =
  | { readonly ok: true; readonly krw: number }
  | { readonly ok: false; readonly failure: MoneyConversionFailure };

/**
 * 원통화 minor units를 KRW 정수(원)로 환산한다 — **ROUND_HALF_UP**.
 *
 * `Math.round`를 쓰지 않는 이유: JS의 `Math.round`는 half-up이지만 **부동소수 나눗셈
 * 뒤에** 적용되므로, 정확히 0.5원인 몫이 0.49999999999999994로 내려앉아 반대로
 * 반올림되는 경우가 있다. 정수 산술로 `(분자 + 분모/2) / 분모`를 하면 그 경계가
 * 언제나 위로 간다. ADR-0027 회귀 테스트 7번이 요구하는 성질이다.
 *
 * 음수를 받지 않는다: 금액은 음수가 아닌 정수라고 ADR §3이 정한다. 음수를 허용하면
 * half-up의 방향(0에서 멀어지는가/큰 쪽인가)을 또 정해야 하고, 그 결정이 경로마다
 * 갈리면 정확히 이 ADR이 없애려는 상태가 된다.
 */
export function convertToKrw(
  minorUnits: number,
  currency: string,
  rate: string | number,
): MoneyConversion {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    return { ok: false, failure: 'invalid_minor_units' };
  }
  const exponent = moneyCurrencyExponent(currency);
  if (exponent === null) {
    return { ok: false, failure: 'unsupported_currency' };
  }
  const scaledRate = parseFxRate(rate);
  if (scaledRate === null) {
    return { ok: false, failure: 'invalid_rate' };
  }

  const divisor = 10n ** BigInt(exponent) * FX_RATE_SCALE_FACTOR;
  const numerator = BigInt(minorUnits) * scaledRate;
  const krw = (numerator + divisor / 2n) / divisor;

  if (krw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, failure: 'krw_out_of_range' };
  }
  return { ok: true, krw: Number(krw) };
}

/**
 * 환율의 **호환 표시값**(`card_transactions.exchange_rate`, double precision).
 *
 * ADR-0027 §3: "기존 `double precision exchangeRate`는 호환 표시값이지 계산 원본이
 * 아니다." 계산은 언제나 {@link convertToKrw}가 스냅샷 고정 소수로 한다. 이 값은
 * 기존 화면·감사 로그가 계속 읽을 수 있게 두는 것뿐이다.
 */
export function fxRateDisplayValue(rate: string | number): number | null {
  const scaled = parseFxRate(rate);
  if (scaled === null) return null;
  return Number(rate);
}

/**
 * 환율 기준일 — 서울 날짜 `YYYY-MM-DD`.
 *
 * ADR-0027 §3: 기준일은 거래시각(`occurredAt`)의 서울 날짜이고, 원문에 거래시각이
 * 없으면 `receivedAt`을 쓴다. **`new Date()`나 승격 실행 시각을 쓰지 않는다** —
 * 그게 D-1의 원인이다(재시도 시각이 금액을 바꿨다).
 *
 * `date-fns-tz`를 직접 부르지 않고 `@family/shared`의 `toSeoulString`을 쓰는 이유는
 * 서울 날짜 산식이 앱마다 갈리지 않게 하기 위함이다(ADR-0026이 기간 창에서 같은
 * 이유로 헬퍼를 강제했다).
 */
export function fxBaseDate(
  occurredAt: Date | null | undefined,
  receivedAt: Date,
): string {
  return toSeoulString(occurredAt ?? receivedAt, 'yyyy-MM-dd');
}
