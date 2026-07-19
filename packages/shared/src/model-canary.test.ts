import { describe, expect, it } from 'vitest';

import { evaluateModelCanary } from './model-canary.js';

const windowEndsAt = new Date('2026-07-18T01:00:00.000Z');

describe('evaluateModelCanary', () => {
  it('관측 창 종료 후 충분한 정상 표본을 통과시킨다', () => {
    expect(
      evaluateModelCanary({
        invocationCount: 100,
        failedInvocationCount: 2,
        p95DurationMs: 900,
        minimumInvocationCount: 20,
        maximumErrorRateBasisPoints: 500,
        maximumP95DurationMs: 1_000,
        evaluatedAt: windowEndsAt,
        windowEndsAt,
      })
    ).toEqual({
      decision: 'passed',
      reason: 'within_thresholds',
      errorRateBasisPoints: 200,
    });
  });

  it('최소 표본 이후 오류율과 p95 동시 위반을 즉시 rollback한다', () => {
    expect(
      evaluateModelCanary({
        invocationCount: 20,
        failedInvocationCount: 2,
        p95DurationMs: 1_001,
        minimumInvocationCount: 20,
        maximumErrorRateBasisPoints: 500,
        maximumP95DurationMs: 1_000,
        evaluatedAt: new Date('2026-07-18T00:30:00.000Z'),
        windowEndsAt,
      })
    ).toMatchObject({
      decision: 'rollback',
      reason: 'error_rate_and_p95_duration_exceeded',
      errorRateBasisPoints: 1_000,
    });
  });

  it('관측 창 안에서는 정상 표본이 충분해도 계속 관측한다', () => {
    expect(
      evaluateModelCanary({
        invocationCount: 20,
        failedInvocationCount: 0,
        p95DurationMs: 100,
        minimumInvocationCount: 20,
        maximumErrorRateBasisPoints: 500,
        maximumP95DurationMs: 1_000,
        evaluatedAt: new Date('2026-07-18T00:30:00.000Z'),
        windowEndsAt,
      }).decision
    ).toBe('monitoring');
  });

  it('관측 창 종료까지 최소 표본이 없으면 fail-closed rollback한다', () => {
    expect(
      evaluateModelCanary({
        invocationCount: 19,
        failedInvocationCount: 0,
        p95DurationMs: 100,
        minimumInvocationCount: 20,
        maximumErrorRateBasisPoints: 500,
        maximumP95DurationMs: 1_000,
        evaluatedAt: windowEndsAt,
        windowEndsAt,
      }).reason
    ).toBe('insufficient_invocations');
  });

  it('실패 호출 수가 전체 호출 수보다 크면 거부한다', () => {
    expect(() =>
      evaluateModelCanary({
        invocationCount: 1,
        failedInvocationCount: 2,
        p95DurationMs: 0,
        minimumInvocationCount: 1,
        maximumErrorRateBasisPoints: 500,
        maximumP95DurationMs: 1_000,
        evaluatedAt: windowEndsAt,
        windowEndsAt,
      })
    ).toThrow(RangeError);
  });
});
