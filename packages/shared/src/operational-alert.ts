/** 외부 운영 알림 종류. 원문이나 사용자 식별자는 포함하지 않는다. */
export type OperationalAlertKind =
  | 'pipeline_failed'
  | 'outbox_quarantined'
  | 'canary_rolled_back'
  | 'canary_suspended'
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
