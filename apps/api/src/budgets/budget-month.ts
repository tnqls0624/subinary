/**
 * 예산 회계월 계산 — Asia/Seoul 고정(+09:00, DST 없음).
 *
 * DB의 `effective_month`는 순간이 아니라 서울 달력의 월 신원이다. API 경계에서는
 * `YYYY-MM`, DB 경계에서는 `YYYY-MM-01`, 거래 집계에서는 UTC `[from, to)`로 바꾼다.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 선택 회계월과 거래 집계용 UTC 경계. */
export interface BudgetPeriod {
  from: Date;
  to: Date;
  month: string;
  effectiveMonth: string;
}

/** `YYYY-MM`을 연·0-based 월로 검증·분해한다. */
function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) {
    throw new Error('month must be in YYYY-MM format');
  }
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

/** 연·0-based 월을 정규화된 `YYYY-MM`로 만든다(연도 경계 자동 처리). */
function formatMonth(year: number, monthIndex: number): string {
  const normalized = new Date(Date.UTC(year, monthIndex, 1));
  return `${normalized.getUTCFullYear().toString().padStart(4, '0')}-${(
    normalized.getUTCMonth() + 1
  )
    .toString()
    .padStart(2, '0')}`;
}

/** 현재 시각의 서울 회계월. 테스트가 경계를 고정할 수 있도록 `now`를 받는다. */
export function currentBudgetMonth(now = new Date()): string {
  const seoulNow = new Date(now.getTime() + KST_OFFSET_MS);
  return `${seoulNow.getUTCFullYear().toString().padStart(4, '0')}-${(
    seoulNow.getUTCMonth() + 1
  )
    .toString()
    .padStart(2, '0')}`;
}

/** 회계월에 delta개월을 더한다. */
export function addBudgetMonths(month: string, delta: number): string {
  const { year, monthIndex } = parseMonth(month);
  return formatMonth(year, monthIndex + delta);
}

/** API 월 키를 DB date 값으로 바꾼다. */
export function toEffectiveMonth(month: string): string {
  parseMonth(month);
  return `${month}-01`;
}

/** DB date 값을 API 월 키로 바꾼다. 비정상 date는 조용히 보정하지 않는다. */
export function fromEffectiveMonth(effectiveMonth: string): string {
  const month = effectiveMonth.slice(0, 7);
  if (effectiveMonth !== `${month}-01`) {
    throw new Error('budget effectiveMonth must be the first day of a month');
  }
  parseMonth(month);
  return month;
}

/** 선택월(없으면 현재 서울월)의 거래 집계 경계를 만든다. */
export function resolveBudgetPeriod(
  month?: string,
  now = new Date(),
): BudgetPeriod {
  const normalizedMonth =
    month && month.length > 0 ? month : currentBudgetMonth(now);
  const { year, monthIndex } = parseMonth(normalizedMonth);
  return {
    from: new Date(Date.UTC(year, monthIndex, 1) - KST_OFFSET_MS),
    to: new Date(Date.UTC(year, monthIndex + 1, 1) - KST_OFFSET_MS),
    month: normalizedMonth,
    effectiveMonth: toEffectiveMonth(normalizedMonth),
  };
}

/** 선택월을 포함한 최근 3개 회계월의 거래 집계 경계. */
export function threeMonthPeriod(period: BudgetPeriod): BudgetPeriod {
  const firstMonth = addBudgetMonths(period.month, -2);
  return {
    ...resolveBudgetPeriod(firstMonth),
    to: period.to,
    month: period.month,
    effectiveMonth: period.effectiveMonth,
  };
}

/** 과거월은 계획을 수정·삭제·새로 만들 수 없다. */
export function isPastBudgetMonth(month: string, now = new Date()): boolean {
  parseMonth(month);
  return month < currentBudgetMonth(now);
}

/** 최근 3개월 합계를 화면용 원 단위 정수 평균으로 바꾼다. */
export function threeMonthAverage(total: number): number {
  return Math.round(total / 3);
}
