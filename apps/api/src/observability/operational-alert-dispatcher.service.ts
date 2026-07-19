import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';

import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';
import {
  buildOperationalAlertWebhookPayload,
  calculateOperationalAlertRetryDelayMs,
  type OperationalAlertEnvelope,
  type OperationalAlertWebhookFormat,
} from '@family/shared';

import { DB } from '../database/database.constants';

const LOCK_LEASE_MS = 60_000;

export interface OperationalAlertDispatchSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * 운영 알림 DB outbox를 generic/Slack webhook으로 at-least-once 전달한다.
 * 응답 본문과 webhook URL/token은 로그에 남기지 않는다.
 */
@Injectable()
export class OperationalAlertDispatcherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OperationalAlertDispatcherService.name);
  private readonly instanceId = `${process.pid}-${randomUUID()}`;
  private readonly webhookUrl: string | undefined;
  private readonly bearerToken: string | undefined;
  private readonly format: OperationalAlertWebhookFormat;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    configService: ConfigService,
  ) {
    const config =
      configService.get<AppConfig['observability']>('observability');
    this.webhookUrl = config?.alertWebhookUrl;
    this.bearerToken = config?.alertWebhookBearerToken;
    this.format = config?.alertWebhookFormat ?? 'generic';
    this.intervalMs = config?.alertPollIntervalMs ?? 30_000;
    this.batchSize = config?.alertBatchSize ?? 20;
    this.requestTimeoutMs = config?.alertRequestTimeoutMs ?? 5_000;
    this.maxAttempts = config?.alertMaxAttempts ?? 8;
  }

  onApplicationBootstrap(): void {
    if (!this.webhookUrl) {
      this.logger.warn(
        'pipeline alert webhook is not configured; alerts will remain pending',
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.dispatchPending().catch((error: unknown) => {
        this.logger.error(
          `operational alert poll failed errorCode=${this.errorCode(error)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref();
    void this.dispatchPending().catch((error: unknown) => {
      this.logger.error(
        `initial operational alert poll failed errorCode=${this.errorCode(error)}`,
      );
    });
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 현재 전달 가능한 alert batch를 claim하고 외부 webhook에 발송한다. */
  async dispatchPending(): Promise<OperationalAlertDispatchSummary> {
    if (!this.webhookUrl || this.dispatching) {
      return { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    }
    this.dispatching = true;
    try {
      const alerts = await this.claimPending();
      const summary: OperationalAlertDispatchSummary = {
        claimed: alerts.length,
        delivered: 0,
        retried: 0,
        failed: 0,
      };
      for (const alert of alerts) {
        try {
          await this.deliver(alert);
          await this.markDelivered(alert.id, alert.deliveryAttempts + 1);
          summary.delivered += 1;
        } catch (error: unknown) {
          const terminal = await this.markDeliveryFailed(alert, error);
          if (terminal) summary.failed += 1;
          else summary.retried += 1;
        }
      }
      if (summary.claimed > 0) {
        this.logger.log(
          `operational alert batch claimed=${summary.claimed} ` +
            `delivered=${summary.delivered} retried=${summary.retried} ` +
            `failed=${summary.failed}`,
        );
      }
      return summary;
    } finally {
      this.dispatching = false;
    }
  }

  private async claimPending(): Promise<schema.OperationalAlert[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.operationalAlerts)
        .where(
          and(
            eq(schema.operationalAlerts.status, 'pending'),
            lte(schema.operationalAlerts.availableAt, sql`now()`),
            or(
              sql`${schema.operationalAlerts.lockedAt} is null`,
              lt(
                schema.operationalAlerts.lockedAt,
                sql`now() - ${LOCK_LEASE_MS} * interval '1 millisecond'`,
              ),
            ),
          ),
        )
        .orderBy(
          asc(schema.operationalAlerts.occurredAt),
          asc(schema.operationalAlerts.id),
        )
        .limit(this.batchSize)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return [];
      await tx
        .update(schema.operationalAlerts)
        .set({
          lockedAt: sql`now()`,
          lockedBy: this.instanceId,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            schema.operationalAlerts.id,
            rows.map((row) => row.id),
          ),
        );
      return rows;
    });
  }

  private async deliver(alert: schema.OperationalAlert): Promise<void> {
    if (!this.webhookUrl) return;
    const envelope: OperationalAlertEnvelope = {
      id: alert.id,
      kind: alert.kind,
      severity: alert.severity,
      sourceType: alert.sourceType,
      sourceId: alert.sourceId,
      summary: alert.summary,
      details: alert.details,
      occurredAt: alert.occurredAt.toISOString(),
    };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.bearerToken) {
      headers.authorization = `Bearer ${this.bearerToken}`;
    }
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        buildOperationalAlertWebhookPayload(envelope, this.format),
      ),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      const family = Math.floor(response.status / 100);
      throw new Error(`WebhookHttp${family}xx`);
    }
  }

  private async markDelivered(
    alertId: string,
    deliveryAttempts: number,
  ): Promise<void> {
    await this.db
      .update(schema.operationalAlerts)
      .set({
        status: 'delivered',
        deliveryAttempts,
        deliveredAt: sql`now()`,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.operationalAlerts.id, alertId),
          eq(schema.operationalAlerts.lockedBy, this.instanceId),
        ),
      );
  }

  private async markDeliveryFailed(
    alert: schema.OperationalAlert,
    error: unknown,
  ): Promise<boolean> {
    const nextAttempt = alert.deliveryAttempts + 1;
    const terminal = nextAttempt >= this.maxAttempts;
    const retryDelayMs = terminal
      ? null
      : calculateOperationalAlertRetryDelayMs(nextAttempt);
    await this.db
      .update(schema.operationalAlerts)
      .set({
        status: terminal ? 'failed' : 'pending',
        deliveryAttempts: nextAttempt,
        availableAt: terminal
          ? alert.availableAt
          : sql`now() + ${retryDelayMs} * interval '1 millisecond'`,
        lockedAt: null,
        lockedBy: null,
        failedAt: terminal ? sql`now()` : null,
        lastErrorCode: this.errorCode(error),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.operationalAlerts.id, alert.id),
          eq(schema.operationalAlerts.lockedBy, this.instanceId),
        ),
      );
    this.logger.warn(
      `operational alert delivery failed alertId=${alert.id} ` +
        `attempt=${nextAttempt} terminal=${terminal} ` +
        `errorCode=${this.errorCode(error)}`,
    );
    return terminal;
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && error.message.startsWith('WebhookHttp')) {
      return error.message;
    }
    return error instanceof Error && error.name.length > 0
      ? error.name
      : 'UnknownError';
  }
}
