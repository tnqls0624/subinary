/**
 * Long-term memory service (Phase 8 Build Spec §6.2).
 *
 * Owns the candidate → approval → memory lifecycle (PRD §20/§3.1):
 *   - `extract` enqueues rule-based extraction over an owned workspace's chunks
 *     (the `memory-extract` worker job builds `memory_candidates`).
 *   - candidates are reviewed and either approved (→ an `approved` `memories`
 *     row + `memory_sources` provenance + a v1 `memory_versions` snapshot) or
 *     rejected.
 *   - memories can be created directly (`manual` source), edited (pre-edit
 *     snapshot recorded in `memory_versions`), superseded (old marked
 *     `superseded` with `validUntil=now`, new carries `supersedesMemoryId` +
 *     `validFrom=now`), or soft-deleted.
 *
 * Ownership (PRD §26): memory is owner-only. Every operation asserts the caller
 * owns the target `workspace` (`workspaces.ownerUserId === userId`) — a missing
 * workspace is a 404 and a non-owner a 403 ({@link MemoryService.assertOwnedWorkspace}).
 * Candidate/memory operations resolve the entity first, then assert ownership of
 * its workspace, so a non-owner can never read or mutate another user's memory.
 *
 * Current vs. past (spec §1.3): `current=true` restricts to approved memories
 * whose `validUntil` is null or in the future; `asOf=DATE` restricts to memories
 * valid at that instant (`validFrom <= asOf` and `validUntil` null or after it).
 *
 * Logging never emits subject/content, PII, or secrets — only counts and
 * identifiers (spec §0).
 */
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  CandidateApproveRequest,
  CandidateStatus,
  CandidateSummary,
  MemoryCreateRequest,
  MemoryExtractResponse,
  MemoryStatus,
  MemorySummary,
  MemorySupersedeRequest,
  MemoryType,
  MemoryUpdateRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { QUEUE_NAMES } from '@family/shared';

import { DB } from '../database/database.constants';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Confidence assigned to directly created ("manual") memories. The user is
 * asserting the memory explicitly (PRD §20), so it carries maximum confidence.
 */
const MANUAL_CONFIDENCE = 100;

/* -------------------------------------------------------------------------- */
/* Option shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Filters for {@link MemoryService.listCandidates}. */
export interface ListCandidatesOptions {
  workspaceId: string;
  status?: CandidateStatus;
}

/** Filters for {@link MemoryService.listMemories} (spec §1.3/§6.2). */
export interface ListMemoriesOptions {
  workspaceId: string;
  type?: MemoryType;
  status?: MemoryStatus;
  current?: boolean;
  asOf?: string;
}

/** Result of a soft delete. */
export interface MemoryDeleteResult {
  deleted: true;
}

