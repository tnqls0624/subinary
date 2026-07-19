/** 모델 평가에서 사용하는 원문 없는 수치 metric 집합. */
export type ModelMetricSet = Readonly<Record<string, number>>;

/** slice 이름별 metric 집합. 빈 객체는 전체 지표만 평가한다는 뜻이다. */
export type ModelSliceMetricSet = Readonly<Record<string, ModelMetricSet>>;

/** gate가 비교할 값의 종류. delta는 candidate - baseline이다. */
export type ModelGateComparison = 'candidate' | 'delta';

/** 수치 gate 비교 연산자. */
export type ModelGateOperator = 'gte' | 'lte';

/** 한 개 품질 gate 기준. slice가 없으면 전체 metric을 사용한다. */
export interface ModelGateCriterion {
  metric: string;
  slice?: string;
  comparison: ModelGateComparison;
  operator: ModelGateOperator;
  threshold: number;
}

/** 기준별 서버 판정 결과. 누락/비정상 지표는 통과시키지 않는다. */
export interface ModelGateCriterionResult extends ModelGateCriterion {
  observedValue: number | null;
  passed: boolean;
  failureCode: 'metric_missing' | 'baseline_missing' | 'non_finite_metric' | null;
}

/** 결정적 모델 gate 입력. */
export interface EvaluateModelGateInput {
  baselineMetrics?: ModelMetricSet;
  candidateMetrics: ModelMetricSet;
  baselineSliceMetrics?: ModelSliceMetricSet;
  candidateSliceMetrics?: ModelSliceMetricSet;
  criteria: readonly ModelGateCriterion[];
}

/** 전체 gate 결과와 기준별 근거. */
export interface ModelGateEvaluation {
  result: 'passed' | 'failed';
  details: ModelGateCriterionResult[];
}

function resolveMetric(
  metrics: ModelMetricSet | undefined,
  sliceMetrics: ModelSliceMetricSet | undefined,
  criterion: ModelGateCriterion,
): number | undefined {
  if (criterion.slice === undefined) {
    return metrics?.[criterion.metric];
  }
  return sliceMetrics?.[criterion.slice]?.[criterion.metric];
}

/**
 * 외부 evaluator가 제출한 gateResult를 신뢰하지 않고 저장 직전 서버에서 다시
 * 계산한다. 같은 입력은 항상 같은 결과를 만들며, metric 누락과 NaN/Infinity는
 * 명시적인 실패로 처리한다.
 */
export function evaluateModelGate(
  input: EvaluateModelGateInput,
): ModelGateEvaluation {
  const details = input.criteria.map<ModelGateCriterionResult>((criterion) => {
    const candidateValue = resolveMetric(
      input.candidateMetrics,
      input.candidateSliceMetrics,
      criterion,
    );
    if (candidateValue === undefined) {
      return {
        ...criterion,
        observedValue: null,
        passed: false,
        failureCode: 'metric_missing',
      };
    }
    if (!Number.isFinite(candidateValue)) {
      return {
        ...criterion,
        observedValue: null,
        passed: false,
        failureCode: 'non_finite_metric',
      };
    }

    let observedValue = candidateValue;
    if (criterion.comparison === 'delta') {
      const baselineValue = resolveMetric(
        input.baselineMetrics,
        input.baselineSliceMetrics,
        criterion,
      );
      if (baselineValue === undefined) {
        return {
          ...criterion,
          observedValue: null,
          passed: false,
          failureCode: 'baseline_missing',
        };
      }
      if (!Number.isFinite(baselineValue)) {
        return {
          ...criterion,
          observedValue: null,
          passed: false,
          failureCode: 'non_finite_metric',
        };
      }
      observedValue -= baselineValue;
    }

    const passed = criterion.operator === 'gte'
      ? observedValue >= criterion.threshold
      : observedValue <= criterion.threshold;
    return {
      ...criterion,
      observedValue,
      passed,
      failureCode: null,
    };
  });

  return {
    result: details.length > 0 && details.every((detail) => detail.passed)
      ? 'passed'
      : 'failed',
    details,
  };
}
