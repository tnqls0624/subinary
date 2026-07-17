import { z } from 'zod';

/** Card-SMS parsing lifecycle (PRD §31 Phase 3; mirrors DB `cardSmsParseStatus`). */
export const cardSmsParseStatusSchema = z.enum([
  'pending',
  'parsed',
  'parse_failed',
  'pending_review',
]);
export type CardSmsParseStatus = z.infer<typeof cardSmsParseStatusSchema>;

/** Card transaction kind resolved by the parser (mirrors DB `cardSmsTxnType`). */
export const cardSmsTransactionTypeSchema = z.enum(['approval', 'cancellation', 'unknown']);
export type CardSmsTransactionType = z.infer<typeof cardSmsTransactionTypeSchema>;

/** Ingest disposition — `queued` on first accept, `duplicate` on idempotent replay. */
const cardSmsProcessingStatusSchema = z.enum(['queued', 'duplicate']);

// --- Requests ---

/**
 * `POST /v1/mobile-events/card-sms` — submit a raw card SMS for parsing (PRD §10.3).
 * HMAC-guarded; the device principal supplies household/member scope.
 *
 * `receivedAt` is optional: automation tools that cannot easily format a UTC
 * ISO-8601 timestamp (e.g. Android MacroDroid, whose date variables are local
 * time) may omit it entirely — the server stamps `now()` on ingest. When
 * present it must be UTC (`Z` suffix). The parsed transaction time comes from
 * the SMS body (`MM/DD HH:mm`, no year) with the year resolved *relative to
 * receivedAt* — so a server-stamped `now()` is accurate for live forwarding,
 * but backfilling messages older than ~1 year without an explicit receivedAt
 * will resolve the wrong year. Supply receivedAt when replaying old archives.
 */
export const cardSmsIngestRequestSchema = z.object({
  eventId: z.string().min(1).max(200),
  sender: z.string().min(1).max(100),
  content: z.string().min(1).max(4000),
  receivedAt: z.string().datetime().optional(),
});
export type CardSmsIngestRequest = z.infer<typeof cardSmsIngestRequestSchema>;

// --- Responses ---

/**
 * Ingest acknowledgement. `accepted` is always `true`; `duplicate` distinguishes
 * a fresh enqueue (`processingStatus: 'queued'`) from an idempotent replay.
 */
export const cardSmsIngestResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string(),
  processingStatus: cardSmsProcessingStatusSchema,
  duplicate: z.boolean(),
});
export type CardSmsIngestResponse = z.infer<typeof cardSmsIngestResponseSchema>;

/**
 * List projection for `GET /v1/card-sms-events`. Excludes the raw content —
 * that is only surfaced in the detail view. Amounts are KRW integers.
 */
export const cardSmsEventSummarySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  sender: z.string(),
  receivedAt: z.string(),
  parseStatus: cardSmsParseStatusSchema,
  issuer: z.string().nullable(),
  transactionType: cardSmsTransactionTypeSchema.nullable(),
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  merchantRaw: z.string().nullable(),
  occurredAt: z.string().nullable(),
  installmentMonths: z.number().int().nullable(),
  confidence: z.number().int().nullable(),
  parseError: z.string().nullable(),
  createdAt: z.string(),
});
export type CardSmsEventSummary = z.infer<typeof cardSmsEventSummarySchema>;

/**
 * Detail projection for `GET /v1/card-sms-events/:id` — summary plus the raw
 * content (parse-failure review) and the masked card number.
 */
export const cardSmsEventDetailSchema = cardSmsEventSummarySchema.extend({
  rawContent: z.string(),
  maskedCardNumber: z.string().nullable(),
});
export type CardSmsEventDetail = z.infer<typeof cardSmsEventDetailSchema>;

/**
 * `GET /v1/mobile-events/card-sms/:eventId/status` — lightweight status poll for
 * an ingested event (device-facing).
 */
export const mobileEventStatusResponseSchema = z.object({
  eventId: z.string(),
  parseStatus: cardSmsParseStatusSchema,
  processingStatus: z.string(),
});
export type MobileEventStatusResponse = z.infer<typeof mobileEventStatusResponseSchema>;
