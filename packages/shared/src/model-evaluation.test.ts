import { describe, expect, it } from 'vitest';

import { evaluateModelGate } from './model-evaluation.js';

describe('evaluateModelGate', () => {
  it('전체 절대값과 baseline 대비 변화량 gate를 모두 통과한다', () => {
    const result = evaluateModelGate({
      baselineMetrics: { accuracy: 0.82, p95LatencyMs: 140 },
      candidateMetrics: { accuracy: 0.88, p95LatencyMs: 120 },
      criteria: [
        {
          metric: 'accuracy',
          comparison: 'candidate',
          operator: 'gte',
          threshold: 0.85,
        },
        {
          metric: 'p95LatencyMs',
          comparison: 'delta',
          operator: 'lte',
          threshold: 0,
        },
      ],
    });

    expect(result.result).toBe('passed');
    expect(result.details.map((detail) => detail.observedValue)).toEqual([
      0.88,
      -20,
    ]);
  });

  it('slice 회귀를 전체 통과와 별개로 실패시킨다', () => {
    const result = evaluateModelGate({
      candidateMetrics: { accuracy: 0.9 },
      candidateSliceMetrics: {
        rare: { accuracy: 0.61 },
      },
      criteria: [
        {
          metric: 'accuracy',
          comparison: 'candidate',
          operator: 'gte',
          threshold: 0.8,
        },
        {
          metric: 'accuracy',
          slice: 'rare',
          comparison: 'candidate',
          operator: 'gte',
          threshold: 0.7,
        },
      ],
    });

    expect(result.result).toBe('failed');
    expect(result.details[1]).toMatchObject({
      observedValue: 0.61,
      passed: false,
      failureCode: null,
    });
  });

  it('누락된 candidate와 baseline metric을 fail-closed 처리한다', () => {
    const result = evaluateModelGate({
      candidateMetrics: {},
      criteria: [
        {
          metric: 'accuracy',
          comparison: 'candidate',
          operator: 'gte',
          threshold: 0.8,
        },
        {
          metric: 'f1',
          comparison: 'delta',
          operator: 'gte',
          threshold: 0,
        },
      ],
    });

    expect(result.result).toBe('failed');
    expect(result.details.map((detail) => detail.failureCode)).toEqual([
      'metric_missing',
      'metric_missing',
    ]);
  });

  it('candidate는 있지만 baseline이 없는 delta gate를 실패시킨다', () => {
    const result = evaluateModelGate({
      candidateMetrics: { accuracy: 0.9 },
      criteria: [
        {
          metric: 'accuracy',
          comparison: 'delta',
          operator: 'gte',
          threshold: 0,
        },
      ],
    });

    expect(result.details[0]?.failureCode).toBe('baseline_missing');
    expect(result.result).toBe('failed');
  });

  it('기준이 비어 있으면 모델을 통과시키지 않는다', () => {
    expect(
      evaluateModelGate({ candidateMetrics: { accuracy: 1 }, criteria: [] }),
    ).toEqual({ result: 'failed', details: [] });
  });
});
