/**
 * 문자 원문 사본 purge(SOO-34).
 *
 * "지웠다"고 기록하기 전에 DB 원문·객체 저장소·중복 억제 원문이 **모두** 없어져야 한다.
 * 거래·가계부 행은 건드리지 않는다(학습 source-tombstone과 다르다 — 그쪽은 거래를 제외한다).
 *
 * 한 건이라도 객체 삭제가 실패하면 그 건의 DB는 비우지 않고, 성공 건수만 이력에 남긴다.
 */
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';

import * as schema from './schema.js';
import type { Db } from './client.js';
import {
  eventRawMatchesRetention,
  suppressionRawMatchesRetention,
  type CardSmsParseStatus,
  type SmsRetentionPolicy,
} from './sms-raw-retention.js';

export interface SmsRawPurgePreview {
  policy: SmsRetentionPolicy;
  matchingEventCount: number;
  matchingSuppressionCount: number;
  matchingEventIds: string[];
  matchingSuppressionIds: string[];
}

export interface SmsRawPurgeResult {
  policy: SmsRetentionPolicy;
  purgedEventCount: number;
  purgedSuppressionCount: number;
  failedEventCount: number;
  failedSuppressionCount: number;
  logId: string | null;
}

type DeleteObject = (objectKey: string) => Promise<void>;

