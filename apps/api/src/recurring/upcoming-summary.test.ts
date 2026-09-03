import { describe, expect, it } from 'vitest';

import {
  isAmountForecastable,
  summarizeUpcoming,
  type UpcomingSummaryInput,
} from './upcoming-summary';

const v2Krw: UpcomingSummaryInput = {
  amountMedian: 13_500,
  currency: 'KRW',
  moneyContractVersion: 2,
};

describe('isAmountForecastable', () => {
  it('v2 원화만 예고할 수 있다', () => {
    expect(isAmountForecastable(v2Krw, 'KRW')).toBe(true);
  });

  it('근거에 v1이 섞이면 금액을 예고하지 않는다 (기획 D2)', () => {
    // moneyContractVersion은 근거 거래 중 **최솟값**이다 — 하나만 v1이어도 1이 된다.
    expect(
      isAmountForecastable({ ...v2Krw, moneyContractVersion: 1 }, 'KRW'),
    ).toBe(false);
  });

  it('다른 통화는 예고하지 않는다 — 환산은 금액 계약의 일이다', () => {
    expect(isAmountForecastable({ ...v2Krw, currency: 'USD' }, 'KRW')).toBe(false);
  });
});

describe('summarizeUpcoming', () => {
  it('예고 가능한 것만 합산한다', () => {
    const summary = summarizeUpcoming(
      [v2Krw, { ...v2Krw, amountMedian: 9_900 }],
      'KRW',
    );

    expect(summary.totalAmount).toBe(23_400);
    expect(summary.forecastableCount).toBe(2);
    expect(summary.excludedCount).toBe(0);
    expect(summary.otherCurrencyCount).toBe(0);
  });

  it('v1 근거 series는 합계에서 빠지고 건수로 남는다', () => {
    const summary = summarizeUpcoming(
      [v2Krw, { ...v2Krw, amountMedian: 50_000, moneyContractVersion: 1 }],
      'KRW',
    );

    // 빠진 금액이 합계에 섞이면 "이만큼만 나간다"가 거짓이 된다.
    expect(summary.totalAmount).toBe(13_500);
    expect(summary.forecastableCount).toBe(1);
    expect(summary.excludedCount).toBe(1);
  });

  it('외화는 합산하지 않고 별도로 센다', () => {
    const summary = summarizeUpcoming(
      [v2Krw, { amountMedian: 2_200, currency: 'USD', moneyContractVersion: 2 }],
      'KRW',
    );

    expect(summary.totalAmount).toBe(13_500);
    expect(summary.otherCurrencyCount).toBe(1);
    expect(summary.excludedCount).toBe(0);
  });

  it('외화이면서 v1인 행을 두 번 세지 않는다', () => {
    // 세 건수의 합이 전체와 어긋나면 화면이 "나머지"를 계산할 수 없다.
    const rows: UpcomingSummaryInput[] = [
      v2Krw,
      { amountMedian: 2_200, currency: 'USD', moneyContractVersion: 1 },
      { ...v2Krw, moneyContractVersion: 1 },
    ];
    const s = summarizeUpcoming(rows, 'KRW');

    expect(s.forecastableCount + s.excludedCount + s.otherCurrencyCount).toBe(
      rows.length,
    );
    expect(s.otherCurrencyCount).toBe(1);
    expect(s.excludedCount).toBe(1);
  });

  it('빈 목록은 0을 낸다 — null이나 예외가 아니다', () => {
    expect(summarizeUpcoming([], 'KRW')).toEqual({
      totalAmount: 0,
      forecastableCount: 0,
      excludedCount: 0,
      otherCurrencyCount: 0,
    });
  });

  it('전부 예고 불가면 합계가 0이고 건수가 그 사실을 말한다', () => {
    const s = summarizeUpcoming(
      [
        { ...v2Krw, moneyContractVersion: 1 },
        { ...v2Krw, moneyContractVersion: 1 },
      ],
      'KRW',
    );

    // 화면은 이 조합에서 금액을 아예 그리지 않아야 한다(0원이라고 말하면 거짓이다).
    expect(s.totalAmount).toBe(0);
    expect(s.forecastableCount).toBe(0);
    expect(s.excludedCount).toBe(2);
  });
});
