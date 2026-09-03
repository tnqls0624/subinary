import { describe, expect, it } from 'vitest';

import {
  groupUpcomingByUser,
  tomorrowKstWindow,
  type UpcomingSeriesRow,
} from './upcoming-window';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 스케줄러가 넘기는 형태: 실제 UTC instant를 +9h 밀어 둔 Date. */
const seoulOf = (iso: string) => new Date(new Date(iso).getTime() + KST_OFFSET_MS);

describe('tomorrowKstWindow', () => {
  it('내일 KST 하루를 정확히 감싼다', () => {
    // KST 2026-09-03 20:00 = UTC 2026-09-03 11:00
    const w = tomorrowKstWindow(seoulOf('2026-09-03T11:00:00Z'));

    // 내일(9/4) KST 00:00 = UTC 9/3 15:00
    expect(w.start.toISOString()).toBe('2026-09-03T15:00:00.000Z');
    // 내일 KST 23:59:59.999 = UTC 9/4 14:59:59.999
    expect(w.end.toISOString()).toBe('2026-09-04T14:59:59.999Z');
  });

  it('KST 09시 이전 결제를 전날로 밀지 않는다 — 여기서 실제로 사고가 났다', () => {
    const w = tomorrowKstWindow(seoulOf('2026-09-03T11:00:00Z'));

    // 내일 KST 08:00 = UTC 9/3 23:00. UTC 날짜로 자르면 "오늘"이 되어 빠진다.
    const earlyTomorrow = new Date('2026-09-03T23:00:00Z');
    expect(earlyTomorrow >= w.start && earlyTomorrow <= w.end).toBe(true);

    // 오늘 KST 23:00 = UTC 9/3 14:00 — 창 밖이어야 한다.
    const lateToday = new Date('2026-09-03T14:00:00Z');
    expect(lateToday >= w.start).toBe(false);
  });

  it('월말을 넘어간다', () => {
    // KST 2026-08-31 20:00
    const w = tomorrowKstWindow(seoulOf('2026-08-31T11:00:00Z'));
    // 내일은 9/1 KST 00:00 = UTC 8/31 15:00
    expect(w.start.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  it('연말을 넘어간다', () => {
    const w = tomorrowKstWindow(seoulOf('2026-12-31T11:00:00Z'));
    expect(w.start.toISOString()).toBe('2026-12-31T15:00:00.000Z');
    expect(w.end.toISOString()).toBe('2027-01-01T14:59:59.999Z');
  });

  it('창이 정확히 하루다 (1ms 모자란 24시간)', () => {
    const w = tomorrowKstWindow(seoulOf('2026-09-03T11:00:00Z'));
    expect(w.end.getTime() - w.start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });
});

const v2: UpcomingSeriesRow = {
  userId: 'u1',
  householdId: 'h1',
  amountMedian: 13_500,
  currency: 'KRW',
  moneyContractVersion: 2,
};

describe('groupUpcomingByUser', () => {
  it('한 사용자의 여러 series를 한 건으로 묶는다 (기획 D5)', () => {
    const g = groupUpcomingByUser([
      v2,
      { ...v2, amountMedian: 9_900 },
      { ...v2, amountMedian: 10_800 },
    ]);

    expect(g.size).toBe(1);
    expect(g.get('u1')).toEqual({
      householdId: 'h1',
      count: 3,
      totalAmount: 34_200,
      excludedCount: 0,
    });
  });

  it('사용자가 다르면 따로 묶는다 — 남의 구독 예고를 받지 않는다', () => {
    const g = groupUpcomingByUser([v2, { ...v2, userId: 'u2' }]);
    expect(g.size).toBe(2);
    expect(g.get('u1')?.count).toBe(1);
    expect(g.get('u2')?.count).toBe(1);
  });

  it('v1 근거 series는 금액에서 빠지고 건수로 남는다', () => {
    const g = groupUpcomingByUser([
      v2,
      { ...v2, amountMedian: 50_000, moneyContractVersion: 1 },
    ]);

    const b = g.get('u1')!;
    expect(b.count).toBe(2);
    expect(b.totalAmount).toBe(13_500);
    expect(b.excludedCount).toBe(1);
  });

  it('외화도 합계에서 빠진다', () => {
    const g = groupUpcomingByUser([v2, { ...v2, currency: 'USD', amountMedian: 2_200 }]);

    const b = g.get('u1')!;
    expect(b.totalAmount).toBe(13_500);
    expect(b.excludedCount).toBe(1);
  });

  it('하나도 못 세면 totalAmount가 null이다 — 0이 아니다', () => {
    // 0을 주면 문구가 "0원 빠져요"가 되고, 그건 거짓이다.
    const g = groupUpcomingByUser([
      { ...v2, moneyContractVersion: 1 },
      { ...v2, currency: 'USD' },
    ]);

    const b = g.get('u1')!;
    expect(b.totalAmount).toBeNull();
    expect(b.count).toBe(2);
    expect(b.excludedCount).toBe(2);
  });

  it('빈 입력은 빈 맵이다', () => {
    expect(groupUpcomingByUser([]).size).toBe(0);
  });
});
