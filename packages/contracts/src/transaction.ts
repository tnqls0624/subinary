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
 * Amounts are integer **minor units of `currency`** (`major = amount /
 * 10^exponent(currency)`; KRW/JPY exponent 0, USD/EUR exponent 2). Clients format
 * per `currency`. `netAmount = amount - cancelledAmount` for approvals and `0`
 * for cancellations. `masked: true` marks another member's `summary_only` row
 * whose merchant/memo fields are redacted (PRD §8, §26).
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
  // 외화 원거래(환산 전). 외화 거래는 승격 시 승인 시점 환율로 KRW 환산(amount/currency
  // 는 KRW)하고, 원통화 원본을 여기 보존한다. KRW 거래는 전부 null. originalAmount는
  // originalCurrency의 minor units, exchangeRate는 원통화 1단위당 KRW(추정치).
  originalAmount: z.number().int().nullable(),
  originalCurrency: z.string().nullable(),
  exchangeRate: z.number().nullable(),
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
  // 합계/예산에서 제외된 시각(사용자가 '중복이라 제외' 확정). null이면 집계 포함.
  excludedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TransactionSummary = z.infer<typeof transactionSummarySchema>;

/** Cursor-paginated transaction list. `nextCursor` is null on the final page. */
export const transactionListResponseSchema = z.object({
  items: z.array(transactionSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>;

/** 가맹점 라벨 검토 큐의 현재 상태. AI 제안은 사람 확정 전까지 별도 상태다. */
export const merchantLabelCandidateSourceSchema = z.enum([
  'unlabeled',
  'model_prediction',
]);
export type MerchantLabelCandidateSource = z.infer<
  typeof merchantLabelCandidateSourceSchema
>;

/**
 * `GET /v1/transactions/merchant-label-candidates`의 가맹점별 검토 항목.
 * 호출자가 열람·수정할 수 있는 거래만 집계하며 금액과 원문 문자는 노출하지 않는다.
 */
export const merchantLabelCandidateSchema = z.object({
  representativeTransactionId: z.string().uuid(),
  merchantNormalized: z.string().min(1).max(200),
  transactionCount: z.number().int().positive(),
  latestTransactionAt: z.string().datetime(),
  source: merchantLabelCandidateSourceSchema,
  suggestedCategoryId: z.string().uuid().nullable(),
  suggestedCategorySlug: z.string().nullable(),
});
export type MerchantLabelCandidate = z.infer<
  typeof merchantLabelCandidateSchema
>;

/** 사람 확정 라벨 수집 단계의 진입 게이트 현황. */
export const merchantLabelTrainingReadinessSchema = z.object({
  humanConfirmedLabels: z.number().int().nonnegative(),
  requiredLabels: z.number().int().positive(),
  distinctClasses: z.number().int().nonnegative(),
  requiredClasses: z.number().int().positive(),
  minimumClassLabels: z.number().int().nonnegative(),
  requiredLabelsPerClass: z.number().int().positive(),
  missingLineage: z.number().int().nonnegative(),
  status: z.enum(['ready', 'collect_labels']),
});
export type MerchantLabelTrainingReadiness = z.infer<
  typeof merchantLabelTrainingReadinessSchema
>;

/** Cursor 없이 작은 검토 batch를 반환하며 `hasMore`로 다음 batch 존재 여부를 알린다. */
export const merchantLabelCandidateListResponseSchema = z.object({
  items: z.array(merchantLabelCandidateSchema),
  hasMore: z.boolean(),
  trainingReadiness: merchantLabelTrainingReadinessSchema,
});
export type MerchantLabelCandidateListResponse = z.infer<
  typeof merchantLabelCandidateListResponseSchema
>;

/**
 * `GET /v1/transactions/summary` — verification-grade monthly rollup.
 * `totalNet` sums `netAmount` over approval transactions (cancellations reflected).
 * KRW-only aggregate: foreign-currency transactions are excluded so the minor-unit
 * integers stay comparable. `currency` marks the aggregate currency (always `KRW`).
 */
export const transactionSummaryResponseSchema = z.object({
  period: z.object({
    from: z.string(),
    to: z.string(),
    timezone: z.string(),
  }),
  currency: z.string(),
  totalNet: z.number().int(),
  totalApproved: z.number().int(),
  totalCancelled: z.number().int(),
  includedMembers: z.array(z.string()),
  count: z.number().int(),
});
export type TransactionSummaryResponse = z.infer<typeof transactionSummaryResponseSchema>;
