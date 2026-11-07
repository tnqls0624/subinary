/**
 * 문자 원문 사본 purge(SOO-34).
 *
 * "지웠다"고 기록하기 전에 그 건의 DB 원문·객체 저장소·중복 억제 원문이 **모두**
 * 없어져야 한다. 거래·가계부 행은 건드리지 않는다.
 *
 * 한 실행에서 일부라도 실패하면 이력을 `completed`로 남기지 않는다. 실패 건수를
 * 이력에 함께 적는다. 원문 텍스트는 이력에 넣지 않는다.
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
  logStatus: 'completed' | 'failed' | null;
}

type DeleteObject = (objectKey: string) => Promise<void>;

/**
 * 한 건을 "지웠다"고 세기 전에 세 사본이 모두 없어졌는지 판정한다.
 * 억제 행이 원래 없으면 `suppressionRawsGone=true`로 둔다.
 */
export function canClaimRawPurged(copies: {
  dbRawGone: boolean;
  objectStorageGone: boolean;
  suppressionRawsGone: boolean;
}): boolean {
  return (
    copies.dbRawGone &&
    copies.objectStorageGone &&
    copies.suppressionRawsGone
  );
}

/**
 * 실행 결과로 이력 행을 어떻게 남길지 정한다.
 * 실패가 하나라도 있으면 completed가 아니다. 아무것도 시도·성공하지 않으면 이력을 안 남긴다.
 */
export function resolvePurgeLogDecision(input: {
  purgedEventCount: number;
  purgedSuppressionCount: number;
  failedEventCount: number;
  failedSuppressionCount: number;
}): {
  status: 'completed' | 'failed';
  errorCode: string | null;
  purgedEventCount: number;
  purgedSuppressionCount: number;
  failedEventCount: number;
  failedSuppressionCount: number;
} | null {
  const purged =
    input.purgedEventCount + input.purgedSuppressionCount;
  const failed =
    input.failedEventCount + input.failedSuppressionCount;
  if (purged === 0 && failed === 0) return null;
  if (failed > 0) {
    return {
      status: 'failed',
      errorCode: purged > 0 ? 'partial_purge_failed' : 'purge_failed',
      purgedEventCount: input.purgedEventCount,
      purgedSuppressionCount: input.purgedSuppressionCount,
      failedEventCount: input.failedEventCount,
      failedSuppressionCount: input.failedSuppressionCount,
    };
  }
  return {
    status: 'completed',
    errorCode: null,
    purgedEventCount: input.purgedEventCount,
    purgedSuppressionCount: input.purgedSuppressionCount,
    failedEventCount: 0,
    failedSuppressionCount: 0,
  };
}

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
 * 이벤트 한 건은 객체 저장소 → 짝 억제 원문 → 이벤트 DB 원문 순으로 지우고,
 * 세 곳이 모두 없어진 뒤에만 성공으로 센다.
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
      logStatus: null,
    };
  }

  let purgedEventCount = 0;
  let failedEventCount = 0;
  let purgedSuppressionCount = 0;
  let failedSuppressionCount = 0;
  const handledSuppressionIds = new Set<string>();

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
        const linked = await listLinkedSuppressionsWithRaw(db, event.id);
        await deleteSourceObjectCopies(db, input.deleteObject, event.sourceItemId);
        const scrubbedSuppressionIds = await scrubSuppressionRaws(
          db,
          linked.map((row) => row.id),
          now,
        );
        for (const id of scrubbedSuppressionIds) {
          handledSuppressionIds.add(id);
        }
        if (scrubbedSuppressionIds.length !== linked.length) {
          throw new Error('linked suppression raw scrub incomplete');
        }
        await scrubEventRaw(db, event.id, now);
        const [after] = await db
          .select({ rawContent: schema.cardSmsEvents.rawContent })
          .from(schema.cardSmsEvents)
          .where(eq(schema.cardSmsEvents.id, event.id))
          .limit(1);
        const remainingLinked = await listLinkedSuppressionsWithRaw(db, event.id);
        if (
          !canClaimRawPurged({
            dbRawGone: (after?.rawContent ?? '').length === 0,
            objectStorageGone: true,
            suppressionRawsGone: remainingLinked.length === 0,
          })
        ) {
          throw new Error('event raw copies remain after purge steps');
        }
        purgedEventCount += 1;
        purgedSuppressionCount += scrubbedSuppressionIds.length;
      } catch {
        failedEventCount += 1;
      }
    }
  }

  for (const suppressionId of preview.matchingSuppressionIds) {
    if (handledSuppressionIds.has(suppressionId)) continue;
    try {
      const scrubbed = await scrubSuppressionRaws(db, [suppressionId], now);
      if (scrubbed.length !== 1) {
        throw new Error('suppression raw scrub incomplete');
      }
      const [after] = await db
        .select({ rawContent: schema.cardSmsIngestSuppressions.rawContent })
        .from(schema.cardSmsIngestSuppressions)
        .where(eq(schema.cardSmsIngestSuppressions.id, suppressionId))
        .limit(1);
      if (
        !canClaimRawPurged({
          dbRawGone: (after?.rawContent ?? '').length === 0,
          // 억제 행은 객체 저장소 사본이 없다.
          objectStorageGone: true,
          suppressionRawsGone: true,
        })
      ) {
        throw new Error('suppression raw remains after scrub');
      }
      purgedSuppressionCount += 1;
    } catch {
      failedSuppressionCount += 1;
    }
  }

  const decision = resolvePurgeLogDecision({
    purgedEventCount,
    purgedSuppressionCount,
    failedEventCount,
    failedSuppressionCount,
  });

  let logId: string | null = null;
  if (decision) {
    const [log] = await db
      .insert(schema.smsRawPurgeLogs)
      .values({
        householdId: input.householdId,
        policy: input.policy,
        purgedEventCount: decision.purgedEventCount,
        purgedSuppressionCount: decision.purgedSuppressionCount,
        failedEventCount: decision.failedEventCount,
        failedSuppressionCount: decision.failedSuppressionCount,
        triggeredBy: input.triggeredBy,
        actorUserId: input.actorUserId,
        status: decision.status,
        errorCode: decision.errorCode,
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
    logStatus: decision?.status ?? null,
  };
}

async function listLinkedSuppressionsWithRaw(
  db: Db,
  eventId: string,
): Promise<Array<{ id: string }>> {
  return db
    .select({ id: schema.cardSmsIngestSuppressions.id })
    .from(schema.cardSmsIngestSuppressions)
    .where(
      and(
        eq(schema.cardSmsIngestSuppressions.matchedEventId, eventId),
        gt(sql`length(${schema.cardSmsIngestSuppressions.rawContent})`, 0),
      ),
    );
}

async function scrubSuppressionRaws(
  db: Db,
  ids: string[],
  now: Date,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const updated = await db
    .update(schema.cardSmsIngestSuppressions)
    .set({
      rawContent: '',
      updatedAt: now,
    })
    .where(
      and(
        inArray(schema.cardSmsIngestSuppressions.id, ids),
        gt(sql`length(${schema.cardSmsIngestSuppressions.rawContent})`, 0),
      ),
    )
    .returning({ id: schema.cardSmsIngestSuppressions.id });
  return updated.map((row) => row.id);
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
