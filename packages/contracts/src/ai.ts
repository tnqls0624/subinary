import { z } from 'zod';

/**
 * Hybrid RAG contracts (PRD §31 Phase 7; Phase 7 spec §7). Retrieval runs a
 * FTS(trgm) + vector search fused with RRF over Slack-derived chunks, and the
 * AI answer cites the passages it drew from.
 *
 * Ownership: Slack/RAG data is owner-only — only the workspace `ownerUserId`
 * may query it (PRD §26); non-owners get 403 at the service layer.
 *
 * Evidence sufficiency is decided by app logic, not the LLM: when no result
 * carries a FTS match the query is `refused` and the LLM is never called
 * (spec §1.3). `occurredAt` is an ISO string (Asia/Seoul); `score` is the RRF
 * fusion score (unitless, higher is better).
 */

/** Chunk provenance kind (mirrors DB `chunks.sourceType`; spec §2). */
export const chunkSourceTypeSchema = z.enum(['slack_thread', 'slack_message']);
export type ChunkSourceType = z.infer<typeof chunkSourceTypeSchema>;

/**
 * Source attribution for a retrieved chunk. Traced back to the originating
 * Slack thread/message: `sourceRefId` is the thread `threadTs` (for
 * `slack_thread`) or the message `ts` (for `slack_message`). `channelName` is
 * null when the chunk is not bound to a resolved channel. `score` is the RRF
 * fusion score. Every answer includes these at 100% coverage (spec §1.4).
 */
export const citationSchema = z.object({
  chunkId: z.string(),
  sourceType: chunkSourceTypeSchema,
  channelName: z.string().nullable(),
  sourceRefId: z.string(),
  occurredAt: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type Citation = z.infer<typeof citationSchema>;

// --- Requests ---

/**
 * `POST /v1/ai/work-query` — ask a question over the owner's Slack workspace.
 * The answer is grounded in retrieved passages or refused when no evidence is
 * found. Owner-only.
 */
export const workQueryRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  question: z.string().min(1).max(1000),
});
export type WorkQueryRequest = z.infer<typeof workQueryRequestSchema>;

/**
 * `POST /v1/ai/retrieval` — hybrid search debug/verification endpoint. Returns
 * ranked chunks without generating an answer. `topK` defaults to 5. Owner-only.
 */
export const retrievalRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).default(5),
});
export type RetrievalRequest = z.infer<typeof retrievalRequestSchema>;

// --- Responses ---

/** Answer provenance/meta — retrieved candidate count and the LLM model id. */
export const workQueryMetaSchema = z.object({
  retrievedCount: z.number().int(),
  model: z.string(),
});
export type WorkQueryMeta = z.infer<typeof workQueryMetaSchema>;

/**
 * `POST /v1/ai/work-query` result. When `refused` is true the query lacked
 * evidence: `answer` is null, `reason` explains the refusal, and `citations`
 * is empty (the LLM was not called). Otherwise `answer` is grounded prose,
 * `reason` is null, and `citations` lists every cited source.
 */
export const workQueryResponseSchema = z.object({
  refused: z.boolean(),
  answer: z.string().nullable(),
  reason: z.string().nullable(),
  citations: z.array(citationSchema),
  meta: workQueryMetaSchema,
});
export type WorkQueryResponse = z.infer<typeof workQueryResponseSchema>;

/**
 * One ranked retrieval hit. `score` is the RRF fusion score (descending across
 * items); `hasFtsMatch` marks whether the chunk cleared the FTS similarity
 * threshold — it is the signal that drives evidence sufficiency (spec §1.3).
 */
export const retrievalItemSchema = z.object({
  chunkId: z.string(),
  snippet: z.string(),
  score: z.number(),
  hasFtsMatch: z.boolean(),
  citation: citationSchema,
});
export type RetrievalItem = z.infer<typeof retrievalItemSchema>;

/**
 * `POST /v1/ai/retrieval` result. `hasEvidence` is true when at least one item
 * has a FTS match; `items` are ordered by RRF `score` descending.
 */
export const retrievalResponseSchema = z.object({
  hasEvidence: z.boolean(),
  items: z.array(retrievalItemSchema),
});
export type RetrievalResponse = z.infer<typeof retrievalResponseSchema>;
