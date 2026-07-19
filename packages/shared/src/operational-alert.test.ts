import { describe, expect, it } from 'vitest';

import {
  buildOperationalAlertWebhookPayload,
  calculateOperationalAlertRetryDelayMs,
  type OperationalAlertEnvelope,
} from './operational-alert.js';

const alert: OperationalAlertEnvelope = {
  id: 'alert-1',
  kind: 'canary_rolled_back',
  severity: 'critical',
  sourceType: 'model_canary_run',
  sourceId: 'canary-1',
  summary: 'production <rollback> & notify <!channel>',
  details: { revision: 3 },
  occurredAt: '2026-07-19T06:00:00.000Z',
};

describe('operational alert webhook', () => {
  it('generic payload에 schema version과 원문 없는 envelope를 보존한다', () => {
    expect(buildOperationalAlertWebhookPayload(alert, 'generic')).toEqual({
      schemaVersion: 'operational-alert-v1',
      alert,
    });
  });

  it('Slack payload에서 markup과 mention을 escape한다', () => {
    const payload = buildOperationalAlertWebhookPayload(alert, 'slack');
    expect(payload.text).toContain('&lt;rollback&gt;');
    expect(payload.text).toContain('&lt;!channel&gt;');
    expect(payload.text).not.toContain('<!channel>');
  });

  it('재시도 간격을 지수 증가시키고 15분으로 제한한다', () => {
    expect(calculateOperationalAlertRetryDelayMs(1)).toBe(30_000);
    expect(calculateOperationalAlertRetryDelayMs(3)).toBe(120_000);
    expect(calculateOperationalAlertRetryDelayMs(20)).toBe(900_000);
    expect(() => calculateOperationalAlertRetryDelayMs(0)).toThrow(
      'positive integer',
    );
  });
});
