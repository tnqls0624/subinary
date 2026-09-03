/* ---------------------------------------------------------------------------
 * 정기 지출 다음 결제 예상 — 관측에서만 나오는 순수 계산
 *
 * ADR-0029가 확정한 series는 `interval_days`·`cadence`·`last_seen_at`을 들고 있다.
 * 이 모듈은 그 셋에서 **다음 1회**의 예상 시점을 뽑는다.
 *
 * ## 2026-09-03 — 저장하기로 바꿨다
 *
 * 처음에는 "각자 계산해도 같은 값"이라 저장하지 않았다. **틀렸다.** 월 주기 계산은
 * `now`를 보고 "첫 미래 주기까지 민다"(아래 `nextMonthlyAnchor`의 do-while). 그래서
 * 재계산 이후 시간이 지나면 같은 series가 조회 시각에 따라 다른 날짜를 낸다. 목록에서
 * 본 날짜와 알림이 말한 날짜가 갈리는 지점이 바로 여기였다.
 *
 * 지금은 재계산이 `next_expected_at`을 확정해 저장하고, 조회는 그 값을 읽는다. 시간에
 * 의존하는 것은 **국면(phase)뿐**이라 {@link resolveRecurringPhase}가 저장된 예상일에서
 * 계산한다. 값 하나에서 파생되므로 세 표면이 자연히 일치한다.
 *
 * ✅ **금액 예고 조건이 풀렸다.** ADR-0027이 8단계까지 끝나 `net_amount`가 확정이다.
 * 다만 이 모듈은 여전히 날짜만 다룬다 — 금액은 series의 `amount_median`(관측값)이고
 * 예측하지 않는다(기획 D1).
 *
 * ## 두 가지 결정
 *
 * 1. **월 주기는 일(day-of-month)을 앵커로 쓴다.** `last_seen_at + 30일`이 아니다 —
 *    매달 12일 결제가 30일씩 밀리면 반년 뒤 5일이 어긋난다. 말일은 짧은 달로 클램프한다
 *    (1/31 → 2/28). 주 주기만 `interval_days`를 그대로 더한다.
 * 2. **다음 1회만 계산하고, 지나가면 굴리지 않는다.** 예상일이 지났는데 다음 주기로
 *    계속 굴리면 해지한 구독이 영원히 "곧 나갈 예정"으로 남는다. 지난 것은 `overdue`로
 *    두고, 유예를 넘으면 해지 확인 후보(`stoppedCandidate`)로 표시한다.
 * ------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 예상일의 불확실 폭(일). 카드 결제일은 주말·영업일 처리로 밀린다.
 * 관측 분산을 series에 저장하지 않으므로 주기별 보수적 고정값을 쓴다 —
 * 좁게 잡아 자주 빗나가는 것보다 넓게 잡아 맞는 편이 신뢰를 지킨다.
 */
export const RECURRING_WINDOW_DAYS = { weekly: 1, monthly: 3 } as const;

/** 예상 창을 넘긴 뒤 "해지했나요?"를 묻기까지의 유예 = 주기의 30%. */
export const RECURRING_STOPPED_GRACE_RATIO = 0.3;

export type RecurringCadenceInput = keyof typeof RECURRING_WINDOW_DAYS;

/** 다음 결제가 지금 어느 국면에 있는가. */
export type RecurringPhase = 'upcoming' | 'due' | 'overdue';

export interface RecurringForecastInput {
  lastSeenAt: Date | string;
  intervalDays: number;
  cadence: RecurringCadenceInput;
}

export interface RecurringForecast {
  /** 다음 결제 예상 시점(ISO). 근거 시각의 벽시계 시분초를 유지한다. */
  nextExpectedAt: string;
  /** 예상일 ± 이 일수가 "그쯤" 창이다. */
  windowDays: number;
  phase: RecurringPhase;
  /** `overdue`일 때 창을 넘긴 일수. 그 외에는 0. */
  overdueDays: number;
  /** 유예까지 넘겨 해지 여부를 물어야 하는 상태(ADR 기획 D4). */
  stoppedCandidate: boolean;
}

/** KST 벽시계의 연·월·일·시·분·초. 달 경계는 서울 기준이어야 사용자의 달과 맞는다. */
function seoulParts(at: Date) {
  const shifted = new Date(at.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    ms:
      shifted.getUTCHours() * 3600_000 +
      shifted.getUTCMinutes() * 60_000 +
      shifted.getUTCSeconds() * 1000 +
      shifted.getUTCMilliseconds(),
  };
}

/** KST 벽시계 값을 절대 시각으로 되돌린다. */
function fromSeoul(
  year: number,
  month: number,
  day: number,
  ms: number,
): Date {
  return new Date(Date.UTC(year, month, day) + ms - KST_OFFSET_MS);
}

/** 그 달의 마지막 날(1~31). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * 월 주기의 다음 결제일 — 일(day-of-month)을 유지하고 짧은 달은 말일로 클램프한다.
 * 근거가 여러 달 전이면 `now` 이후가 될 때까지 달만 넘긴다(일은 그대로).
 */
