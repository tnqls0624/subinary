/**
 * Temporal GraphRAG service (Phase 9 Build Spec §6.2).
 *
 * Owns the entity/relationship read + temporal-supersede surface over a
 * workspace's rule-extracted knowledge graph (PRD §22):
 *   - `extract` enqueues deterministic rule-based graph extraction over an owned
 *     workspace's chunks (the `graph-extract` worker job upserts
 *     `entities`/`relationships`).
 *   - `listEntities`/`getEntity` read entities and 1-hop local neighbourhoods.
 *   - `listRelationships`/`timeline` read relationships (optionally
 *     current/as-of filtered) and an entity's relationship history.
 *   - `supersedeRelationship` explicitly replaces a relationship: the old one is
 *     closed (`validUntil=now`) and a new one carries `supersedesRelationshipId`
 *     + `validFrom=now` (PRD §20/§22 — supersede is always explicit, never
 *     inferred).
 *
 * Ownership (PRD §26): graph data is owner-only. Every operation asserts the
 * caller owns the target `workspace` (`workspaces.ownerUserId === userId`) — a
 * missing workspace is a 404 and a non-owner a 403
 * ({@link GraphService.assertOwnedWorkspace}). Entity/relationship operations
 * resolve the row first, then assert ownership of its workspace, so a non-owner
 * can never read or mutate another user's graph.
 *
 * Current vs. past (spec §1.3): `current=true` restricts to relationships whose
 * `validUntil` is null or in the future; `asOf=DATE` restricts to relationships
 * valid at that instant (`validFrom <= asOf` and `validUntil` null or after it).
 *
 * Logging never emits entity names, chunk text, PII, or secrets — only counts
 * and identifiers (spec §0).
 */
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, asc, eq, gt, ilike, isNull, lte, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  EntityDetail,
  EntitySummary,
  EntityType,
  GraphExtractResponse,
  RelationshipSummary,
  RelationshipType,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { QUEUE_NAMES } from '@family/shared';

import { DB } from '../database/database.constants';

/* -------------------------------------------------------------------------- */
/* Option shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Filters for {@link GraphService.listEntities}. */
export interface ListEntitiesOptions {
  workspaceId: string;
  type?: EntityType;
  q?: string;
}

/** Temporal filters for {@link GraphService.getEntity} (local graph, spec §1.4). */
export interface GetEntityOptions {
  current?: boolean;
  asOf?: string;
}

/** Filters for {@link GraphService.listRelationships} (spec §1.3/§6.2). */
export interface ListRelationshipsOptions {
  workspaceId: string;
  entityId?: string;
  type?: RelationshipType;
  current?: boolean;
  asOf?: string;
}

/** Selector for {@link GraphService.timeline}. */
export interface TimelineOptions {
  workspaceId: string;
  entityId: string;
}

/**
 * Input for {@link GraphService.supersedeRelationship} — the replacement
 * relationship (spec §1.3/§6.2). Mirrors `relationshipSupersedeRequestSchema`.
 */
export interface SupersedeRelationshipInput {
  sourceEntityId: string;
  targetEntityId: string;
  type: RelationshipType;
  sourceRefId?: string;
}

/* -------------------------------------------------------------------------- */
/* Internal row shapes                                                        */
/* -------------------------------------------------------------------------- */

/** Minimal entity projection consumed by {@link toEntitySummary}. */
interface EntityRowLike {
  id: string;
  type: EntityType;
  name: string;
  canonicalName: string;
  validFrom: Date | null;
  validUntil: Date | null;
  createdAt: Date;
}

/** Relationship row joined with source/target entity display names. */
interface RelationshipSummaryRow {
  id: string;
  type: RelationshipType;
  sourceEntityId: string;
  targetEntityId: string;
  validFrom: Date | null;
  validUntil: Date | null;
  supersedesRelationshipId: string | null;
  sourceChunkId: string | null;
  sourceChunkRevisionId: string | null;
  extractorVersion: string;
  sourceRefId: string | null;
  confidence: number;
  sourceName: string;
  targetName: string;
}

