import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { schema, type Db } from '@family/database';
import {
  calculateOutboxRetryDelayMs,
  createLogger,
  createOutboxJobId,
  OutboxPayloadError,
  QUEUE_NAMES,
  resolveOutboxQueueRoute,
  type OutboxQueueRoute,
} from '@family/shared';

import { DB } from '../database/database.module';

const POLL_INTERVAL_MS = 2_000;
const CLAIM_BATCH_SIZE = 25;
const LOCK_LEASE_MS = 60_000;
const MAX_PUBLISH_ATTEMPTS = 5;

/** 한 번의 dispatcher poll 결과. 운영 metric과 통합 검증에 사용한다. */
export interface OutboxDispatchSummary {
  claimed: number;
  published: number;
  retried: number;
  quarantined: number;
}

/**
 * PostgreSQL transactional outbox를 BullMQ로 at-least-once 발행한다.
 * 여러 worker instance가 동시에 poll해도 `FOR UPDATE SKIP LOCKED`와 lease로
 * event를 분배하며, BullMQ job id는 outbox event id로 고정해 중복을 흡수한다.
 */
@Injectable()
export class OutboxDispatcherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = createLogger('worker:outbox-dispatcher', {
    pretty: process.env.NODE_ENV !== 'production',
  });
  private readonly instanceId = `${process.pid}-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @InjectQueue(QUEUE_NAMES.SLACK_IMPORT)
    private readonly slackImportQueue: Queue,
    @InjectQueue(QUEUE_NAMES.CARD_SMS_PARSE)
    private readonly cardSmsParseQueue: Queue,
    @InjectQueue(QUEUE_NAMES.RAG_INDEX)
    private readonly ragIndexQueue: Queue,
    @InjectQueue(QUEUE_NAMES.SOURCE_TOMBSTONE)
    private readonly sourceTombstoneQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MEMORY_EXTRACT)
    private readonly memoryExtractQueue: Queue,
    @InjectQueue(QUEUE_NAMES.GRAPH_EXTRACT)
    private readonly graphExtractQueue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.dispatchPending().catch((error: unknown) => {
        this.logger.error(
          { errorCode: this.errorCode(error) },
          'outbox poll failed',
        );
      });
    }, POLL_INTERVAL_MS);
    this.timer.unref();
    void this.dispatchPending().catch((error: unknown) => {
      this.logger.error(
        { errorCode: this.errorCode(error) },
        'initial outbox poll failed',
      );
    });
  }
  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 현재 available event batch를 claim하고 queue 발행 결과를 DB에 반영한다. */
  async dispatchPending(): Promise<OutboxDispatchSummary> {
    if (this.dispatching) {
      return { claimed: 0, published: 0, retried: 0, quarantined: 0 };
    }
    this.dispatching = true;
    try {
      const events = await this.claimPendingEvents();
      const summary: OutboxDispatchSummary = {
        claimed: events.length,
        published: 0,
        retried: 0,
        quarantined: 0,
      };
      for (const event of events) {
        try {
          const route = resolveOutboxQueueRoute(event.eventType, event.payload);
          const queue = this.queueFor(route);
          await queue.add(route.jobName, route.jobData, {
            jobId: createOutboxJobId(event.id),
            removeOnComplete: { count: 1_000 },
            removeOnFail: { count: 1_000 },
          });
          await this.markPublished(event.id, event.publishAttempts + 1);
          summary.published += 1;
        } catch (error: unknown) {
          const quarantined = await this.markFailed(event, error);
          if (quarantined) {
            summary.quarantined += 1;
          } else {
            summary.retried += 1;
          }
        }
      }
      if (summary.claimed > 0) {
        this.logger.info(summary, 'outbox batch dispatched');
      }
      return summary;
    } finally {
      this.dispatching = false;
    }
  }

  private async claimPendingEvents(): Promise<schema.DataEvent[]> {
    return this.db.transaction(async (tx) => {
      const events = await tx
        .select()
        .from(schema.dataEvents)
        .where(
          and(
            isNull(schema.dataEvents.publishedAt),
            isNull(schema.dataEvents.quarantinedAt),
            lte(schema.dataEvents.availableAt, sql`now()`),
            or(
              isNull(schema.dataEvents.lockedAt),
              lt(
                schema.dataEvents.lockedAt,
                sql`now() - ${LOCK_LEASE_MS} * interval '1 millisecond'`,
              ),
            ),
          ),
        )
        .orderBy(asc(schema.dataEvents.occurredAt), asc(schema.dataEvents.id))
        .limit(CLAIM_BATCH_SIZE)
        .for('update', { skipLocked: true });
      if (events.length === 0) {
        return [];
      }
      await tx
        .update(schema.dataEvents)
        .set({
          lockedAt: sql`now()`,
          lockedBy: this.instanceId,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            schema.dataEvents.id,
            events.map((event) => event.id),
          ),
        );
      return events;
    });
  }

  private queueFor(route: OutboxQueueRoute): Queue {
    switch (route.queueName) {
      case QUEUE_NAMES.SLACK_IMPORT:
        return this.slackImportQueue;
      case QUEUE_NAMES.CARD_SMS_PARSE:
        return this.cardSmsParseQueue;
      case QUEUE_NAMES.RAG_INDEX:
        return this.ragIndexQueue;
      case QUEUE_NAMES.SOURCE_TOMBSTONE:
        return this.sourceTombstoneQueue;
      case QUEUE_NAMES.MEMORY_EXTRACT:
        return this.memoryExtractQueue;
      case QUEUE_NAMES.GRAPH_EXTRACT:
        return this.graphExtractQueue;
    }
  }

  private async markPublished(
    eventId: string,
    publishAttempts: number,
  ): Promise<void> {
    await this.db
      .update(schema.dataEvents)
      .set({
        publishAttempts,
        publishedAt: sql`now()`,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.dataEvents.id, eventId),
          eq(schema.dataEvents.lockedBy, this.instanceId),
        ),
      );
  }

  private async markFailed(
    event: schema.DataEvent,
    error: unknown,
  ): Promise<boolean> {
    const nextAttempt = event.publishAttempts + 1;
    const deterministicFailure = error instanceof OutboxPayloadError;
    const quarantined =
      deterministicFailure || nextAttempt >= MAX_PUBLISH_ATTEMPTS;
    const retryDelayMs = quarantined
      ? null
      : calculateOutboxRetryDelayMs(nextAttempt);
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.dataEvents)
        .set({
          publishAttempts: nextAttempt,
          availableAt: quarantined
            ? event.availableAt
            : sql`now() + ${retryDelayMs} * interval '1 millisecond'`,
          lockedAt: null,
          lockedBy: null,
          quarantinedAt: quarantined ? sql`now()` : null,
          lastErrorCode: this.errorCode(error),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.dataEvents.id, event.id),
            eq(schema.dataEvents.lockedBy, this.instanceId),
          ),
        )
        .returning({ id: schema.dataEvents.id });
      if (quarantined && updated.length > 0) {
        await tx
          .insert(schema.operationalAlerts)
          .values({
            dedupeKey: `data-event:${event.id}:quarantined`,
            kind: 'outbox_quarantined',
            severity: 'critical',
            sourceType: 'data_event',
            sourceId: event.id,
            summary: `${event.eventType} outbox event quarantined`,
            details: {
              eventType: event.eventType,
              publishAttempts: nextAttempt,
              errorCode: this.errorCode(error),
            },
            occurredAt: new Date(),
          })
          .onConflictDoNothing({
            target: schema.operationalAlerts.dedupeKey,
          });
      }
    });
    this.logger.warn(
      {
        eventId: event.id,
        eventType: event.eventType,
        errorCode: this.errorCode(error),
        publishAttempts: nextAttempt,
        quarantined,
      },
      'outbox event publish failed',
    );
    return quarantined;
  }

  private errorCode(error: unknown): string {
    return error instanceof Error && error.name.length > 0
      ? error.name
      : 'UnknownError';
  }
}