function nextMonthlyAnchor(lastSeen: Date, now: Date): Date {
  const last = seoulParts(lastSeen);
  let year = last.year;
  let month = last.month;
  let next: Date;
  do {
    month += 1;
    if (month > 11) {
      month -= 12;
      year += 1;
    }
    const day = Math.min(last.day, daysInMonth(year, month));
    next = fromSeoul(year, month, day, last.ms);
    // 근거가 오래된 series는 첫 미래 주기까지만 민다. 그 다음은 굴리지 않는다.
  } while (next.getTime() <= now.getTime() - 400 * DAY_MS);
  return next;
}

/**
 * 다음 결제 예상을 계산한다.
 *
 * `now`를 인자로 받는 이유: 호출 시점에 따라 결과가 달라지면 목록·알림·홈이 서로 다른
 * 국면을 말한다. 한 요청 안에서는 같은 `now`를 넘겨 판정을 하나로 묶는다.
 */
/**
 * **저장된** 예상일에서 국면만 계산한다.
 *
 * 예상일은 재계산이 확정해 저장하지만 국면은 조회 시각에 의존하므로 저장할 수 없다
 * (하루만 지나도 거짓이 된다). 이 함수가 그 경계다 — 목록·홈·알림이 같은
 * `nextExpectedAt`을 읽고 각자 국면을 계산하면 값은 자연히 일치한다.
 *
 * `windowDays`를 인자로 받는 이유: series에 저장된 값을 그대로 써야 한다. 상수를
 * 나중에 바꿀 때 과거 예상의 창이 소급 변하면, "±2일"이라고 보낸 알림이 사후에 다른
 * 말을 한 셈이 된다.
 */
export function resolveRecurringPhase(
  input: {
    nextExpectedAt: Date | string;
    intervalDays: number;
    windowDays: number;
    /**
     * 사용자가 "계속 써요"라고 답한 시각. 있으면 그 뒤 **한 주기**가 지나기 전에는
     * 다시 묻지 않는다 — 답을 받고도 또 묻는 것은 답을 무시하는 것이다(기획 D4).
     */
    stoppedDismissedAt?: Date | string | null;
  },
  now: Date,
): Pick<RecurringForecast, 'phase' | 'overdueDays' | 'stoppedCandidate'> {
  const next =
    input.nextExpectedAt instanceof Date
      ? input.nextExpectedAt
      : new Date(input.nextExpectedAt);
  const windowMs = input.windowDays * DAY_MS;
  const graceMs = Math.round(
    input.intervalDays * RECURRING_STOPPED_GRACE_RATIO * DAY_MS,
  );
  const elapsed = now.getTime() - next.getTime();

  let phase: RecurringPhase = 'upcoming';
  let overdueDays = 0;
  if (elapsed > windowMs) {
    phase = 'overdue';
    overdueDays = Math.floor((elapsed - windowMs) / DAY_MS);
  } else if (elapsed >= -windowMs) {
    phase = 'due';
  }

  // 국면(overdue)은 사실이라 답과 무관하게 그대로 말한다. 답이 누르는 것은 **묻기**뿐이다.
  let stoppedCandidate = elapsed > windowMs + graceMs;
  if (stoppedCandidate && input.stoppedDismissedAt) {
    const dismissed =
      input.stoppedDismissedAt instanceof Date
        ? input.stoppedDismissedAt
        : new Date(input.stoppedDismissedAt);
    const sinceDismiss = now.getTime() - dismissed.getTime();
    if (sinceDismiss < input.intervalDays * DAY_MS) stoppedCandidate = false;
  }

  return { phase, overdueDays, stoppedCandidate };
}

export function forecastRecurring(
  input: RecurringForecastInput,
  now: Date,
): RecurringForecast {
  const lastSeen =
    input.lastSeenAt instanceof Date
      ? input.lastSeenAt
      : new Date(input.lastSeenAt);
  const windowDays = RECURRING_WINDOW_DAYS[input.cadence];

  const next =
    input.cadence === 'monthly'
      ? nextMonthlyAnchor(lastSeen, now)
      : new Date(lastSeen.getTime() + input.intervalDays * DAY_MS);

  const windowMs = windowDays * DAY_MS;
  const graceMs = Math.round(
    input.intervalDays * RECURRING_STOPPED_GRACE_RATIO * DAY_MS,
  );
  const elapsed = now.getTime() - next.getTime();

  let phase: RecurringPhase = 'upcoming';
  let overdueDays = 0;
  if (elapsed > windowMs) {
    phase = 'overdue';
    overdueDays = Math.floor((elapsed - windowMs) / DAY_MS);
  } else if (elapsed >= -windowMs) {
    phase = 'due';
  }

  return {
    nextExpectedAt: next.toISOString(),
    windowDays,
    phase,
    overdueDays,
    stoppedCandidate: phase === 'overdue' && elapsed > windowMs + graceMs,
  };
}
