import { z } from 'zod';

/**
 * Temporal GraphRAG contracts (PRD §20/§22/§26; Phase 9 spec §4). Deterministic
 * rule-based extraction turns Slack-derived chunks + slack_users into `entities`
 * (person/technology) and `relationships` (relates_to/resolves), each relationship
 * traced back to its source text via `sourceRefId` (spec §1.1/§1.2).
 *
 * Ownership: the graph is owner-only — only the workspace `ownerUserId` may read
 * or mutate it (PRD §26); non-owners get 403 at the service layer.
 *
 * Current vs. past is expressed with `validFrom`/`validUntil` and explicit
 * supersede (PRD §20/§22): a relationship is current while `validUntil` is null
 * or in the future. Supersede is never inferred — a new relationship explicitly
 * replaces an existing one (old `validUntil=now`, new `supersedesRelationshipId`
 * + `validFrom=now`; spec §1.3). Timestamps are ISO strings (Asia/Seoul):
 * responses use plain `z.string()`, requests use `z.string().uuid()` for ids.
 * `confidence` is an integer.
 */

/** Entity classification (mirrors DB `entityType`; spec §2). */
export const entityTypeSchema = z.enum([
  'person',
  'technology',
  'project',
  'decision',
  'incident',
  'topic',
]);
export type EntityType = z.infer<typeof entityTypeSchema>;

/** Relationship classification (mirrors DB `relationshipType`; spec §2). */
export const relationshipTypeSchema = z.enum([
  'relates_to',
  'resolves',
  'works_on',
  'uses',
  'decides',
  'supersedes',
]);
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;

// --- Requests ---

/**
 * `POST /v1/graph/extract` — enqueue deterministic graph extraction over the
 * owner's workspace chunks + slack_users (spec §5/§6.2). Owner-only.
 */
export const graphExtractRequestSchema = z.object({
  workspaceId: z.string().uuid(),
});
export type GraphExtractRequest = z.infer<typeof graphExtractRequestSchema>;

/**
 * `POST /v1/graph/relationships/:id/supersede` — explicitly replace an existing
 * relationship with a new one (PRD §20/§22; spec §1.3). The old relationship is
 * closed (`validUntil=now`); the new one carries `supersedesRelationshipId` and
 * `validFrom=now`, with `sourceEntityId`/`targetEntityId`/`type` taken from this
 * request. `sourceRefId` is optional (origin text of the replacing relationship).
 * Owner-only.
 */
export const relationshipSupersedeRequestSchema = z.object({
  sourceEntityId: z.string().uuid(),
  targetEntityId: z.string().uuid(),
  type: relationshipTypeSchema,
  sourceRefId: z.string().optional(),
});
export type RelationshipSupersedeRequest = z.infer<typeof relationshipSupersedeRequestSchema>;

// --- Responses ---

/**
 * `POST /v1/graph/extract` acknowledgement. Extraction runs asynchronously on
 * the `graph-extract` queue, so the initial status is always `queued`.
 */
export const graphExtractResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued']),
});
export type GraphExtractResponse = z.infer<typeof graphExtractResponseSchema>;

/**
 * Entity projection for `GET /v1/graph/entities` and `GET /v1/graph/entities/:id`
 * (spec §6.2). `isCurrent` is derived: `validUntil` is null or in the future
 * (spec §1.3). `canonicalName` is the idempotency key (person=slackUserId,
 * technology=lowercased term; spec §1.1).
 */
export const entitySummarySchema = z.object({
  id: z.string(),
  type: entityTypeSchema,
  name: z.string(),
  canonicalName: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  isCurrent: z.boolean(),
  createdAt: z.string(),
});
export type EntitySummary = z.infer<typeof entitySummarySchema>;

/**
 * Relationship projection for `GET /v1/graph/relationships`, local graph
 * neighbors, and mutation results (spec §6.2). `sourceName`/`targetName` are the
 * joined endpoint entity names. `isCurrent` is derived: `validUntil` null or in
 * the future (spec §1.3). `supersedesRelationshipId` is the replaced relationship
 * when this one was created via supersede. `sourceRefId` links to the originating
 * chunk (null for explicitly superseding relationships without an origin ref).
 * 자동 추출 행은 source chunk/revision과 extractor version도 함께 노출한다.
 */
export const relationshipSummarySchema = z.object({
  id: z.string(),
  type: relationshipTypeSchema,
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  sourceName: z.string(),
  targetName: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  supersedesRelationshipId: z.string().nullable(),
  isCurrent: z.boolean(),
  sourceChunkId: z.string().nullable(),
  sourceChunkRevisionId: z.string().nullable(),
  extractorVersion: z.string(),
  sourceRefId: z.string().nullable(),
  confidence: z.number().int(),
});
export type RelationshipSummary = z.infer<typeof relationshipSummarySchema>;

/**
 * One local-graph neighbor: the connecting `relationship` and the entity on the
 * other end (spec §1.4). Endpoint direction is preserved in the relationship's
 * `sourceEntityId`/`targetEntityId`.
 */
const entityNeighborSchema = z.object({
  relationship: relationshipSummarySchema,
  entity: entitySummarySchema,
});

/**
 * `GET /v1/graph/entities/:id` — local graph around one entity (spec §1.4/§6.2).
 * `neighbors` are the 1-hop relationships (entity as source or target) with the
 * opposite endpoint, filtered by `current`/`asOf` server-side.
 */
export const entityDetailSchema = z.object({
  entity: entitySummarySchema,
  neighbors: z.array(entityNeighborSchema),
});
export type EntityDetail = z.infer<typeof entityDetailSchema>;

/**
 * `GET /v1/graph/entities` — entities for a workspace. Optional `type` and `q`
 * (name ILIKE) filters are applied server-side (spec §6.2).
 */
export const entityListResponseSchema = z.object({
  items: z.array(entitySummarySchema),
});
export type EntityListResponse = z.infer<typeof entityListResponseSchema>;

/**
 * `GET /v1/graph/relationships` — relationships for a workspace. Optional
 * `entityId`/`type` filters and `current=true`/`asOf=DATE` temporal filtering are
 * applied server-side (spec §1.3/§6.2).
 */
export const relationshipListResponseSchema = z.object({
  items: z.array(relationshipSummarySchema),
});
export type RelationshipListResponse = z.infer<typeof relationshipListResponseSchema>;

/**
 * `GET /v1/graph/timeline` — relationships touching one entity ordered by
 * `validFrom` ascending, i.e. the formation/change history (spec §1.4/§6.2).
 */
export const timelineResponseSchema = z.object({
  entityId: z.string(),
  items: z.array(relationshipSummarySchema),
});
export type TimelineResponse = z.infer<typeof timelineResponseSchema>;
