/** 외부 운영 알림 종류. 원문이나 사용자 식별자는 포함하지 않는다. */
export type OperationalAlertKind =
  | 'pipeline_failed'
  | 'outbox_quarantined'
  | 'canary_rolled_back'
  | 'canary_suspended'
  /** 등록 장치에서 카드 문자 유입이 임계 시간 이상 끊김(재전송 없음 → 유실 위험). */
  | 'card_sms_collection_gap'
  /**
   * 파싱은 됐는데 거래로 승격되지 않고 임계 시간 이상 멈춘 이벤트.
   * `collection_gap`(유입 자체가 끊김)과 달리 **문자는 들어왔고 파싱도 성공했는데
   * 집계에서만 빠진** 상태다 — 사용자 눈에는 결제가 없었던 것처럼 보인다.
   */
  | 'card_sms_promotion_stalled'
  | 'backup_stale'
  | 'disk_low'
  | 'receiver_test';

export type OperationalAlertSeverity = 'warning' | 'critical';
export type OperationalAlertWebhookFormat = 'generic' | 'slack';

/** DB outbox에서 외부 webhook으로 전달할 최소 메타데이터. */
export interface OperationalAlertEnvelope {
  id: string;
  kind: OperationalAlertKind;
  severity: OperationalAlertSeverity;
  sourceType: string;
  sourceId: string;
  summary: string;
  details: Record<string, unknown>;
  occurredAt: string;
}

type OperationalAlertDetailValue = string | number | boolean | null;

const MAX_EXTERNAL_TEXT_LENGTH = 256;

const SAFE_DETAIL_KEYS: Readonly<
  Record<OperationalAlertKind, ReadonlySet<string>>
> = {
  pipeline_failed: new Set([
    'pipelineName',
    'pipelineVersion',
    'stepName',
    'stepVersion',
    'trigger',
    'attempt',
    'errorCode',
  ]),
  outbox_quarantined: new Set([
    'eventType',
    'publishAttempts',
    'errorCode',
  ]),
  // 장치·가구 식별자와 시각만. 카드 문자 원문·가맹점·금액은 절대 넣지 않는다
  // (경보는 외부 webhook으로 나간다).
  card_sms_collection_gap: new Set([
    'deviceId',
    'householdId',
    'lastSeenAt',
    'lastEventAt',
    'thresholdHours',
  ]),
  // 이벤트/가구 식별자와 시각·상태만. 가맹점·금액·원문은 금지(collection_gap과 동일 정책).
  // `amount`를 넣고 싶은 유혹이 있으나 그것이 곧 결제 내역 유출이다 — 수신자는
  // eventId로 관리자 화면에서 조회하면 된다.
  card_sms_promotion_stalled: new Set([
    'cardSmsEventId',
    'householdId',
    'parseStatus',
    'transactionType',
    'parsedAt',
    'stalledMinutes',
    'thresholdMinutes',
    'autoRecoveryAttempted',
  ]),
  canary_rolled_back: new Set([
    'task',
    'alias',
    'evaluatedRevision',
    'rollbackRevision',
    'reason',
    'trigger',
    'invocationCount',
    'failedInvocationCount',
    'errorRateBasisPoints',
    'p95DurationMs',
  ]),
  canary_suspended: new Set([
    'task',
    'alias',
    'evaluatedRevision',
    'rollbackRevision',
    'reason',
    'trigger',
    'invocationCount',
    'failedInvocationCount',
    'errorRateBasisPoints',
    'p95DurationMs',
  ]),
  backup_stale: new Set([
    'transition',
    'observedAgeSeconds',
    'maxAgeSeconds',
    'errorCode',
  ]),
  disk_low: new Set([
    'transition',
    'availableBytes',
    'totalBytes',
    'availablePercent',
    'minFreeBytes',
    'minFreePercent',
    'errorCode',
  ]),
  receiver_test: new Set(['transition', 'test']),
};

function sanitizeExternalText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, MAX_EXTERNAL_TEXT_LENGTH);
}

function sanitizeDetailValue(
  key: string,
  value: unknown,
): OperationalAlertDetailValue | undefined {
  if (key === 'transition') {
    return value === 'firing' || value === 'recovered' ? value : undefined;
  }
  if (typeof value === 'string') {
    return sanitizeExternalText(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean' || value === null) {
    return value;
  }
  return undefined;
}

/**
 * 외부 receiver로 보내기 전 kind별 허용 필드만 남긴다.
 * 원문, 사용자 식별자, secret 또는 중첩 객체는 기본적으로 폐기한다.
 */
export function sanitizeOperationalAlertEnvelope(
  alert: OperationalAlertEnvelope,
): OperationalAlertEnvelope {
  const allowedKeys = SAFE_DETAIL_KEYS[alert.kind];
  const details: Record<string, OperationalAlertDetailValue> = {};
  for (const [key, value] of Object.entries(alert.details)) {
    if (!allowedKeys.has(key)) continue;
    const sanitized = sanitizeDetailValue(key, value);
    if (sanitized !== undefined) {
      details[key] = sanitized;
    }
  }
  return {
    ...alert,
    summary: sanitizeExternalText(alert.summary),
    details,
  };
}

function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Slack mention/markup 해석을 막은 단문 알림 payload. */
function buildSlackPayload(alert: OperationalAlertEnvelope): Record<string, unknown> {
  const severity = alert.severity === 'critical' ? 'CRITICAL' : 'WARNING';
  return {
    text:
      `[subinary ${severity}] ${escapeSlackText(alert.summary)}\n` +
      `kind=${alert.kind} source=${escapeSlackText(alert.sourceType)} ` +
      `occurredAt=${alert.occurredAt}`,
  };
}

/** webhook 종류에 맞춰 원문 없는 versioned payload를 만든다. */
export function buildOperationalAlertWebhookPayload(
  alert: OperationalAlertEnvelope,
  format: OperationalAlertWebhookFormat,
): Record<string, unknown> {
  const sanitizedAlert = sanitizeOperationalAlertEnvelope(alert);
  if (format === 'slack') {
    return buildSlackPayload(sanitizedAlert);
  }
  return {
    schemaVersion: 'operational-alert-v1',
    alert: sanitizedAlert,
  };
}

/** 외부 알림 재시도 간격: 30초부터 시작해 최대 15분으로 제한한다. */
export function calculateOperationalAlertRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('operational alert attempt must be a positive integer');
  }
  return Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000);
}