/** 미리보기와 실제 purge가 같은 후보를 고르도록 한 곳에서 집계한다. */
export async function previewSmsRawPurge(
  db: Db,
  input: {
    householdId: string;
    policy: SmsRetentionPolicy;
    now?: Date;
  },
): Promise<SmsRawPurgePreview> {
  const now = input.now ?? new Date();
  if (input.policy === 'none') {
    return {
      policy: input.policy,
      matchingEventCount: 0,
      matchingSuppressionCount: 0,
      matchingEventIds: [],
      matchingSuppressionIds: [],
    };
  }

  const events = await db
    .select({
      id: schema.cardSmsEvents.id,
      rawContent: schema.cardSmsEvents.rawContent,
      parseStatus: schema.cardSmsEvents.parseStatus,
      receivedAt: schema.cardSmsEvents.receivedAt,
    })
    .from(schema.cardSmsEvents)
    .where(
      and(
        eq(schema.cardSmsEvents.householdId, input.householdId),
        ne(schema.cardSmsEvents.rawContent, ''),
      ),
    );

  const matchingEventIds = events
    .filter((event) =>
      eventRawMatchesRetention({
        policy: input.policy,
        rawContent: event.rawContent,
        parseStatus: event.parseStatus as CardSmsParseStatus,
        receivedAt: event.receivedAt,
        now,
      }),
    )
    .map((event) => event.id);

  const suppressions = await db
    .select({
      id: schema.cardSmsIngestSuppressions.id,
      rawContent: schema.cardSmsIngestSuppressions.rawContent,
      firstSeenAt: schema.cardSmsIngestSuppressions.firstSeenAt,
      matchedEventId: schema.cardSmsIngestSuppressions.matchedEventId,
    })
    .from(schema.cardSmsIngestSuppressions)
    .where(
      and(
        eq(schema.cardSmsIngestSuppressions.householdId, input.householdId),
        ne(schema.cardSmsIngestSuppressions.rawContent, ''),
      ),
    );

  const matchedIds = [
    ...new Set(
      suppressions
        .map((row) => row.matchedEventId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const matchedEvents =
    matchedIds.length === 0
      ? []
      : await db
          .select({
            id: schema.cardSmsEvents.id,
            rawContent: schema.cardSmsEvents.rawContent,
            parseStatus: schema.cardSmsEvents.parseStatus,
            receivedAt: schema.cardSmsEvents.receivedAt,
          })
          .from(schema.cardSmsEvents)
          .where(inArray(schema.cardSmsEvents.id, matchedIds));
  const matchedById = new Map(
    matchedEvents.map((event) => [event.id, event] as const),
  );

  const matchingSuppressionIds = suppressions
    .filter((row) => {
      const matched = row.matchedEventId
        ? matchedById.get(row.matchedEventId)
        : null;
      return suppressionRawMatchesRetention({
        policy: input.policy,
        rawContent: row.rawContent,
        firstSeenAt: row.firstSeenAt,
        now,
        matchedEvent: matched
          ? {
              rawContent: matched.rawContent,
              parseStatus: matched.parseStatus as CardSmsParseStatus,
              receivedAt: matched.receivedAt,
            }
          : null,
      });
    })
    .map((row) => row.id);

  return {
    policy: input.policy,
    matchingEventCount: matchingEventIds.length,
    matchingSuppressionCount: matchingSuppressionIds.length,
    matchingEventIds,
    matchingSuppressionIds,
  };
}

/**
 * 정책에 맞는 원문 사본을 지운다. 거래 행은 수정하지 않는다.
 *
 * @returns 실제로 모든 사본을 지운 건수만. 실패 건은 DB를 비우지 않는다.
 */
export async function purgeSmsRawForHousehold(
  db: Db,
  input: {
    householdId: string;
    policy: SmsRetentionPolicy;
    triggeredBy: 'user' | 'scheduler';
    actorUserId: string | null;
    deleteObject: DeleteObject;
    now?: Date;
  },
): Promise<SmsRawPurgeResult> {
  const now = input.now ?? new Date();
  const preview = await previewSmsRawPurge(db, {
    householdId: input.householdId,
    policy: input.policy,
    now,
  });

  if (input.policy === 'none') {
    return {
      policy: input.policy,
      purgedEventCount: 0,
      purgedSuppressionCount: 0,
      failedEventCount: 0,
      failedSuppressionCount: 0,
      logId: null,
    };
  }

  let purgedEventCount = 0;
  let failedEventCount = 0;
  let purgedSuppressionCount = 0;
  let failedSuppressionCount = 0;

  if (preview.matchingEventIds.length > 0) {
    const eventRows = await db
      .select({
        id: schema.cardSmsEvents.id,
        sourceItemId: schema.cardSmsEvents.sourceItemId,
        rawContent: schema.cardSmsEvents.rawContent,
      })
      .from(schema.cardSmsEvents)
      .where(inArray(schema.cardSmsEvents.id, preview.matchingEventIds));

    for (const event of eventRows) {
      if (event.rawContent.length === 0) continue;
      try {
        await deleteSourceObjectCopies(db, input.deleteObject, event.sourceItemId);
        await scrubEventRaw(db, event.id, now);
        purgedEventCount += 1;
      } catch {
        failedEventCount += 1;
      }
    }
  }

  if (preview.matchingSuppressionIds.length > 0) {
    for (const suppressionId of preview.matchingSuppressionIds) {
      try {
        const updated = await db
          .update(schema.cardSmsIngestSuppressions)
          .set({
            rawContent: '',
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.cardSmsIngestSuppressions.id, suppressionId),
              gt(sql`length(${schema.cardSmsIngestSuppressions.rawContent})`, 0),
            ),
          )
          .returning({ id: schema.cardSmsIngestSuppressions.id });
        if (updated.length > 0) {
          purgedSuppressionCount += 1;
        }
      } catch {
        failedSuppressionCount += 1;
      }
    }
  }

  let logId: string | null = null;
  if (purgedEventCount > 0 || purgedSuppressionCount > 0) {
    const [log] = await db
      .insert(schema.smsRawPurgeLogs)
      .values({
        householdId: input.householdId,
        policy: input.policy,
        purgedEventCount,
        purgedSuppressionCount,
        triggeredBy: input.triggeredBy,
        actorUserId: input.actorUserId,
        status: 'completed',
        errorCode: null,
      })
      .returning({ id: schema.smsRawPurgeLogs.id });
    logId = log?.id ?? null;
  } else if (failedEventCount > 0 || failedSuppressionCount > 0) {
    const [log] = await db
      .insert(schema.smsRawPurgeLogs)
      .values({
        householdId: input.householdId,
        policy: input.policy,
        purgedEventCount: 0,
        purgedSuppressionCount: 0,
        triggeredBy: input.triggeredBy,
        actorUserId: input.actorUserId,
        status: 'failed',
        errorCode: 'partial_object_delete_failed',
      })
      .returning({ id: schema.smsRawPurgeLogs.id });
    logId = log?.id ?? null;
  }

  return {
    policy: input.policy,
    purgedEventCount,
    purgedSuppressionCount,
    failedEventCount,
    failedSuppressionCount,
    logId,
  };
}

/** source item의 비-tombstone revision 객체 키를 모두 지우고 size_bytes를 0으로 맞춘다. */
async function deleteSourceObjectCopies(
  db: Db,
  deleteObject: DeleteObject,
  sourceItemId: string,
): Promise<void> {
  const revisions = await db
    .select({
      objectKey: schema.sourceRevisions.objectKey,
      isTombstone: schema.sourceRevisions.isTombstone,
    })
    .from(schema.sourceRevisions)
    .where(eq(schema.sourceRevisions.sourceItemId, sourceItemId));

  const keys = [
    ...new Set(
      revisions
        .filter((revision) => !revision.isTombstone)
        .map((revision) => revision.objectKey),
    ),
  ];

  for (const key of keys) {
    await deleteObject(key);
  }

  const [source] = await db
    .select({ objectKey: schema.sourceItems.objectKey })
    .from(schema.sourceItems)
    .where(eq(schema.sourceItems.id, sourceItemId))
    .limit(1);
  if (source && !keys.includes(source.objectKey)) {
    await deleteObject(source.objectKey);
  }

  await db
    .update(schema.sourceItems)
    .set({ sizeBytes: 0 })
    .where(eq(schema.sourceItems.id, sourceItemId));
}

/** DB 원문만 비운다. parseStatus·거래 연결은 그대로 둔다. */
async function scrubEventRaw(
  db: Db,
  eventId: string,
  now: Date,
): Promise<void> {
  await db
    .update(schema.cardSmsEvents)
    .set({
      rawContent: '',
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.cardSmsEvents.id, eventId),
        gt(sql`length(${schema.cardSmsEvents.rawContent})`, 0),
      ),
    );
}
