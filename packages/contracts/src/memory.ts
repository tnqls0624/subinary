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
 * Candidate projection for `GET /v1/memory/candidates` (spec §6.2).
 * `sourceChunkRevisionId`와 `extractorVersion`은 후보를 재현하는 immutable 입력·
 * 변환 경계이며, `sourceRefId`는 원본 Slack ref를 제공한다.
 */
export const candidateSummarySchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  subject: z.string(),
  content: z.string(),
  confidence: z.number().int(),
  status: candidateStatusSchema,
  sourceChunkId: z.string().nullable(),
  sourceChunkRevisionId: z.string().nullable(),
  extractorVersion: z.string(),
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

/**
 * 커서 페이지네이션 응답 필드(Memory·Graph 목록 공통 규약).
 *
 * 응답 형태는 `{ items }`를 그대로 유지하고 `nextCursor`만 **추가**한다 —
 * `apps/mcp`가 이미 `items`를 읽고 있어서 배열 래핑을 바꾸면 조용히 깨진다.
 * `nextCursor`가 null이면 마지막 페이지다. 값은 불투명 문자열이므로 해석하지 말고
 * 다음 요청의 `cursor=`에 그대로 실어 보낸다. 목록은 항상 상한이 걸린 채로
 * 반환된다(`limit` 미지정 시 서버 기본값).
 */
const nextCursorSchema = z.string().nullable();

/** `GET /v1/memory/candidates` — candidates for a workspace (optional status filter). */
export const candidateListResponseSchema = z.object({
  items: z.array(candidateSummarySchema),
  nextCursor: nextCursorSchema,
});
export type CandidateListResponse = z.infer<typeof candidateListResponseSchema>;

/**
 * `GET /v1/memory/memories` — memories for a workspace. `current=true`/`asOf=DATE`
 * filtering and type/status filters are applied server-side (spec §1.3/§6.2).
 */
export const memoryListResponseSchema = z.object({
  items: z.array(memorySummarySchema),
  nextCursor: nextCursorSchema,
});
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;