/* -------------------------------------------------------------------------- */
/* Query building blocks                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Self-joins of `entities` used to resolve a relationship's source and target
 * display names in one query (module-level so the column maps below can reuse
 * the same table instances).
 */
const sourceEntityAlias = alias(schema.entities, 'source_entity');
const targetEntityAlias = alias(schema.entities, 'target_entity');

/** Relationship columns + joined source/target names (→ {@link RelationshipSummaryRow}). */
const relationshipWithNamesColumns = {
  id: schema.relationships.id,
  type: schema.relationships.type,
  sourceEntityId: schema.relationships.sourceEntityId,
  targetEntityId: schema.relationships.targetEntityId,
  validFrom: schema.relationships.validFrom,
  validUntil: schema.relationships.validUntil,
  supersedesRelationshipId: schema.relationships.supersedesRelationshipId,
  sourceChunkId: schema.relationships.sourceChunkId,
  sourceChunkRevisionId: schema.relationships.sourceChunkRevisionId,
  extractorVersion: schema.relationships.extractorVersion,
  sourceRefId: schema.relationships.sourceRefId,
  confidence: schema.relationships.confidence,
  sourceName: sourceEntityAlias.name,
  targetName: targetEntityAlias.name,
} as const;

/** {@link relationshipWithNamesColumns} plus both endpoints' full entity fields (local graph). */
const neighborColumns = {
  ...relationshipWithNamesColumns,
  sourceId: sourceEntityAlias.id,
  sourceType: sourceEntityAlias.type,
  sourceCanonicalName: sourceEntityAlias.canonicalName,
  sourceValidFrom: sourceEntityAlias.validFrom,
  sourceValidUntil: sourceEntityAlias.validUntil,
  sourceCreatedAt: sourceEntityAlias.createdAt,
  targetId: targetEntityAlias.id,
  targetType: targetEntityAlias.type,
  targetCanonicalName: targetEntityAlias.canonicalName,
  targetValidFrom: targetEntityAlias.validFrom,
  targetValidUntil: targetEntityAlias.validUntil,
  targetCreatedAt: targetEntityAlias.createdAt,
} as const;

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @InjectQueue(QUEUE_NAMES.GRAPH_EXTRACT)
    private readonly extractQueue: Queue,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Ownership                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Asserts `userId` owns `workspaceId` (PRD §26). Missing workspace → 404;
   * another owner → 403. Called at the start of every workspace-scoped
   * operation and after resolving an entity/relationship to its workspace.
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
   * Enqueues deterministic rule-based graph extraction over an owned
   * workspace's chunks. The job id is keyed by workspace (colon-free per the
   * BullMQ constraint, spec §0) so an accidental re-enqueue collapses; completed
   * jobs are removed to allow re-runs (idempotent extraction, spec §1.1/§1.2).
   */
  async extract(
    userId: string,
    input: { workspaceId: string },
  ): Promise<GraphExtractResponse> {
    const { workspaceId } = input;
    await this.assertOwnedWorkspace(userId, workspaceId);

    // BullMQ 커스텀 jobId 에는 ':' 를 쓸 수 없다 → '_' 사용(스펙 §0).
    const jobId = `graph-extract_${workspaceId}`;
    await this.extractQueue.add(
      'extract',
      { workspaceId },
      { jobId, removeOnComplete: true },
    );

    this.logger.log(
      `graph extract enqueued workspace=${workspaceId} jobId=${jobId} status=queued`,
    );

    return { jobId, status: 'queued' };
  }

  /* ---------------------------------------------------------------------- */
  /* Entities                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists a workspace's entities with an optional `type` filter and a `q`
   * name substring match (ILIKE), with `isCurrent` derived (spec §6.2).
   */
  async listEntities(
    userId: string,
    options: ListEntitiesOptions,
  ): Promise<EntitySummary[]> {
    const { workspaceId, type, q } = options;
    await this.assertOwnedWorkspace(userId, workspaceId);

    const filters: SQL[] = [eq(schema.entities.workspaceId, workspaceId)];
    if (type) {
      filters.push(eq(schema.entities.type, type));
    }
    if (q) {
      filters.push(ilike(schema.entities.name, `%${escapeLike(q)}%`));
    }

    const rows = await this.db
      .select()
      .from(schema.entities)
      .where(and(...filters))
      .orderBy(asc(schema.entities.type), asc(schema.entities.name));

    const now = new Date();
    this.logger.log(
      `graph entities listed workspace=${workspaceId} type=${type ?? 'all'} ` +
        `q=${q ? 'yes' : 'no'} count=${rows.length}`,
    );

    return rows.map((row) => toEntitySummary(row, now));
  }

  /**
   * Loads an entity plus its 1-hop local graph (spec §1.4): every relationship
   * in which the entity participates as source or target — optionally
   * current/as-of filtered — joined with the opposite entity's summary.
   */
  async getEntity(
    userId: string,
    entityId: string,
    options: GetEntityOptions = {},
  ): Promise<EntityDetail> {
    const entity = await this.loadEntity(entityId);
    await this.assertOwnedWorkspace(userId, entity.workspaceId);

    const now = new Date();
    const filters: SQL[] = [eq(schema.relationships.workspaceId, entity.workspaceId)];
    const participation = or(
      eq(schema.relationships.sourceEntityId, entityId),
      eq(schema.relationships.targetEntityId, entityId),
    );
    if (participation) {
      filters.push(participation);
    }
    filters.push(...this.validityFilters(now, options.current, options.asOf));

    const rows = await this.db
      .select(neighborColumns)
      .from(schema.relationships)
      .innerJoin(
        sourceEntityAlias,
        eq(sourceEntityAlias.id, schema.relationships.sourceEntityId),
      )
      .innerJoin(
        targetEntityAlias,
        eq(targetEntityAlias.id, schema.relationships.targetEntityId),
      )
      .where(and(...filters))
      .orderBy(asc(schema.relationships.validFrom));

    const neighbors = rows.map((row) => {
      // 이웃 = 초점 엔티티의 반대편(초점이 source면 target, 아니면 source).
      const focusIsSource = row.sourceEntityId === entityId;
      const opposite: EntityRowLike = focusIsSource
        ? {
            id: row.targetId,
            type: row.targetType,
            name: row.targetName,
            canonicalName: row.targetCanonicalName,
            validFrom: row.targetValidFrom,
            validUntil: row.targetValidUntil,
            createdAt: row.targetCreatedAt,
          }
        : {
            id: row.sourceId,
            type: row.sourceType,
            name: row.sourceName,
            canonicalName: row.sourceCanonicalName,
            validFrom: row.sourceValidFrom,
            validUntil: row.sourceValidUntil,
            createdAt: row.sourceCreatedAt,
          };
      return {
        relationship: toRelationshipSummary(row, now),
        entity: toEntitySummary(opposite, now),
      };
    });

    this.logger.log(
      `graph entity fetched entity=${entityId} workspace=${entity.workspaceId} ` +
        `current=${options.current ?? false} asOf=${options.asOf ?? 'none'} ` +
        `neighbors=${neighbors.length}`,
    );

    return {
      entity: toEntitySummary(entity, now),
      neighbors,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Relationships                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists a workspace's relationships joined with source/target names, with
   * optional `entityId` (participates as source or target), `type`, and
   * `current`/`asOf` temporal filters (spec §1.3/§6.2). `isCurrent` is derived.
   */
  async listRelationships(
    userId: string,
    options: ListRelationshipsOptions,
  ): Promise<RelationshipSummary[]> {
    const { workspaceId, entityId, type, current, asOf } = options;
    await this.assertOwnedWorkspace(userId, workspaceId);

    const now = new Date();
    const filters: SQL[] = [eq(schema.relationships.workspaceId, workspaceId)];
    if (type) {
      filters.push(eq(schema.relationships.type, type));
    }
    if (entityId) {
      const participation = or(
        eq(schema.relationships.sourceEntityId, entityId),
        eq(schema.relationships.targetEntityId, entityId),
      );
      if (participation) {
        filters.push(participation);
      }
    }
    filters.push(...this.validityFilters(now, current, asOf));

    const rows = await this.db
      .select(relationshipWithNamesColumns)
      .from(schema.relationships)
      .innerJoin(
        sourceEntityAlias,
        eq(sourceEntityAlias.id, schema.relationships.sourceEntityId),
      )
      .innerJoin(
        targetEntityAlias,
        eq(targetEntityAlias.id, schema.relationships.targetEntityId),
      )
      .where(and(...filters))
      .orderBy(asc(schema.relationships.validFrom));

    this.logger.log(
      `graph relationships listed workspace=${workspaceId} ` +
        `entityId=${entityId ?? 'none'} type=${type ?? 'all'} ` +
        `current=${current ?? false} asOf=${asOf ?? 'none'} count=${rows.length}`,
    );

    return rows.map((row) => toRelationshipSummary(row, now));
  }

  /**
   * Explicitly supersedes a relationship (PRD §20 / spec §1.3). In one
   * transaction: closes the old relationship (`validUntil=now`) and inserts the
   * replacement carrying `supersedesRelationshipId` (→ old), `validFrom=now`,
   * and the caller-supplied source/target/type/sourceRefId (confidence inherited
   * from the superseded relationship). Returns the new relationship. Supersede is
   * always explicit — decision changes are never inferred.
   */
  async supersedeRelationship(
    userId: string,
    relationshipId: string,
    input: SupersedeRelationshipInput,
  ): Promise<RelationshipSummary> {
    const existing = await this.loadRelationship(relationshipId);
    await this.assertOwnedWorkspace(userId, existing.workspaceId);

    const now = new Date();

    const newRelationshipId = await this.db.transaction(async (tx) => {
      await tx
        .update(schema.relationships)
        .set({ validUntil: now, updatedAt: now })
        .where(eq(schema.relationships.id, relationshipId));

      const [inserted] = await tx
        .insert(schema.relationships)
        .values({
          workspaceId: existing.workspaceId,
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          type: input.type,
          validFrom: now,
          validUntil: null,
          supersedesRelationshipId: relationshipId,
          extractorVersion: 'human-supersede-v1',
          sourceRefId: input.sourceRefId ?? null,
          confidence: existing.confidence,
        })
        .returning({ id: schema.relationships.id });

      await tx.insert(schema.feedbackEvents).values({
        workspaceId: existing.workspaceId,
        targetType: 'graph-relationship',
        targetId: relationshipId,
        labelSchemaVersion: 'graph-supersede-v1',
        label: {
          decision: 'superseded',
          replacementId: inserted.id,
          relationshipType: input.type,
        },
        source: 'human_confirmed',
        actorUserId: userId,
        occurredAt: now,
      });

      return inserted.id;
    });

    this.logger.log(
      `graph relationship superseded old=${relationshipId} ` +
        `new=${newRelationshipId} workspace=${existing.workspaceId}`,
    );

    return this.getRelationshipSummary(newRelationshipId, now);
  }

  /**
   * Returns an entity's relationship history (spec §1.4): every relationship in
   * which it participates (source or target), ordered by `validFrom` ascending
   * (relationship formation/change over time). No temporal filter — the full
   * chain, including superseded links, is returned.
   */
  async timeline(
    userId: string,
    options: TimelineOptions,
  ): Promise<RelationshipSummary[]> {
    const { workspaceId, entityId } = options;
    await this.assertOwnedWorkspace(userId, workspaceId);

    const now = new Date();
    const filters: SQL[] = [eq(schema.relationships.workspaceId, workspaceId)];
    const participation = or(
      eq(schema.relationships.sourceEntityId, entityId),
      eq(schema.relationships.targetEntityId, entityId),
    );
    if (participation) {
      filters.push(participation);
    }

    const rows = await this.db
      .select(relationshipWithNamesColumns)
      .from(schema.relationships)
      .innerJoin(
        sourceEntityAlias,
        eq(sourceEntityAlias.id, schema.relationships.sourceEntityId),
      )
      .innerJoin(
        targetEntityAlias,
        eq(targetEntityAlias.id, schema.relationships.targetEntityId),
      )
      .where(and(...filters))
      .orderBy(asc(schema.relationships.validFrom));

    this.logger.log(
      `graph timeline entity=${entityId} workspace=${workspaceId} ` +
        `count=${rows.length}`,
    );

    return rows.map((row) => toRelationshipSummary(row, now));
  }

  /* ---------------------------------------------------------------------- */
  /* Internal helpers                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Builds the temporal WHERE fragments (spec §1.3): `current` keeps rows whose
   * `validUntil` is null or after `now`; `asOf` keeps rows valid at that instant
   * (`validFrom <= asOf` and `validUntil` null or after it). An invalid `asOf`
   * is a 400.
   */
  private validityFilters(
    now: Date,
    current?: boolean,
    asOf?: string,
  ): SQL[] {
    const filters: SQL[] = [];
    if (current) {
      const validNow = or(
        isNull(schema.relationships.validUntil),
        gt(schema.relationships.validUntil, now),
      );
      if (validNow) {
        filters.push(validNow);
      }
    }
    if (asOf) {
      const asOfDate = new Date(asOf);
      if (Number.isNaN(asOfDate.getTime())) {
        throw new BadRequestException('asOf must be a valid ISO datetime');
      }
      filters.push(lte(schema.relationships.validFrom, asOfDate));
      const validAsOf = or(
        isNull(schema.relationships.validUntil),
        gt(schema.relationships.validUntil, asOfDate),
      );
      if (validAsOf) {
        filters.push(validAsOf);
      }
    }
    return filters;
  }

  /** Loads an entity or throws 404. */
  private async loadEntity(
    entityId: string,
  ): Promise<typeof schema.entities.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('entity not found');
    }
    return row;
  }

  /** Loads a relationship or throws 404. */
  private async loadRelationship(
    relationshipId: string,
  ): Promise<typeof schema.relationships.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(schema.relationships)
      .where(eq(schema.relationships.id, relationshipId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('relationship not found');
    }
    return row;
  }

  /** Loads a single relationship (with names) and projects it to the API summary. */
  private async getRelationshipSummary(
    relationshipId: string,
    now: Date,
  ): Promise<RelationshipSummary> {
    const [row] = await this.db
      .select(relationshipWithNamesColumns)
      .from(schema.relationships)
      .innerJoin(
        sourceEntityAlias,
        eq(sourceEntityAlias.id, schema.relationships.sourceEntityId),
      )
      .innerJoin(
        targetEntityAlias,
        eq(targetEntityAlias.id, schema.relationships.targetEntityId),
      )
      .where(eq(schema.relationships.id, relationshipId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('relationship not found');
    }
    return toRelationshipSummary(row, now);
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level projections                                                   */
/* -------------------------------------------------------------------------- */

/** Escapes LIKE/ILIKE wildcards so a `q` substring matches literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Projects an entity row to the API `EntitySummary`, deriving `isCurrent`
 * (`validUntil` null or after `now`, spec §1.1/§1.3).
 */
function toEntitySummary(row: EntityRowLike, now: Date): EntitySummary {
  const isCurrent =
    row.validUntil === null || row.validUntil.getTime() > now.getTime();

  return {
    id: row.id,
    type: row.type,
    name: row.name,
    canonicalName: row.canonicalName,
    validFrom: row.validFrom ? row.validFrom.toISOString() : null,
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    isCurrent,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Projects a name-joined relationship row to the API `RelationshipSummary`,
 * deriving `isCurrent` (`validUntil` null or after `now`, spec §1.3).
 */
function toRelationshipSummary(
  row: RelationshipSummaryRow,
  now: Date,
): RelationshipSummary {
  const isCurrent =
    row.validUntil === null || row.validUntil.getTime() > now.getTime();

  return {
    id: row.id,
    type: row.type,
    sourceEntityId: row.sourceEntityId,
    targetEntityId: row.targetEntityId,
    sourceName: row.sourceName,
    targetName: row.targetName,
    validFrom: row.validFrom ? row.validFrom.toISOString() : null,
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    supersedesRelationshipId: row.supersedesRelationshipId,
    isCurrent,
    sourceChunkId: row.sourceChunkId,
    sourceChunkRevisionId: row.sourceChunkRevisionId,
    extractorVersion: row.extractorVersion,
    sourceRefId: row.sourceRefId,
    confidence: row.confidence,
  };
}
