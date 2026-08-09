import { describe, expect, it } from 'vitest';

import {
  addBudgetMonths,
  currentBudgetMonth,
  fromEffectiveMonth,
  isPastBudgetMonth,
  resolveBudgetPeriod,
  threeMonthAverage,
  threeMonthPeriod,
  toEffectiveMonth,
} from './budget-month';

describe('예산 회계월', () => {
  it('UTC 월말이어도 서울 wall-clock 기준 월을 고른다', () => {
    expect(currentBudgetMonth(new Date('2026-07-31T15:00:00.000Z'))).toBe(
      '2026-08',
    );
  });

  it('API YYYY-MM과 DB 월초 date를 손실 없이 왕복한다', () => {
    expect(toEffectiveMonth('2026-08')).toBe('2026-08-01');
    expect(fromEffectiveMonth('2026-08-01')).toBe('2026-08');
    expect(() => fromEffectiveMonth('2026-08-02')).toThrow();
  });

  it('서울 월 경계와 연도 넘김을 정확히 계산한다', () => {
    const period = resolveBudgetPeriod('2026-12');
    expect(period.from.toISOString()).toBe('2026-11-30T15:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-12-31T15:00:00.000Z');
    expect(addBudgetMonths('2026-12', 1)).toBe('2027-01');
  });

  it('최근 3개월 범위는 선택월을 포함하고 실지출은 저장하지 않는다', () => {
    const period = threeMonthPeriod(resolveBudgetPeriod('2026-08'));
    expect(period.from.toISOString()).toBe('2026-05-31T15:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-08-31T15:00:00.000Z');
    expect(threeMonthAverage(100)).toBe(33);
  });

  it('현재월과 미래월은 편집 가능하고 과거월만 막는다', () => {
    const now = new Date('2026-08-09T00:00:00.000Z');
    expect(isPastBudgetMonth('2026-07', now)).toBe(true);
    expect(isPastBudgetMonth('2026-08', now)).toBe(false);
    expect(isPastBudgetMonth('2026-09', now)).toBe(false);
  });
});
