import { describe, expect, it } from 'vitest';

import {
  calculatePendingAgeSeconds,
  calculateRateBasisPoints,
  summarizeOperationalQueues,
} from './operational-metrics.js';

describe('operational metrics', () => {
  it('비율을 basis points로 계산하고 빈 표본을 0으로 처리한다', () => {
    expect(calculateRateBasisPoints(1, 4)).toBe(2_500);
    expect(calculateRateBasisPoints(0, 0)).toBe(0);
    expect(calculateRateBasisPoints(5, 2)).toBe(10_000);
  });

  it('음수나 유한하지 않은 비율 입력을 거부한다', () => {
    expect(() => calculateRateBasisPoints(-1, 1)).toThrow(
      'must be non-negative',
    );
    expect(() => calculateRateBasisPoints(Number.NaN, 1)).toThrow(
      'must be finite',
    );
  });

  it('미래 timestamp를 0초로 제한하고 timestamp 부재를 보존한다', () => {
    expect(calculatePendingAgeSeconds(5_000, 10_500)).toBe(5);
    expect(calculatePendingAgeSeconds(11_000, 10_500)).toBe(0);
    expect(calculatePendingAgeSeconds(null, 10_500)).toBeNull();
  });

  it('큐 합계와 가장 오래된 pending age를 축약한다', () => {
    expect(
      summarizeOperationalQueues([
        {
          waiting: 2,
          active: 1,
          delayed: 0,
          failed: 3,
          oldestPendingAgeSeconds: 12,
        },
        {
          waiting: 1,
          active: 0,
          delayed: 4,
          failed: 0,
          oldestPendingAgeSeconds: 30,
        },
      ]),
    ).toEqual({
      waiting: 3,
      active: 1,
      delayed: 4,
      failed: 3,
      oldestPendingAgeSeconds: 30,
    });
  });
});
