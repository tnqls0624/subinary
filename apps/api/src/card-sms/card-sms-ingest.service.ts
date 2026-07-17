/**
 * Card-SMS ingestion service (Phase 3 Build Spec §5.2).
 *
 * Accepts an HMAC-authenticated card-SMS payload from a registered device,
 * persists the raw text twice (a generic `source_items` record + a convenience
 * copy on `card_sms_events.rawContent`), stores the original bytes in MinIO, and
 * enqueues an asynchronous parse job.
 *
 * Idempotency (PRD §14 / spec §1.2): the `UNIQUE(device_id, event_id)`
 * constraint on `card_sms_events` guarantees that re-transmitting the same
 * device/event never stores a duplicate or re-parses. A duplicate returns a
 * successful `duplicate:true` response and performs no MinIO write or enqueue.
 *
 * Secret hygiene (spec §1.1): the raw SMS text and any PII are never logged —
 * only the event id, content hash, and processing status are emitted.
 */
import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';

import type { CardSmsIngestRequest, CardSmsIngestResponse } from '@family/contracts';
import { isUniqueViolation, schema, type Db } from '@family/database';
import { QUEUE_NAMES } from '@family/shared';

import { DB } from '../database/database.constants';
import type { DeviceContext } from '../devices/decorators/device.decorator';
import { ObjectStorageService } from '../storage/object-storage.service';

/**
 * Internal sentinel thrown inside the ingest transaction when the event insert
 * conflicts, so the just-inserted `source_items` row rolls back (no orphan)
 * before the caller returns an idempotent `duplicate` response.
 */
class DuplicateEventError extends Error {
  constructor() {
    super('duplicate card-sms event');
    this.name = 'DuplicateEventError';
  }
}

@Injectable()
export class CardSmsIngestService {
  private readonly logger = new Logger(CardSmsIngestService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    @InjectQueue(QUEUE_NAMES.CARD_SMS_PARSE) private readonly parseQueue: Queue,
  ) {}

  /**
   * Ingests a card-SMS payload for the authenticated device. Only a freshly
   * created event triggers a MinIO write and a parse enqueue; a re-transmission
   * is a no-op that still returns `accepted:true`.
   */
  async ingest(
    device: DeviceContext,
    input: CardSmsIngestRequest,
  ): Promise<CardSmsIngestResponse> {
    const contentHash = this.hashContent(input);
    const objectKey = `card-sms/${device.householdId}/${input.eventId}.txt`;
    const receivedAt = new Date(input.receivedAt);
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');

    // Fast path: an existing (deviceId, eventId) event is an idempotent hit —
    // no source-item insert, no MinIO write, no enqueue.
    const [existing] = await this.db
      .select({ id: schema.cardSmsEvents.id })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.deviceId, device.deviceId),
          eq(schema.cardSmsEvents.eventId, input.eventId),
        ),
      )
      .limit(1);

    if (existing) {
      this.logger.log(
        `card-sms ingest duplicate id=${existing.id} status=duplicate`,
      );
      return this.duplicateResponse(input.eventId);
    }

    // Insert the source item and event atomically. A concurrent request that
    // wins the (deviceId, eventId) race is absorbed by onConflictDoNothing
    // (empty return) or a unique violation — both roll back and read as a
    // duplicate.
    let created: schema.CardSmsEvent | null;
    try {
      created = await this.db.transaction(async (tx) => {
        const [sourceItem] = await tx
          .insert(schema.sourceItems)
          .values({
            householdId: device.householdId,
            kind: 'card_sms',
            objectKey,
            contentHash,
            sizeBytes,
            deviceId: device.deviceId,
            memberId: device.memberId,
            receivedAt,
          })
          .returning();
        if (!sourceItem) {
          throw new Error('failed to create source item');
        }

        const [event] = await tx
          .insert(schema.cardSmsEvents)
          .values({
            householdId: device.householdId,
            memberId: device.memberId,
            deviceId: device.deviceId,
            sourceItemId: sourceItem.id,
            eventId: input.eventId,
            sender: input.sender,
            rawContent: input.content,
            contentHash,
            receivedAt,
            parseStatus: 'pending',
          })
          .onConflictDoNothing({
            target: [schema.cardSmsEvents.deviceId, schema.cardSmsEvents.eventId],
          })
          .returning();

        if (!event) {
          throw new DuplicateEventError();
        }
        return event;
      });
    } catch (error) {
      if (error instanceof DuplicateEventError || isUniqueViolation(error)) {
        created = null;
      } else {
        throw error;
      }
    }

    if (!created) {
      this.logger.log('card-sms ingest duplicate (race) status=duplicate');
      return this.duplicateResponse(input.eventId);
    }

    // Best-effort raw-object write. A MinIO failure must not fail ingestion —
    // the DB rawContent copy lets the worker parse regardless — so we warn and
    // still enqueue.
    try {
      await this.storage.putObject(
        objectKey,
        input.content,
        'text/plain; charset=utf-8',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `card-sms putObject failed id=${created.id} (ingest continues): ${message}`,
      );
    }

    // Enqueue the parse job keyed by the event id so BullMQ also deduplicates
    // any accidental re-enqueue at the queue level.
    await this.parseQueue.add(
      'parse',
      { cardSmsEventId: created.id },
      { jobId: created.id },
    );

    this.logger.log(
      `card-sms ingest accepted id=${created.id} hash=${contentHash.slice(0, 12)} status=queued`,
    );
    return {
      accepted: true,
      eventId: input.eventId,
      processingStatus: 'queued',
      duplicate: false,
    };
  }

  /** `sha256(sender + "\n" + content + "\n" + receivedAtISO)` as lowercase hex. */
  private hashContent(input: CardSmsIngestRequest): string {
    return createHash('sha256')
      .update(`${input.sender}\n${input.content}\n${input.receivedAt}`, 'utf8')
      .digest('hex');
  }

  /** Idempotent-success response for a re-transmitted event. */
  private duplicateResponse(eventId: string): CardSmsIngestResponse {
    return {
      accepted: true,
      eventId,
      processingStatus: 'duplicate',
      duplicate: true,
    };
  }
}
