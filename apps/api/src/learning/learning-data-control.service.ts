/**
 * 학습 데이터 원본의 삭제 제어와 격리 outbox 운영 기능을 제공한다.
 * 삭제 요청은 원본 projection과 tombstone revision, outbox event를 한 트랜잭션에
 * 기록하며 실제 storage·파생 데이터 정리는 Worker가 멱등 수행한다.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';

import type {
  OutboxReprocessResponse,
  QuarantinedOutboxEventSummary,
  QuarantinedOutboxListQuery,
  SourceTombstoneResponse,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { OUTBOX_EVENT_TYPES } from '@family/shared';

import { DB } from '../database/database.constants';

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SOURCE_TOMBSTONE_SCHEMA_VERSION = 'source-tombstone-v1';
const PRIVILEGED_HOUSEHOLD_ROLES = ['owner', 'admin'] as const;

interface SourceScope {
  workspaceId: string | null;
  householdId: string | null;
}

@Injectable()
export class LearningDataControlService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** source에 tombstone revision을 추가하고 삭제 전파 event를 발행한다. */
  async tombstoneSource(
    userId: string,
    sourceItemId: string,
  ): Promise<SourceTombstoneResponse> {
    const initial = await this.findSource(sourceItemId);
    await this.assertScopeOperator(userId, initial);

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`source-tombstone:${sourceItemId}`}))`,
      );
      const [source] = await tx
        .select({
          id: schema.sourceItems.id,
          workspaceId: schema.sourceItems.workspaceId,
          householdId: schema.sourceItems.householdId,
          currentRevisionId: schema.sourceItems.currentRevisionId,
          deletedAt: schema.sourceItems.deletedAt,
        })
        .from(schema.sourceItems)
        .where(eq(schema.sourceItems.id, sourceItemId))
        .limit(1);
      if (!source) {
        throw new NotFoundException('source item not found');
      }

      const revisions = await tx
        .select({
          id: schema.sourceRevisions.id,
          revision: schema.sourceRevisions.revision,
          isTombstone: schema.sourceRevisions.isTombstone,
          validFrom: schema.sourceRevisions.validFrom,
          validUntil: schema.sourceRevisions.validUntil,
        })
        .from(schema.sourceRevisions)
        .where(eq(schema.sourceRevisions.sourceItemId, sourceItemId));
      const current = revisions.find(
        (revision) => revision.id === source.currentRevisionId,
      );
      if (source.deletedAt !== null) {
        if (!current?.isTombstone) {
          throw new ConflictException('deleted source has no tombstone revision');
        }
        return {
          sourceItemId,
          revisionId: current.id,
          status: 'tombstoned',
          deletedAt: source.deletedAt.toISOString(),
        };
      }
      if (!current || current.validUntil !== null) {
        throw new ConflictException('source current revision is unavailable');
      }

      const requestedAt = new Date();
      const tombstoneAt =
        requestedAt <= current.validFrom
          ? new Date(current.validFrom.getTime() + 1)
          : requestedAt;
      await tx
        .update(schema.sourceRevisions)
        .set({ validUntil: tombstoneAt })
        .where(eq(schema.sourceRevisions.id, current.id));

      const nextRevision =
        revisions.reduce(
          (maximum, revision) => Math.max(maximum, revision.revision),
          0,
        ) + 1;
      const tombstoneKey = `tombstones/source/${sourceItemId}/v${nextRevision}`;
      const [tombstone] = await tx
        .insert(schema.sourceRevisions)
        .values({
          sourceItemId,
          revision: nextRevision,
          objectKey: tombstoneKey,
          contentHash: EMPTY_SHA256,
          sizeBytes: 0,
          parserSchemaVersion: SOURCE_TOMBSTONE_SCHEMA_VERSION,
          consentScope: { status: 'withdrawn' },
          isTombstone: true,
          validFrom: tombstoneAt,
          deletedAt: tombstoneAt,
        })
        .returning({ id: schema.sourceRevisions.id });
      if (!tombstone) {
        throw new Error('source tombstone revision insert returned no row');
      }

      await tx
        .update(schema.sourceItems)
        .set({
          objectKey: tombstoneKey,
          contentHash: EMPTY_SHA256,
          sizeBytes: 0,
          currentRevisionId: tombstone.id,
          deletedAt: tombstoneAt,
        })
        .where(eq(schema.sourceItems.id, sourceItemId));
      await tx.insert(schema.dataEvents).values({
        aggregateType: 'source_item',
        aggregateId: sourceItemId,
        eventType: OUTBOX_EVENT_TYPES.SOURCE_TOMBSTONED,
        revisionId: tombstone.id,
        workspaceId: source.workspaceId,
        householdId: source.householdId,
        payload: { sourceItemId },
        occurredAt: tombstoneAt,
      });

      return {
        sourceItemId,
        revisionId: tombstone.id,
        status: 'tombstoned',
        deletedAt: tombstoneAt.toISOString(),
      };
    });
  }

  /** 소유 범위의 격리 event를 payload 없이 최신순으로 조회한다. */
  async listQuarantinedEvents(
    userId: string,
    query: QuarantinedOutboxListQuery,
  ): Promise<QuarantinedOutboxEventSummary[]> {
    await this.assertScopeOperator(userId, {
      workspaceId: query.workspaceId ?? null,
      householdId: query.householdId ?? null,
    });
    const scopeCondition = query.workspaceId
      ? eq(schema.dataEvents.workspaceId, query.workspaceId)
      : eq(schema.dataEvents.householdId, query.householdId!);
    const rows = await this.db
      .select({
        id: schema.dataEvents.id,
        eventType: schema.dataEvents.eventType,
        aggregateType: schema.dataEvents.aggregateType,
        aggregateId: schema.dataEvents.aggregateId,
        revisionId: schema.dataEvents.revisionId,
        publishAttempts: schema.dataEvents.publishAttempts,
        reprocessCount: schema.dataEvents.reprocessCount,
        lastErrorCode: schema.dataEvents.lastErrorCode,
        occurredAt: schema.dataEvents.occurredAt,
        quarantinedAt: schema.dataEvents.quarantinedAt,
      })
      .from(schema.dataEvents)
      .where(
        and(
          scopeCondition,
          isNull(schema.dataEvents.publishedAt),
          isNotNull(schema.dataEvents.quarantinedAt),
        ),
      )
      .orderBy(desc(schema.dataEvents.quarantinedAt), desc(schema.dataEvents.id))
      .limit(query.limit);
    return rows.map((row) => {
      if (row.quarantinedAt === null) {
        throw new Error('quarantined outbox query returned a pending event');
      }
      return {
        ...row,
        occurredAt: row.occurredAt.toISOString(),
        quarantinedAt: row.quarantinedAt.toISOString(),
      };
    });
  }

  /** 격리 event를 pending으로 되돌린다. dispatcher가 다음 poll에서 재발행한다. */
  async reprocessQuarantinedEvent(
    userId: string,
    eventId: string,
  ): Promise<OutboxReprocessResponse> {
    const [event] = await this.db
      .select({
        workspaceId: schema.dataEvents.workspaceId,
        householdId: schema.dataEvents.householdId,
        publishedAt: schema.dataEvents.publishedAt,
        quarantinedAt: schema.dataEvents.quarantinedAt,
      })
      .from(schema.dataEvents)
      .where(eq(schema.dataEvents.id, eventId))
      .limit(1);
    if (!event) {
      throw new NotFoundException('outbox event not found');
    }
    await this.assertScopeOperator(userId, event);
    if (event.publishedAt !== null || event.quarantinedAt === null) {
      throw new ConflictException('outbox event is not quarantined');
    }

    const [updated] = await this.db
      .update(schema.dataEvents)
      .set({
        publishAttempts: 0,
        reprocessCount: sql`${schema.dataEvents.reprocessCount} + 1`,
        availableAt: sql`now()`,
        lockedAt: null,
        lockedBy: null,
        quarantinedAt: null,
        lastErrorCode: null,
        lastReprocessedAt: sql`now()`,
        lastReprocessedBy: userId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.dataEvents.id, eventId),
          isNull(schema.dataEvents.publishedAt),
          isNotNull(schema.dataEvents.quarantinedAt),
        ),
      )
      .returning({
        id: schema.dataEvents.id,
        reprocessCount: schema.dataEvents.reprocessCount,
        availableAt: schema.dataEvents.availableAt,
      });
    if (!updated) {
      throw new ConflictException('outbox event reprocess already requested');
    }
    return {
      eventId: updated.id,
      status: 'pending',
      reprocessCount: updated.reprocessCount,
      availableAt: updated.availableAt.toISOString(),
    };
  }

  private async findSource(sourceItemId: string): Promise<SourceScope> {
    const [source] = await this.db
      .select({
        workspaceId: schema.sourceItems.workspaceId,
        householdId: schema.sourceItems.householdId,
      })
      .from(schema.sourceItems)
      .where(eq(schema.sourceItems.id, sourceItemId))
      .limit(1);
    if (!source) {
      throw new NotFoundException('source item not found');
    }
    return source;
  }

  private async assertScopeOperator(
    userId: string,
    scope: SourceScope,
  ): Promise<void> {
    const scopeCount =
      Number(scope.workspaceId !== null) + Number(scope.householdId !== null);
    if (scopeCount !== 1) {
      throw new BadRequestException('exactly one source scope is required');
    }
    if (scope.workspaceId !== null) {
      const [workspace] = await this.db
        .select({ ownerUserId: schema.workspaces.ownerUserId })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, scope.workspaceId))
        .limit(1);
      if (!workspace) {
        throw new NotFoundException('workspace not found');
      }
      if (workspace.ownerUserId !== userId) {
        throw new ForbiddenException('not the workspace owner');
      }
      return;
    }
    if (scope.householdId !== null) {
      const [membership] = await this.db
        .select({ id: schema.householdMembers.id })
        .from(schema.householdMembers)
        .where(
          and(
            eq(schema.householdMembers.householdId, scope.householdId),
            eq(schema.householdMembers.userId, userId),
            eq(schema.householdMembers.status, 'active'),
            inArray(
              schema.householdMembers.role,
              PRIVILEGED_HOUSEHOLD_ROLES,
            ),
          ),
        )
        .limit(1);
      if (!membership) {
        throw new ForbiddenException('household owner or admin required');
      }
      return;
    }
    throw new BadRequestException('source scope is missing');
  }
}
