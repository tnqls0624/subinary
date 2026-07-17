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

// --- Finance AI (natural-language ledger query · monthly insights) ---

/**
 * Which path produced an AI response (프로젝트 절대 규약 #1): `llm` when the
 * LLM output was used, `fallback` when the deterministic rule/template path
 * answered (LLM error / JSON-parse failure / invalid output — and always under
 * AI_PROVIDER=mock). The pipeline never fails because of the LLM.
 */
export const aiAnswerMethodSchema = z.enum(['llm', 'fallback']);
export type AiAnswerMethod = z.infer<typeof aiAnswerMethodSchema>;

/**
 * `POST /v1/ai/finance-query` — ask a natural-language question over the
 * household ledger (e.g. "이번 달 카페에 얼마 썼어요?"). Any active household
 * member may ask; the analytics visibility scope applies (PRD §26).
 */
export const financeQueryRequestSchema = z.object({
  householdId: z.string().uuid(),
  question: z.string().min(1).max(300),
});
export type FinanceQueryRequest = z.infer<typeof financeQueryRequestSchema>;

/** Aggregation shape the finance query resolves the question into. */
export const financeAggregateKindSchema = z.enum([
  'total',
  'byCategory',
  'byMerchant',
]);
export type FinanceAggregateKind = z.infer<typeof financeAggregateKindSchema>;

/** One labeled aggregation row (category or merchant), KRW-integer net. */
export const financeQueryItemSchema = z.object({
  label: z.string(),
  net: z.number().int(),
  count: z.number().int(),
});
export type FinanceQueryItem = z.infer<typeof financeQueryItemSchema>;

/**
 * The aggregation summary a finance-query answer is grounded in. All amounts
 * are computed in SQL by the analytics service (never by the LLM): `totalNet`
 * is the resolved scope's net spend (the matched category's net when
 * `categorySlug` resolved), `items` are the top breakdown rows for
 * byCategory/byMerchant questions.
 */
export const financeQueryDataSchema = z.object({
  month: z.string(),
  aggregate: financeAggregateKindSchema,
  categorySlug: z.string().nullable(),
  categoryName: z.string().nullable(),
  totalNet: z.number().int(),
  transactionCount: z.number().int(),
  items: z.array(financeQueryItemSchema).optional(),
});
export type FinanceQueryData = z.infer<typeof financeQueryDataSchema>;

/**
 * `POST /v1/ai/finance-query` result. `answer` is 해요체 prose grounded in
 * `data` (the SQL aggregates); `method` reports whether the LLM or the
 * deterministic template produced it.
 */
export const financeQueryResponseSchema = z.object({
  answer: z.string(),
  data: financeQueryDataSchema.optional(),
  method: aiAnswerMethodSchema,
});
export type FinanceQueryResponse = z.infer<typeof financeQueryResponseSchema>;

/** Monthly insight kind — 전월 대비 추세 / 이상 지출 / 예산 소진 예측. */
export const monthlyInsightKindSchema = z.enum(['trend', 'anomaly', 'budget']);
export type MonthlyInsightKind = z.infer<typeof monthlyInsightKindSchema>;

/** One monthly insight (해요체 message). */
export const monthlyInsightSchema = z.object({
  kind: monthlyInsightKindSchema,
  message: z.string(),
});
export type MonthlyInsight = z.infer<typeof monthlyInsightSchema>;

/**
 * `GET /v1/ai/monthly-insights?householdId=&month=` result. Facts are computed
 * deterministically on the server (SQL aggregates + linear budget
 * extrapolation); the LLM only rephrases them — on any LLM failure the
 * server-side template wording is returned as-is (`method: 'fallback'`).
 * `insights` is empty when the month has no noteworthy data.
 */
export const monthlyInsightsResponseSchema = z.object({
  month: z.string(),
  insights: z.array(monthlyInsightSchema),
  method: aiAnswerMethodSchema,
});
export type MonthlyInsightsResponse = z.infer<
  typeof monthlyInsightsResponseSchema
>;
