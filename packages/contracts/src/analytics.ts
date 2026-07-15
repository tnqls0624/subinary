import { z } from 'zod';

/**
 * Aggregation window for analytics responses (PRD §3.3; Phase 5 §1.3).
 * Month boundaries are resolved in Asia/Seoul; `from`/`to` are ISO instants
 * describing the half-open interval `[from, to)`. Aggregation keys on `approvedAt`.
 */
export const analyticsPeriodSchema = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
});
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;

/**
 * Metadata attached to every analytics response (Phase 5 §1.2).
 * `cancellationApplied` is always `true` — nets already reflect cancellations.
 * `includedMemberIds` lists the members whose amounts were counted (self ∪
 * `household` ∪ `summary_only`); `excludedByPermission` counts other members'
 * `private` rows omitted from the aggregate.
 */
export const analyticsMetaSchema = z.object({
  period: analyticsPeriodSchema,
  cancellationApplied: z.literal(true),
  includedMemberIds: z.array(z.string()),
  excludedByPermission: z.number().int(),
});
export type AnalyticsMeta = z.infer<typeof analyticsMetaSchema>;

/**
 * `GET /v1/analytics/monthly` — net spend for the period plus the immediately
 * preceding equal-length window (PRD §16; Phase 5 §5.1). Amounts are KRW
 * integers; `totalNet` sums `netAmount` over approval transactions.
 * `deltaNet = totalNet - previousNet`; `deltaRate = deltaNet / previousNet`,
 * `null` when `previousNet` is 0.
 */
export const monthlyAnalyticsSchema = z.object({
  meta: analyticsMetaSchema,
  totalNet: z.number().int(),
  totalApproved: z.number().int(),
  totalCancelled: z.number().int(),
  transactionCount: z.number().int(),
  previousNet: z.number().int(),
  deltaNet: z.number().int(),
  deltaRate: z.number().nullable(),
});
export type MonthlyAnalytics = z.infer<typeof monthlyAnalyticsSchema>;

/**
 * `GET /v1/analytics/categories` — net spend grouped by expense category.
 * `ratio = net / totalNet`. Uncategorized rows carry null ids under the
 * '미분류' label (Phase 5 §5.1).
 */
export const categoryBreakdownSchema = z.object({
  meta: analyticsMetaSchema,
  items: z.array(
    z.object({
      categoryId: z.string().nullable(),
      categorySlug: z.string().nullable(),
      categoryName: z.string(),
      net: z.number().int(),
      ratio: z.number(),
      count: z.number().int(),
    }),
  ),
});
export type CategoryBreakdown = z.infer<typeof categoryBreakdownSchema>;

/**
 * `GET /v1/analytics/members` — net spend grouped by household member.
 * `ratio = net / totalNet` (Phase 5 §5.1).
 */
export const memberBreakdownSchema = z.object({
  meta: analyticsMetaSchema,
  items: z.array(
    z.object({
      memberId: z.string(),
      name: z.string(),
      net: z.number().int(),
      ratio: z.number(),
      count: z.number().int(),
    }),
  ),
});
export type MemberBreakdown = z.infer<typeof memberBreakdownSchema>;

/**
 * `GET /v1/analytics/cards` — net spend grouped by payment card.
 * Transactions with no linked card carry null ids under the '미연결' label
 * (Phase 5 §5.1).
 */
export const cardBreakdownSchema = z.object({
  meta: analyticsMetaSchema,
  items: z.array(
    z.object({
      cardId: z.string().nullable(),
      alias: z.string(),
      issuer: z.string().nullable(),
      net: z.number().int(),
      ratio: z.number(),
      count: z.number().int(),
    }),
  ),
});
export type CardBreakdown = z.infer<typeof cardBreakdownSchema>;

/**
 * `GET /v1/analytics/merchants` — net spend grouped by normalized merchant.
 * Another member's `summary_only` spend is grouped under '(비공개)'; rows with
 * no merchant use '미확인 가맹점' (Phase 5 §1.2, §5.1).
 */
export const merchantBreakdownSchema = z.object({
  meta: analyticsMetaSchema,
  items: z.array(
    z.object({
      merchant: z.string(),
      net: z.number().int(),
      ratio: z.number(),
      count: z.number().int(),
    }),
  ),
});
export type MerchantBreakdown = z.infer<typeof merchantBreakdownSchema>;
