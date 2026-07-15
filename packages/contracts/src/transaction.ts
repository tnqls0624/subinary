import { z } from 'zod';
import { cardVisibilitySchema } from './card.js';

/** Transaction kind (PRD §31 Phase 4; mirrors DB `txnType`). */
export const transactionTypeSchema = z.enum(['approval', 'cancellation']);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

/**
 * Transaction lifecycle status (mirrors DB `txnStatus`).
 * Cancellation records stay `approved`; the linked approval carries the
 * `partially_cancelled` / `cancelled` outcome.
 */
export const transactionStatusSchema = z.enum([
  'approved',
  'partially_cancelled',
  'cancelled',
  'pending_review',
  'duplicate_suspected',
]);
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

// --- Requests ---

/**
 * `PATCH /v1/transactions/:id` — edit a transaction's category, merchant,
 * card/member assignment, visibility, or memo. Setting `cardId: null` unlinks
 * the card. When `categoryId` changes and `applyRule` is true, a
 * `merchant_category_rules` entry is upserted so **future** promotions inherit it.
 */
export const transactionUpdateRequestSchema = z.object({
  categoryId: z.string().uuid().optional(),
  merchantNormalized: z.string().min(1).max(200).optional(),
  cardId: z.string().uuid().nullable().optional(),
  memberId: z.string().uuid().optional(),
  visibility: cardVisibilitySchema.optional(),
  memo: z.string().max(1000).optional(),
  applyRule: z.boolean().optional(),
});
export type TransactionUpdateRequest = z.infer<typeof transactionUpdateRequestSchema>;

/**
 * `POST /v1/transactions/:id/link-cancellation` — manually link a cancellation
 * transaction to its corresponding approval transaction.
 */
export const linkCancellationRequestSchema = z.object({
  approvalTransactionId: z.string().uuid(),
});
export type LinkCancellationRequest = z.infer<typeof linkCancellationRequestSchema>;

// --- Responses ---

/**
 * Transaction projection for `GET /v1/transactions` / `GET /v1/transactions/:id`.
 * Amounts are KRW integers; `netAmount = amount - cancelledAmount` for approvals
 * and `0` for cancellations. `masked: true` marks another member's
 * `summary_only` row whose merchant/memo fields are redacted (PRD §8, §26).
 */
export const transactionSummarySchema = z.object({
  id: z.string(),
  householdId: z.string(),
  memberId: z.string(),
  cardId: z.string().nullable(),
  transactionType: transactionTypeSchema,
  status: transactionStatusSchema,
  amount: z.number().int(),
  cancelledAmount: z.number().int(),
  netAmount: z.number().int(),
  currency: z.string(),
  merchantRaw: z.string().nullable(),
  merchantNormalized: z.string().nullable(),
  categoryId: z.string().nullable(),
  categorySlug: z.string().nullable(),
  approvedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  installmentMonths: z.number().int().nullable(),
  parentTransactionId: z.string().nullable(),
  visibility: cardVisibilitySchema,
  memo: z.string().nullable(),
  masked: z.boolean(),
  createdAt: z.string(),
});
export type TransactionSummary = z.infer<typeof transactionSummarySchema>;

/** Cursor-paginated transaction list. `nextCursor` is null on the final page. */
export const transactionListResponseSchema = z.object({
  items: z.array(transactionSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>;

/**
 * `GET /v1/transactions/summary` — verification-grade monthly rollup.
 * `totalNet` sums `netAmount` over approval transactions (cancellations reflected).
 */
export const transactionSummaryResponseSchema = z.object({
  period: z.object({
    from: z.string(),
    to: z.string(),
    timezone: z.string(),
  }),
  totalNet: z.number().int(),
  totalApproved: z.number().int(),
  totalCancelled: z.number().int(),
  includedMembers: z.array(z.string()),
  count: z.number().int(),
});
export type TransactionSummaryResponse = z.infer<typeof transactionSummaryResponseSchema>;
