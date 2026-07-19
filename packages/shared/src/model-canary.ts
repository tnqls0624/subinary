/** 운영 canary 관측 창을 결정적으로 판정하는 순수 정책. */

/** canary 판정 입력. 모든 rate 값은 basis point(10,000 = 100%) 단위다. */
export interface EvaluateModelCanaryInput {
  invocationCount: number;
  failedInvocationCount: number;
  p95DurationMs: number;
  minimumInvocationCount: number;
  maximumErrorRateBasisPoints: number;
  maximumP95DurationMs: number;
  evaluatedAt: Date;
  windowEndsAt: Date;
}

export type ModelCanaryDecision = 'monitoring' | 'passed' | 'rollback';

export type ModelCanaryDecisionReason =
  | 'observation_window_open'
  | 'within_thresholds'
  | 'insufficient_invocations'
  | 'error_rate_exceeded'
  | 'p95_duration_exceeded'
  | 'error_rate_and_p95_duration_exceeded'
  | 'rollback_unavailable';

/** 저장·응답에 사용하는 canary 판정 결과. */
export interface ModelCanaryEvaluation {
  decision: ModelCanaryDecision;
  reason: ModelCanaryDecisionReason;
  errorRateBasisPoints: number;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

/**
 * 최소 표본 이후 임계치 위반은 관측 창 중에도 즉시 rollback한다. 정상 통과는
 * 관측 창 종료까지 기다리고, 종료 시 최소 표본을 채우지 못하면 fail-closed한다.
 */
export function evaluateModelCanary(
  input: EvaluateModelCanaryInput
): ModelCanaryEvaluation {
  assertNonNegativeInteger('invocationCount', input.invocationCount);
  assertNonNegativeInteger(
    'failedInvocationCount',
    input.failedInvocationCount
  );
  assertNonNegativeInteger('p95DurationMs', input.p95DurationMs);
  assertNonNegativeInteger(
    'minimumInvocationCount',
    input.minimumInvocationCount
  );
  assertNonNegativeInteger(
    'maximumErrorRateBasisPoints',
    input.maximumErrorRateBasisPoints
  );
  assertNonNegativeInteger('maximumP95DurationMs', input.maximumP95DurationMs);
  if (input.failedInvocationCount > input.invocationCount) {
    throw new RangeError('failedInvocationCount cannot exceed invocationCount');
  }
  if (input.minimumInvocationCount === 0) {
    throw new RangeError('minimumInvocationCount must be positive');
  }
  if (input.maximumP95DurationMs === 0) {
    throw new RangeError('maximumP95DurationMs must be positive');
  }
  if (input.maximumErrorRateBasisPoints > 10_000) {
    throw new RangeError('maximumErrorRateBasisPoints cannot exceed 10000');
  }

  const errorRateBasisPoints =
    input.invocationCount === 0
      ? 0
      : Math.floor(
          (input.failedInvocationCount / input.invocationCount) * 10_000
        );
  const hasMinimumTraffic =
    input.invocationCount >= input.minimumInvocationCount;
  const errorRateExceeded =
    errorRateBasisPoints > input.maximumErrorRateBasisPoints;
  const p95DurationExceeded = input.p95DurationMs > input.maximumP95DurationMs;

  if (hasMinimumTraffic && errorRateExceeded && p95DurationExceeded) {
    return {
      decision: 'rollback',
      reason: 'error_rate_and_p95_duration_exceeded',
      errorRateBasisPoints,
    };
  }
  if (hasMinimumTraffic && errorRateExceeded) {
    return {
      decision: 'rollback',
      reason: 'error_rate_exceeded',
      errorRateBasisPoints,
    };
  }
  if (hasMinimumTraffic && p95DurationExceeded) {
    return {
      decision: 'rollback',
      reason: 'p95_duration_exceeded',
      errorRateBasisPoints,
    };
  }
  if (input.evaluatedAt.getTime() < input.windowEndsAt.getTime()) {
    return {
      decision: 'monitoring',
      reason: 'observation_window_open',
      errorRateBasisPoints,
    };
  }
  if (!hasMinimumTraffic) {
    return {
      decision: 'rollback',
      reason: 'insufficient_invocations',
      errorRateBasisPoints,
    };
  }
  return {
    decision: 'passed',
    reason: 'within_thresholds',
    errorRateBasisPoints,
  };
}
