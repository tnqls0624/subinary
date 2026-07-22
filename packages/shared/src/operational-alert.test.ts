import { describe, expect, it } from 'vitest';

import {
  buildOperationalAlertWebhookPayload,
  calculateOperationalAlertRetryDelayMs,
  sanitizeOperationalAlertEnvelope,
  type OperationalAlertEnvelope,
} from './operational-alert.js';

const alert: OperationalAlertEnvelope = {
  id: 'alert-1',
  kind: 'canary_rolled_back',
  severity: 'critical',
  sourceType: 'model_canary_run',
  sourceId: 'canary-1',
  summary: 'production <rollback> & notify <!channel>',
  details: { evaluatedRevision: 3 },
  occurredAt: '2026-07-19T06:00:00.000Z',
};

describe('operational alert webhook', () => {
  it('generic payload에 schema version과 원문 없는 envelope를 보존한다', () => {
    expect(buildOperationalAlertWebhookPayload(alert, 'generic')).toEqual({
      schemaVersion: 'operational-alert-v1',
      alert,
    });
  });

  it('generic payload에서 kind별 허용 필드 외 PII·secret·중첩 값을 제거한다', () => {
    const unsafeAlert: OperationalAlertEnvelope = {
      ...alert,
      kind: 'pipeline_failed',
      summary: 'pipeline failed\u0000with-control',
      details: {
        pipelineName: 'training',
        attempt: 3,
        errorCode: 'TimeoutError',
        userId: 'user-1',
        rawText: '카드 승인 원문',
        secret: 'do-not-send',
        nested: { token: 'nested-secret' },
      },
    };

    expect(buildOperationalAlertWebhookPayload(unsafeAlert, 'generic')).toEqual({
      schemaVersion: 'operational-alert-v1',
      alert: {
        ...unsafeAlert,
        summary: 'pipeline failedwith-control',
        details: {
          pipelineName: 'training',
          attempt: 3,
          errorCode: 'TimeoutError',
        },
      },
    });
  });

  it('backup·disk 알림에는 상태 전이와 수치형 측정값만 허용한다', () => {
    const backupAlert: OperationalAlertEnvelope = {
      ...alert,
      kind: 'backup_stale',
      sourceType: 'host_monitor',
      sourceId: 'backup',
      details: {
        transition: 'firing',
        observedAgeSeconds: 90_001,
        maxAgeSeconds: 90_000,
        backupPath: '/private/backup',
      },
    };
    const diskAlert: OperationalAlertEnvelope = {
      ...alert,
      kind: 'disk_low',
      sourceType: 'host_monitor',
      sourceId: 'host-disk',
      details: {
        transition: 'recovered',
        availableBytes: 50_000_000_000,
        totalBytes: 500_000_000_000,
        availablePercent: 10,
        minFreeBytes: 42_949_672_960,
        minFreePercent: 10,
        mountPath: '/monitored/backups',
      },
    };

    expect(sanitizeOperationalAlertEnvelope(backupAlert).details).toEqual({
      transition: 'firing',
      observedAgeSeconds: 90_001,
      maxAgeSeconds: 90_000,
    });
    expect(sanitizeOperationalAlertEnvelope(diskAlert).details).toEqual({
      transition: 'recovered',
      availableBytes: 50_000_000_000,
      totalBytes: 500_000_000_000,
      availablePercent: 10,
      minFreeBytes: 42_949_672_960,
      minFreePercent: 10,
    });
  });

  it('허용 문자열도 제어문자를 제거하고 길이를 제한한다', () => {
    const sanitized = sanitizeOperationalAlertEnvelope({
      ...alert,
      kind: 'outbox_quarantined',
      details: {
        eventType: `event\n${'x'.repeat(600)}`,
        publishAttempts: 8,
        errorCode: 'PayloadError',
      },
    });

    expect(sanitized.details.eventType).toBe(`event${'x'.repeat(251)}`);
    expect(String(sanitized.details.eventType)).toHaveLength(256);
  });

  it('receiver synthetic test에는 고정 상태와 boolean만 유지한다', () => {
    const sanitized = sanitizeOperationalAlertEnvelope({
      ...alert,
      kind: 'receiver_test',
      details: {
        transition: 'firing',
        test: true,
        webhookUrl: 'https://secret.example.com',
      },
    });

    expect(sanitized.details).toEqual({ transition: 'firing', test: true });
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
