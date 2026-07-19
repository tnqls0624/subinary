/** 외부 운영 알림 종류. 원문이나 사용자 식별자는 포함하지 않는다. */
export type OperationalAlertKind =
  | 'pipeline_failed'
  | 'outbox_quarantined'
  | 'canary_rolled_back'
  | 'canary_suspended';

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
  if (format === 'slack') {
    return buildSlackPayload(alert);
  }
  return {
    schemaVersion: 'operational-alert-v1',
    alert,
  };
}

/** 외부 알림 재시도 간격: 30초부터 시작해 최대 15분으로 제한한다. */
export function calculateOperationalAlertRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('operational alert attempt must be a positive integer');
  }
  return Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000);
}
