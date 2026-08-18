import { describe, expect, it } from 'vitest';

import {
  forecastRecurring,
  RECURRING_WINDOW_DAYS,
} from './recurring-forecast.js';

/** KST 벽시계로 Date를 만든다(테스트 가독성용). */
function kst(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

describe('forecastRecurring — 월 주기', () => {
  it('30일을 더하지 않고 같은 일(day-of-month)을 유지한다', () => {
    // 매달 12일 결제. 30일을 더하면 다음이 8월 11일이 되어 하루씩 밀린다.
    const f = forecastRecurring(
      { lastSeenAt: kst('2026-07-12T09:00:00'), intervalDays: 30, cadence: 'monthly' },
      kst('2026-07-20T00:00:00'),
    );
    expect(f.nextExpectedAt).toBe(kst('2026-08-12T09:00:00').toISOString());
    expect(f.windowDays).toBe(RECURRING_WINDOW_DAYS.monthly);
    expect(f.phase).toBe('upcoming');
  });

  it('짧은 달에는 말일로 클램프한다 (1/31 → 2/28)', () => {
    const f = forecastRecurring(
      { lastSeenAt: kst('2026-01-31T12:00:00'), intervalDays: 30, cadence: 'monthly' },
      kst('2026-02-01T00:00:00'),
    );
    expect(f.nextExpectedAt).toBe(kst('2026-02-28T12:00:00').toISOString());
  });

  it('윤년 2월은 29일까지 간다', () => {
    const f = forecastRecurring(
      { lastSeenAt: kst('2028-01-31T12:00:00'), intervalDays: 30, cadence: 'monthly' },
      kst('2028-02-01T00:00:00'),
    );
    expect(f.nextExpectedAt).toBe(kst('2028-02-29T12:00:00').toISOString());
  });
});

describe('forecastRecurring — 주 주기', () => {
  it('관측된 간격을 그대로 더한다', () => {
    const f = forecastRecurring(
      { lastSeenAt: kst('2026-08-10T08:00:00'), intervalDays: 7, cadence: 'weekly' },
      kst('2026-08-11T00:00:00'),
    );
    expect(f.nextExpectedAt).toBe(kst('2026-08-17T08:00:00').toISOString());
    expect(f.windowDays).toBe(RECURRING_WINDOW_DAYS.weekly);
  });
});

describe('forecastRecurring — 국면 판정', () => {
  const base = {
    lastSeenAt: kst('2026-07-12T09:00:00'),
    intervalDays: 30,
    cadence: 'monthly' as const,
  };
  // 다음 예상 = 8/12, 창 ±3일 → 8/9~8/15, 유예 9일 → 8/24까지

  it('창 이전은 upcoming', () => {
    expect(forecastRecurring(base, kst('2026-08-08T00:00:00')).phase).toBe('upcoming');
  });

  it('창 안은 due', () => {
    expect(forecastRecurring(base, kst('2026-08-13T00:00:00')).phase).toBe('due');
    expect(forecastRecurring(base, kst('2026-08-09T09:00:00')).phase).toBe('due');
  });

  it('창을 넘기면 overdue + 넘긴 일수', () => {
    const f = forecastRecurring(base, kst('2026-08-18T09:00:00'));
    expect(f.phase).toBe('overdue');
    expect(f.overdueDays).toBe(3); // 8/15 창 끝 + 3일
  });

  it('유예 안에서는 아직 해지를 묻지 않는다', () => {
    expect(forecastRecurring(base, kst('2026-08-20T09:00:00')).stoppedCandidate).toBe(false);
  });

  it('유예를 넘기면 해지 확인 후보가 된다', () => {
    expect(forecastRecurring(base, kst('2026-08-26T09:00:00')).stoppedCandidate).toBe(true);
  });
});

describe('forecastRecurring — 불변', () => {
  it('예상일이 지나도 다음 주기로 굴리지 않는다', () => {
    // 3개월 방치된 series. 굴리면 "곧 나갈 예정"으로 영원히 남아 해지를 못 알아챈다.
    const f = forecastRecurring(
      { lastSeenAt: kst('2026-05-12T09:00:00'), intervalDays: 30, cadence: 'monthly' },
      kst('2026-08-18T00:00:00'),
    );
    expect(f.nextExpectedAt).toBe(kst('2026-06-12T09:00:00').toISOString());
    expect(f.phase).toBe('overdue');
    expect(f.stoppedCandidate).toBe(true);
  });

  it('같은 입력은 같은 결과를 낸다', () => {
    const input = { lastSeenAt: kst('2026-07-12T09:00:00'), intervalDays: 30, cadence: 'monthly' as const };
    const now = kst('2026-08-01T00:00:00');
    expect(forecastRecurring(input, now)).toEqual(forecastRecurring(input, now));
  });

  it('ISO 문자열 입력도 Date와 같게 다룬다', () => {
    const now = kst('2026-08-01T00:00:00');
    const a = forecastRecurring({ lastSeenAt: kst('2026-07-12T09:00:00'), intervalDays: 30, cadence: 'monthly' }, now);
    const b = forecastRecurring({ lastSeenAt: kst('2026-07-12T09:00:00').toISOString(), intervalDays: 30, cadence: 'monthly' }, now);
    expect(a).toEqual(b);
  });
});
