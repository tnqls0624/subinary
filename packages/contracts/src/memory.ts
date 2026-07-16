import { z } from 'zod';

/**
 * Long-term memory contracts (PRD §20/§3.1/§26; Phase 8 spec §4). Deterministic
 * rule-based extraction turns Slack-derived chunks into `memory_candidates`; the
 * owner reviews and approves them into `memories`, each traced back to its source
 * text via `memory_sources`.
 *
 * Ownership: memory is owner-only — only the workspace `ownerUserId` may read or
 * mutate it (PRD §26); non-owners get 403 at the service layer.
 *
 * Current vs. past is expressed with `validFrom`/`validUntil` and supersede
 * (PRD §20): a memory is current while approved and `validUntil` is null or in
 * the future. Timestamps are ISO strings (Asia/Seoul) — responses use plain
 * `z.string()`, requests use `z.string().datetime()`. `confidence` is an integer
 * 0–100. `subjectHash` (candidate idempotency) is a DB concern and not exposed.
 */

/** Memory classification (mirrors DB `memoryType`; PRD §20). */
export const memoryTypeSchema = z.enum([
  'event',
  'fact',
  'decision',
  'preference',
  'procedure',
  'incident',
  'task',
]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

/** Memory lifecycle (mirrors DB `memoryStatus`; spec §2). */
export const memoryStatusSchema = z.enum(['candidate', 'approved', 'rejected', 'superseded']);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

/** Candidate review lifecycle (mirrors DB `candidateStatus`; spec §2). */
export const candidateStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

/** Source provenance kind (mirrors DB `memorySourceType`; PRD §3.1). */
const memorySourceTypeSchema = z.enum(['chunk', 'slack_message', 'card_sms', 'manual']);

/**
 * Source attribution attached to a memory (PRD §3.1). `sourceRefId` traces back
 * to the originating chunk id, Slack `threadTs`/`ts`, card-SMS event, or is a
 * marker for manually created memories.
 */
const memorySourceSchema = z.object({
  sourceType: memorySourceTypeSchema,
  sourceRefId: z.string(),
});

// --- Requests ---

/**
 * `POST /v1/memory/extract` — enqueue rule-based extraction over the owner's
 * workspace chunks (spec §6.2). Owner-only.
 */
export const memoryExtractRequestSchema = z.object({
  workspaceId: z.string().uuid(),
});
export type MemoryExtractRequest = z.infer<typeof memoryExtractRequestSchema>;

/**
 * `POST /v1/memory/candidates/:id/approve` — promote a pending candidate into a
 * memory (spec §6.2). All fields optional: they override the candidate's
 * `subject`/`content` and set validity when approving. Omitted `validFrom`
 * defaults to now; omitted `validUntil` leaves the memory current.
 */
export const candidateApproveRequestSchema = z.object({
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  subject: z.string().optional(),
  content: z.string().optional(),
});
export type CandidateApproveRequest = z.infer<typeof candidateApproveRequestSchema>;

/**
 * `POST /v1/memory/memories` — directly create an approved memory (PRD §20
 * explicit "remember this"; spec §1.1). `observedAt` defaults to now when
 * omitted; `validFrom` defaults to `observedAt`. Source is recorded as `manual`.
 * Owner-only.
 */
export const memoryCreateRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  type: memoryTypeSchema,
  subject: z.string().min(1),
  content: z.string().min(1),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  observedAt: z.string().datetime().optional(),
});
export type MemoryCreateRequest = z.infer<typeof memoryCreateRequestSchema>;

/**
 * `PATCH /v1/memory/memories/:id` — edit a memory (spec §1.4). The pre-edit
 * snapshot is recorded in `memory_versions`. `validUntil` accepts null to clear
 * an expiry (make the memory current again). Owner-only.
 */
export const memoryUpdateRequestSchema = z.object({
  subject: z.string().optional(),
  content: z.string().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  changeReason: z.string().optional(),
});
export type MemoryUpdateRequest = z.infer<typeof memoryUpdateRequestSchema>;

/**
 * `POST /v1/memory/memories/:id/supersede` — replace an existing memory with a
 * new one (PRD §20). The old memory is marked `superseded` (validUntil=now); the
 * new memory carries `supersedesMemoryId` and `validFrom=now` (spec §1.3).
 * `observedAt` defaults to now. Owner-only.
 */
export const memorySupersedeRequestSchema = z.object({
  type: memoryTypeSchema,
  subject: z.string(),
  content: z.string(),
  observedAt: z.string().datetime().optional(),
});
export type MemorySupersedeRequest = z.infer<typeof memorySupersedeRequestSchema>;

// --- Responses ---

/**
 * `POST /v1/memory/extract` acknowledgement. Extraction runs asynchronously on
 * the `memory-extract` queue, so the initial status is always `queued`.
 */
export const memoryExtractResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued']),
});
export type MemoryExtractResponse = z.infer<typeof memoryExtractResponseSchema>;

/**
 * Candidate projection for `GET /v1/memory/candidates` (spec §6.2). `sourceChunkId`
 * links to the originating chunk and `sourceRefId` mirrors the chunk's own source
 * ref (Slack `threadTs` etc.); both are null when the candidate is unbound.
 */
export const candidateSummarySchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  subject: z.string(),
  content: z.string(),
  confidence: z.number().int(),
  status: candidateStatusSchema,
  sourceChunkId: z.string().nullable(),
  sourceRefId: z.string().nullable(),
  extractedAt: z.string(),
});
export type CandidateSummary = z.infer<typeof candidateSummarySchema>;

/**
 * Memory projection for `GET /v1/memory/memories` and mutation results.
 * `isCurrent` is derived: approved and `validUntil` null or in the future
 * (spec §1.3/§6.2). `supersedesMemoryId` is the replaced memory when this one was
 * created via supersede. `sources` lists the traced-back origin refs (PRD §3.1).
 */
export const memorySummarySchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  subject: z.string(),
  content: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  observedAt: z.string(),
  confidence: z.number().int(),
  status: memoryStatusSchema,
  supersedesMemoryId: z.string().nullable(),
  isCurrent: z.boolean(),
  sources: z.array(memorySourceSchema),
  createdAt: z.string(),
});
export type MemorySummary = z.infer<typeof memorySummarySchema>;

/** `GET /v1/memory/candidates` — candidates for a workspace (optional status filter). */
export const candidateListResponseSchema = z.object({
  items: z.array(candidateSummarySchema),
});
export type CandidateListResponse = z.infer<typeof candidateListResponseSchema>;

/**
 * `GET /v1/memory/memories` — memories for a workspace. `current=true`/`asOf=DATE`
 * filtering and type/status filters are applied server-side (spec §1.3/§6.2).
 */
export const memoryListResponseSchema = z.object({
  items: z.array(memorySummarySchema),
});
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;
