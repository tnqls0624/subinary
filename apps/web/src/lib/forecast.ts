/* ---------------------------------------------------------------------------
 * 이번 달 예측 맞히기 — 첫 번째 "상태를 가진" 미니앱
 *
 * ## 왜 이 게임인가
 *
 * 이 저장소의 가장 강한 원칙은 **"예측하지 않는다"**이다. 그래서 지출 예상·이상 감지
 * 같은 기능은 전부 기각돼 왔다 — 시스템이 만든 추정은 근거를 화면에 함께 띄울 수 없다.
 *
 * 이 게임은 그 원칙을 우회하지 않고 **뒤집는다**: 예측을 사람이 한다. 사용자가 월초에
 * 숫자를 적고, 시스템은 그것을 기억했다가 월말에 실제와 나란히 놓는다. 시스템이 하는
 * 일은 저장과 비교뿐이고 둘 다 사실이다.
 *
 * 게임적 긴장도 여기서 나온다 — 내가 적은 숫자가 있으면 남은 날의 지출이 다르게 읽힌다.
 * 보상이 없어도 성립하는 이유다(토스 게임의 동력인 리워드를 우리는 줄 수 없다).
 *
 * ## 판정하지 않는다
 *
 * "잘 맞혔어요"·"많이 썼어요"를 쓰지 않는다. 차이와 오차율은 사실이지만 그것이
 * 좋은지 나쁜지는 이 화면이 답할 수 없다 — 병원비를 낸 달의 초과는 실패가 아니다.
 * ------------------------------------------------------------------------- */

/** 미니앱 식별자. 서버 `play_states.app_key`에 그대로 들어간다. */
export const FORECAST_APP_KEY = 'monthly-forecast';

/**
 * 저장되는 상태의 모양.
 *
 * 저장소는 이 모양을 모른다(자유 jsonb). 그래서 **읽는 쪽이 검증한다** — 값이
 * 깨졌거나 예전 모양이면 "기록 없음"으로 다루고, 화면은 처음처럼 물어본다.
 * 저장소가 값의 뜻을 알게 하는 대신 치르는 비용이고, 이 값이 작아서 감당된다.
 */
export interface ForecastState {
  /** 사용자가 적은 예상 지출(원). */
  amount: number;
  /** 적은 시각(ISO). 언제 정했는지가 결과 해석에 필요하다. */
  decidedAt: string;
}

/**
 * 예상 금액의 상한.
 *
 * 상한이 없으면 오타 하나(0을 더 누른)로 막대가 화면 밖으로 나가고, 오차율이
 * 의미를 잃는다. 10억은 가계 지출에서 실수임이 분명한 값이다.
 */
export const FORECAST_MAX_AMOUNT = 1_000_000_000;

/**
 * 저장된 값을 읽는다. 모양이 다르면 `null` — **던지지 않는다.**
 *
 * 미니앱 상태는 예전 버전이 남아 있을 수 있고, 그때 화면이 깨지면 사용자는 게임을
 * 다시 시작할 방법조차 잃는다. 못 읽는 값은 "아직 안 적었다"와 같이 다룬다.
 */
export function parseForecastState(
  raw: Record<string, unknown> | null | undefined,
): ForecastState | null {
  if (!raw) return null;
  const amount = raw.amount;
  const decidedAt = raw.decidedAt;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (!Number.isInteger(amount) || amount <= 0) return null;
  if (amount > FORECAST_MAX_AMOUNT) return null;
  if (typeof decidedAt !== 'string' || decidedAt.length === 0) return null;
  return { amount, decidedAt };
}

/** 입력값 검증 — 화면이 저장 전에 쓴다. */
export function isValidForecastAmount(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= FORECAST_MAX_AMOUNT
  );
}

/** 결과 비교. 어느 쪽이 크다는 **판정은 하지 않고** 값만 준다. */
export interface ForecastComparison {
  /** 실제 − 예상. 양수면 예상보다 많이 썼다. */
  diff: number;
  /** |diff| / 예상. 예상이 0이면 만들 수 없으므로 null. */
  errorRate: number | null;
  /** 예상 대비 현재 진행률(0~). 막대 길이에 쓴다. */
  progress: number;
}

export function compareForecast(
  forecastAmount: number,
  actualNet: number,
): ForecastComparison {
  const diff = actualNet - forecastAmount;
  // 0으로 나눈 값을 억지로 채우지 않는다 — "무한% 빗나감"은 사실이 아니라 계산 사고다.
  const errorRate = forecastAmount === 0 ? null : Math.abs(diff) / forecastAmount;
  const progress = forecastAmount === 0 ? 0 : actualNet / forecastAmount;
  return { diff, errorRate, progress };
}

/**
 * 달이 끝났는가(KST 기준). 끝난 달은 "결과", 진행 중인 달은 "경과"다.
 *
 * 둘을 구분하지 않으면 월중에 "예상보다 적게 썼다"고 말하게 되는데, 그건 달이
 * 안 끝났기 때문이지 적게 쓴 것이 아니다.
 */
export function isMonthClosed(monthKey: string, now: Date): boolean {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentKey = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
  return monthKey < currentKey;
}
