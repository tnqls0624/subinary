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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { CardSmsIngestRequest, CardSmsIngestResponse } from '@family/contracts';
import { isUniqueViolation, schema, type Db } from '@family/database';
import { OUTBOX_EVENT_TYPES } from '@family/shared';

import { DB } from '../database/database.constants';
import type { DeviceContext } from '../devices/decorators/device.decorator';
import { ObjectStorageService } from '../storage/object-storage.service';

/**
 * 멱등 키(eventId) 파생 규칙 — 단축어/MacroDroid처럼 고유값을 만들기 어려운 도구가
 * eventId를 비우면 서버가 채운다. `sha256(sender + "\n" + content [+ "\n" + receivedAt])`.
 * receivedAt(초 단위 권장)을 섞으면 같은 분·동일 가맹점·금액의 서로 다른 결제가
 * 구분되고, 같은 문자의 재전송은 값이 같아 멱등이 유지된다. card-sms-text 경로와
 * 동일 recipe라 어느 경로로 보내도 같은 문자는 같은 eventId가 된다.
 */
export function deriveCardSmsEventId(
  sender: string,
  content: string,
  receivedAt?: string,
): string {
  const tag = (receivedAt ?? '').trim();
  return createHash('sha256')
    .update(`${sender}\n${content}${tag ? `\n${tag}` : ''}`, 'utf8')
    .digest('hex');
}

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
    // eventId는 선택값 — 비었거나 없으면 sender+content(+receivedAt)로 파생한다.
    // 이후 모든 사용(멱등 키·objectKey·응답)은 이 해소된 값을 쓴다.
    const eventId =
      (input.eventId ?? '').trim() ||
      deriveCardSmsEventId(input.sender, input.content, input.receivedAt);

    // receivedAt is optional (automation tools like MacroDroid can't easily
    // format UTC) — fall back to the ingest instant.
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    const contentHash = this.hashContent(input);
    const objectKey = `card-sms/${device.householdId}/${eventId}.txt`;
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');

    // Fast path: an existing (deviceId, eventId) event is an idempotent hit —
    // no source-item insert, no MinIO write, no enqueue.
    const [existing] = await this.db
      .select({ id: schema.cardSmsEvents.id })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.deviceId, device.deviceId),
          eq(schema.cardSmsEvents.eventId, eventId),
        ),
      )
      .limit(1);

    if (existing) {
      this.logger.log(
        `card-sms ingest duplicate id=${existing.id} status=duplicate`,
      );
      return this.duplicateResponse(eventId);
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

        const [revision] = await tx
          .insert(schema.sourceRevisions)
          .values({
            sourceItemId: sourceItem.id,
            revision: 1,
            objectKey,
            contentHash,
            sizeBytes,
            parserSchemaVersion: 'card-sms-raw-v1',
            consentScope: { mode: 'household-only' },
            validFrom: receivedAt,
          })
          .returning({ id: schema.sourceRevisions.id });
        if (!revision) {
          throw new Error('failed to create card-SMS source revision');
        }
        await tx
          .update(schema.sourceItems)
          .set({ currentRevisionId: revision.id })
          .where(eq(schema.sourceItems.id, sourceItem.id));

        const [event] = await tx
          .insert(schema.cardSmsEvents)
          .values({
            householdId: device.householdId,
            memberId: device.memberId,
            deviceId: device.deviceId,
            sourceItemId: sourceItem.id,
            eventId,
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
        await tx.insert(schema.dataEvents).values({
          aggregateType: 'card_sms_event',
          aggregateId: event.id,
          eventType: OUTBOX_EVENT_TYPES.SOURCE_CARD_SMS_RECEIVED,
          revisionId: revision.id,
          householdId: device.householdId,
          payload: { cardSmsEventId: event.id },
          occurredAt: receivedAt,
        });
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
      return this.duplicateResponse(eventId);
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

    this.logger.log(
      `card-sms ingest accepted id=${created.id} hash=${contentHash.slice(0, 12)} status=outbox_pending`,
    );
    return {
      accepted: true,
      eventId,
      processingStatus: 'queued',
      duplicate: false,
    };
  }

  /**
   * `sha256(sender + "\n" + content)` as lowercase hex. Deliberately excludes
   * receivedAt: the hash's purpose is "same raw message" correlation/audit, and
   * receivedAt may be server-stamped (optional field) which would make the hash
   * of identical content non-deterministic across transmissions. The receive
   * time lives in its own column; it does not belong in the content identity.
   */
  private hashContent(input: CardSmsIngestRequest): string {
    return createHash('sha256')
      .update(`${input.sender}\n${input.content}`, 'utf8')
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
