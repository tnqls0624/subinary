/** 원문이나 식별자를 포함하지 않는 큐 집계 입력. */
export interface OperationalQueueMetricInput {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  oldestPendingAgeSeconds: number | null;
}
/** 분모가 0이면 0bp를 반환하고 결과를 0~10,000bp로 제한한다. */
export function calculateRateBasisPoints(
  numerator: number,
  denominator: number,
): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    throw new Error('metric rate inputs must be finite');
  }
  if (numerator < 0 || denominator < 0) {
    throw new Error('metric rate inputs must be non-negative');
  }
  if (denominator === 0) return 0;
  return Math.min(10_000, Math.round((numerator / denominator) * 10_000));
}

/** BullMQ job timestamp를 현재 시각 기준 정수 초 age로 변환한다. */
export function calculatePendingAgeSeconds(
  timestampMs: number | null,
  nowMs: number,
): number | null {
  if (timestampMs === null) return null;
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) {
    throw new Error('metric timestamps must be finite');
  }
  return Math.max(0, Math.floor((nowMs - timestampMs) / 1_000));
}

/** 큐별 집계를 서버 전체 합계로 축약한다. */
export function summarizeOperationalQueues(
  metrics: readonly OperationalQueueMetricInput[],
): OperationalQueueMetricInput {
  return metrics.reduce<OperationalQueueMetricInput>(
    (summary, metric) => ({
      waiting: summary.waiting + metric.waiting,
      active: summary.active + metric.active,
      delayed: summary.delayed + metric.delayed,
      failed: summary.failed + metric.failed,
      oldestPendingAgeSeconds:
        metric.oldestPendingAgeSeconds === null
          ? summary.oldestPendingAgeSeconds
          : Math.max(
              summary.oldestPendingAgeSeconds ?? 0,
              metric.oldestPendingAgeSeconds,
            ),
    }),
    {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      oldestPendingAgeSeconds: null,
    },
  );
}