/** A selected `memories` row (internal projection). */
type MemoryRow = typeof schema.memories.$inferSelect;

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @InjectQueue(QUEUE_NAMES.MEMORY_EXTRACT)
    private readonly extractQueue: Queue,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Ownership                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Asserts `userId` owns `workspaceId` (PRD §26). Missing workspace → 404;
   * another owner → 403. Called at the start of every workspace-scoped
   * operation and after resolving a candidate/memory to its workspace.
   */
  async assertOwnedWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    const [row] = await this.db
      .select({ ownerUserId: schema.workspaces.ownerUserId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);

    if (!row) {
      throw new NotFoundException('workspace not found');
    }
    if (row.ownerUserId !== userId) {
      throw new ForbiddenException('not the workspace owner');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Extraction                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Enqueues rule-based memory extraction over an owned workspace's chunks. The
   * job id is keyed by workspace (colon-free per the BullMQ constraint) so an
   * accidental re-enqueue collapses; completed jobs are removed to allow re-runs.
   */
  async extract(
    userId: string,
    input: { workspaceId: string },
  ): Promise<MemoryExtractResponse> {
    const { workspaceId } = input;
    await this.assertOwnedWorkspace(userId, workspaceId);

    // BullMQ 커스텀 jobId 에는 ':' 를 쓸 수 없다 → '_' 사용(스펙 §0).
    const jobId = `memory-extract_${workspaceId}`;
    await this.extractQueue.add(
      'extract',
      { workspaceId },
      { jobId, removeOnComplete: true },
    );

    this.logger.log(
      `memory extract enqueued workspace=${workspaceId} jobId=${jobId} status=queued`,
    );

    return { jobId, status: 'queued' };
  }

  /* ---------------------------------------------------------------------- */
  /* Candidates                                                              */
  /* ---------------------------------------------------------------------- */

  /** Lists a workspace's candidates (newest first), optionally filtered by status. */
  async listCandidates(
    userId: string,
    options: ListCandidatesOptions,
  ): Promise<CandidateSummary[]> {
    const { workspaceId, status } = options;
    await this.assertOwnedWorkspace(userId, workspaceId);

    const filters: SQL[] = [
      eq(schema.memoryCandidates.workspaceId, workspaceId),
    ];
    if (status) {
      filters.push(eq(schema.memoryCandidates.status, status));
    }

    const rows = await this.db
      .select()
      .from(schema.memoryCandidates)
      .where(and(...filters))
      .orderBy(desc(schema.memoryCandidates.extractedAt));

    this.logger.log(
      `memory candidates listed workspace=${workspaceId} ` +
        `status=${status ?? 'all'} count=${rows.length}`,
    );

    return rows.map(toCandidateSummary);
  }

  /**
   * Approves a pending candidate into an `approved` memory (spec §6.2). In one
   * transaction: inserts the memory (subject/content overridable via `edits`,
   * `observedAt`=candidate.extractedAt, `validFrom`=edits.validFrom ?? now,
   * `validUntil`=edits.validUntil ?? null), links provenance in `memory_sources`
   * (the source chunk and, when present, the original Slack thread ref),
   * records the v1 `memory_versions` snapshot, and marks the candidate approved
   * with `promotedMemoryId` set.
   */
  async approveCandidate(
    userId: string,
    candidateId: string,
    edits: CandidateApproveRequest,
  ): Promise<MemorySummary> {
    const candidate = await this.loadCandidate(candidateId);
    await this.assertOwnedWorkspace(userId, candidate.workspaceId);

    if (candidate.status !== 'pending') {
      throw new ConflictException(
        `candidate is not pending (status=${candidate.status})`,
      );
    }

    const now = new Date();
    const subject = edits.subject ?? candidate.subject;
    const content = edits.content ?? candidate.content;
    const validFrom = edits.validFrom ? new Date(edits.validFrom) : now;
    const validUntil = edits.validUntil ? new Date(edits.validUntil) : null;

    const memoryId = await this.db.transaction(async (tx) => {
      const [memory] = await tx
        .insert(schema.memories)
        .values({
          workspaceId: candidate.workspaceId,
          type: candidate.type,
          subject,
          content,
          validFrom,
          validUntil,
          observedAt: candidate.extractedAt,
          confidence: candidate.confidence,
          status: 'approved',
          createdBy: userId,
        })
        .returning({ id: schema.memories.id });

      const newId = memory.id;

      // 원문 연결(PRD §3.1): chunk 참조 + 있으면 원본 Slack 스레드(threadTs) 역추적.
      const sources: {
        memoryId: string;
        sourceType: 'chunk' | 'slack_message';
        sourceRefId: string;
      }[] = [];
      if (candidate.sourceChunkId) {
        sources.push({
          memoryId: newId,
          sourceType: 'chunk',
          sourceRefId: candidate.sourceChunkId,
        });
      }
      if (candidate.sourceRefId) {
        sources.push({
          memoryId: newId,
          sourceType: 'slack_message',
          sourceRefId: candidate.sourceRefId,
        });
      }
      if (sources.length > 0) {
        await tx
          .insert(schema.memorySources)
          .values(sources)
          .onConflictDoNothing();
      }

      // v1 스냅샷(승인 시점 초기 상태).
      await tx.insert(schema.memoryVersions).values({
        memoryId: newId,
        version: 1,
        subject,
        content,
        changeReason: 'approved',
        changedBy: userId,
      });

      await tx
        .update(schema.memoryCandidates)
        .set({ status: 'approved', promotedMemoryId: newId, updatedAt: now })
        .where(eq(schema.memoryCandidates.id, candidate.id));

      return newId;
    });

    this.logger.log(
      `memory candidate approved candidate=${candidate.id} ` +
        `memory=${memoryId} workspace=${candidate.workspaceId}`,
    );

    return this.getMemorySummary(memoryId);
  }

  /** Rejects a pending/any candidate (status='rejected'). Returns the updated summary. */
  async rejectCandidate(
    userId: string,
    candidateId: string,
  ): Promise<CandidateSummary> {
    const candidate = await this.loadCandidate(candidateId);
    await this.assertOwnedWorkspace(userId, candidate.workspaceId);

    const [updated] = await this.db
      .update(schema.memoryCandidates)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(schema.memoryCandidates.id, candidate.id))
      .returning();

    this.logger.log(
      `memory candidate rejected candidate=${candidate.id} ` +
        `workspace=${candidate.workspaceId}`,
    );

    return toCandidateSummary(updated);
  }

  /* ---------------------------------------------------------------------- */
  /* Memories                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Directly creates an approved memory (PRD §20 explicit "remember this").
   * Records a `manual` provenance source and a v1 `memory_versions` snapshot.
   */
  async createMemory(
    userId: string,
    input: MemoryCreateRequest,
  ): Promise<MemorySummary> {
    await this.assertOwnedWorkspace(userId, input.workspaceId);

    const now = new Date();
    const observedAt = input.observedAt ? new Date(input.observedAt) : now;
    const validFrom = input.validFrom ? new Date(input.validFrom) : observedAt;
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;

    const memoryId = await this.db.transaction(async (tx) => {
      const [memory] = await tx
        .insert(schema.memories)
        .values({
          workspaceId: input.workspaceId,
          type: input.type,
          subject: input.subject,
          content: input.content,
          validFrom,
          validUntil,
          observedAt,
          confidence: MANUAL_CONFIDENCE,
          status: 'approved',
          createdBy: userId,
        })
        .returning({ id: schema.memories.id });

      const newId = memory.id;

      // 직접 생성 기억의 원문은 'manual'(자기 참조로 non-null 보장, PRD §3.1).
      await tx
        .insert(schema.memorySources)
        .values({ memoryId: newId, sourceType: 'manual', sourceRefId: newId })
        .onConflictDoNothing();

      await tx.insert(schema.memoryVersions).values({
        memoryId: newId,
        version: 1,
        subject: input.subject,
        content: input.content,
        changeReason: 'created',
        changedBy: userId,
      });

      return newId;
    });

    this.logger.log(
      `memory created memory=${memoryId} workspace=${input.workspaceId} ` +
        `type=${input.type}`,
    );

    return this.getMemorySummary(memoryId);
  }

  /**
   * Lists a workspace's (non-deleted) memories with `current`/`asOf` and
   * type/status filtering (spec §1.3), newest first, with provenance sources
   * attached and `isCurrent` derived.
   */
  async listMemories(
    userId: string,
    options: ListMemoriesOptions,
  ): Promise<MemorySummary[]> {
    const { workspaceId, type, status, current, asOf } = options;
    await this.assertOwnedWorkspace(userId, workspaceId);

    const now = new Date();
    const filters: SQL[] = [
      eq(schema.memories.workspaceId, workspaceId),
      isNull(schema.memories.deletedAt),
    ];
    if (type) {
      filters.push(eq(schema.memories.type, type));
    }
    if (status) {
      filters.push(eq(schema.memories.status, status));
    }
    if (current) {
      // status='approved' AND (validUntil IS NULL OR validUntil > now).
      filters.push(eq(schema.memories.status, 'approved'));
      const validNow = or(
        isNull(schema.memories.validUntil),
        gt(schema.memories.validUntil, now),
      );
      if (validNow) {
        filters.push(validNow);
      }
    }
    if (asOf) {
      // validFrom <= asOf AND (validUntil IS NULL OR validUntil > asOf).
      const asOfDate = new Date(asOf);
      if (Number.isNaN(asOfDate.getTime())) {
        throw new BadRequestException('asOf must be a valid ISO datetime');
      }
      filters.push(lte(schema.memories.validFrom, asOfDate));
      const validAsOf = or(
        isNull(schema.memories.validUntil),
        gt(schema.memories.validUntil, asOfDate),
      );
      if (validAsOf) {
        filters.push(validAsOf);
      }
    }

    const rows = await this.db
      .select()
      .from(schema.memories)
      .where(and(...filters))
      .orderBy(desc(schema.memories.createdAt));

    const sourcesByMemory = await this.loadSources(rows.map((r) => r.id));

    this.logger.log(
      `memory list workspace=${workspaceId} type=${type ?? 'all'} ` +
        `status=${status ?? 'all'} current=${current ?? false} ` +
        `asOf=${asOf ?? 'none'} count=${rows.length}`,
    );

    return rows.map((row) =>
      toMemorySummary(row, sourcesByMemory.get(row.id) ?? [], now),
    );
  }

  /**
   * Edits a memory (spec §1.4). Records the pre-edit snapshot in
   * `memory_versions` (version = current max + 1) *before* applying the change.
   * `validUntil` accepts null to clear an expiry (make the memory current again).
   */
  async updateMemory(
    userId: string,
    id: string,
    input: MemoryUpdateRequest,
  ): Promise<MemorySummary> {
    const memory = await this.loadMemory(id);
    await this.assertOwnedWorkspace(userId, memory.workspaceId);

    const now = new Date();

    await this.db.transaction(async (tx) => {
      // 변경 *전* 스냅샷을 다음 버전으로 저장(스펙 §1.4).
      const [{ maxVersion }] = await tx
        .select({
          maxVersion: sql<number>`coalesce(max(${schema.memoryVersions.version}), 0)`,
        })
        .from(schema.memoryVersions)
        .where(eq(schema.memoryVersions.memoryId, id));

      await tx.insert(schema.memoryVersions).values({
        memoryId: id,
        version: Number(maxVersion) + 1,
        subject: memory.subject,
        content: memory.content,
        changeReason: input.changeReason ?? null,
        changedBy: userId,
      });

      const updates: Partial<typeof schema.memories.$inferInsert> = {
        updatedAt: now,
      };
      if (input.subject !== undefined) {
        updates.subject = input.subject;
      }
      if (input.content !== undefined) {
        updates.content = input.content;
      }
      if (input.validUntil !== undefined) {
        updates.validUntil =
          input.validUntil === null ? null : new Date(input.validUntil);
      }

      await tx
        .update(schema.memories)
        .set(updates)
        .where(eq(schema.memories.id, id));
    });

    this.logger.log(
      `memory updated memory=${id} workspace=${memory.workspaceId}`,
    );

    return this.getMemorySummary(id);
  }

  /**
   * Supersedes a memory (PRD §20 / spec §1.3). In one transaction: marks the
   * old memory `superseded` with `validUntil=now`, inserts a new approved memory
   * carrying `supersedesMemoryId` and `validFrom=now`, copies the old memory's
   * provenance sources (or a `manual` marker if none), and records the new v1
   * `memory_versions` snapshot. Returns the new memory.
   */
  async supersedeMemory(
    userId: string,
    id: string,
    input: MemorySupersedeRequest,
  ): Promise<MemorySummary> {
    const existing = await this.loadMemory(id);
    await this.assertOwnedWorkspace(userId, existing.workspaceId);

    const now = new Date();
    const observedAt = input.observedAt ? new Date(input.observedAt) : now;

    const newMemoryId = await this.db.transaction(async (tx) => {
      await tx
        .update(schema.memories)
        .set({ status: 'superseded', validUntil: now, updatedAt: now })
        .where(eq(schema.memories.id, id));

      const [memory] = await tx
        .insert(schema.memories)
        .values({
          workspaceId: existing.workspaceId,
          type: input.type,
          subject: input.subject,
          content: input.content,
          validFrom: now,
          validUntil: null,
          observedAt,
          confidence: existing.confidence,
          status: 'approved',
          supersedesMemoryId: id,
          createdBy: userId,
        })
        .returning({ id: schema.memories.id });

      const newId = memory.id;

      // 기존 sources 복사(없으면 'manual' 마커), PRD §3.1.
      const oldSources = await tx
        .select({
          sourceType: schema.memorySources.sourceType,
          sourceRefId: schema.memorySources.sourceRefId,
        })
        .from(schema.memorySources)
        .where(eq(schema.memorySources.memoryId, id));

      if (oldSources.length > 0) {
        await tx
          .insert(schema.memorySources)
          .values(
            oldSources.map((s) => ({
              memoryId: newId,
              sourceType: s.sourceType,
              sourceRefId: s.sourceRefId,
            })),
          )
          .onConflictDoNothing();
      } else {
        await tx
          .insert(schema.memorySources)
          .values({ memoryId: newId, sourceType: 'manual', sourceRefId: newId })
          .onConflictDoNothing();
      }

      await tx.insert(schema.memoryVersions).values({
        memoryId: newId,
        version: 1,
        subject: input.subject,
        content: input.content,
        changeReason: 'superseded',
        changedBy: userId,
      });

      return newId;
    });

    this.logger.log(
      `memory superseded old=${id} new=${newMemoryId} ` +
        `workspace=${existing.workspaceId}`,
    );

    return this.getMemorySummary(newMemoryId);
  }

  /** Soft-deletes a memory (sets `deletedAt`). Idempotent from the caller's view. */
  async deleteMemory(
    userId: string,
    id: string,
  ): Promise<MemoryDeleteResult> {
    const memory = await this.loadMemory(id);
    await this.assertOwnedWorkspace(userId, memory.workspaceId);

    const now = new Date();
    await this.db
      .update(schema.memories)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.memories.id, id));

    this.logger.log(
      `memory deleted memory=${id} workspace=${memory.workspaceId}`,
    );

    return { deleted: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Internal helpers                                                        */
  /* ---------------------------------------------------------------------- */

  /** Loads a candidate or throws 404. */
  private async loadCandidate(
    candidateId: string,
  ): Promise<typeof schema.memoryCandidates.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(schema.memoryCandidates)
      .where(eq(schema.memoryCandidates.id, candidateId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('candidate not found');
    }
    return row;
  }

  /** Loads a non-deleted memory or throws 404. */
  private async loadMemory(id: string): Promise<MemoryRow> {
    const [row] = await this.db
      .select()
      .from(schema.memories)
      .where(and(eq(schema.memories.id, id), isNull(schema.memories.deletedAt)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('memory not found');
    }
    return row;
  }

  /** Loads provenance sources grouped by memory id for the given memories. */
  private async loadSources(
    memoryIds: string[],
  ): Promise<Map<string, { sourceType: string; sourceRefId: string }[]>> {
    const byMemory = new Map<
      string,
      { sourceType: string; sourceRefId: string }[]
    >();
    if (memoryIds.length === 0) {
      return byMemory;
    }
    const rows = await this.db
      .select({
        memoryId: schema.memorySources.memoryId,
        sourceType: schema.memorySources.sourceType,
        sourceRefId: schema.memorySources.sourceRefId,
      })
      .from(schema.memorySources)
      .where(inArray(schema.memorySources.memoryId, memoryIds));

    for (const row of rows) {
      const list = byMemory.get(row.memoryId) ?? [];
      list.push({ sourceType: row.sourceType, sourceRefId: row.sourceRefId });
      byMemory.set(row.memoryId, list);
    }
    return byMemory;
  }

  /** Loads a single memory + sources and projects it to the API summary. */
  private async getMemorySummary(id: string): Promise<MemorySummary> {
    const memory = await this.loadMemory(id);
    const sourcesByMemory = await this.loadSources([id]);
    return toMemorySummary(
      memory,
      sourcesByMemory.get(id) ?? [],
      new Date(),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level projections                                                   */
/* -------------------------------------------------------------------------- */

/** Projects a candidate row to the API `CandidateSummary`. */
function toCandidateSummary(
  row: typeof schema.memoryCandidates.$inferSelect,
): CandidateSummary {
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    content: row.content,
    confidence: row.confidence,
    status: row.status,
    sourceChunkId: row.sourceChunkId,
    sourceRefId: row.sourceRefId,
    extractedAt: row.extractedAt.toISOString(),
  };
}

/**
 * Projects a memory row + its sources to the API `MemorySummary`, deriving
 * `isCurrent` (approved and `validUntil` null or after `now`, spec §1.3).
 */
function toMemorySummary(
  row: MemoryRow,
  sources: { sourceType: string; sourceRefId: string }[],
  now: Date,
): MemorySummary {
  const isCurrent =
    row.status === 'approved' &&
    (row.validUntil === null || row.validUntil.getTime() > now.getTime());

  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    content: row.content,
    validFrom: row.validFrom ? row.validFrom.toISOString() : null,
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    observedAt: row.observedAt.toISOString(),
    confidence: row.confidence,
    status: row.status,
    supersedesMemoryId: row.supersedesMemoryId,
    isCurrent,
    sources: sources.map((s) => ({
      sourceType: s.sourceType as MemorySummary['sources'][number]['sourceType'],
      sourceRefId: s.sourceRefId,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
