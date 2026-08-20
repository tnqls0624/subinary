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
 * preceding equal-length window (PRD §16; Phase 5 §5.1). All analytics
 * aggregates are **KRW-only** (foreign-currency rows are excluded server-side so
 * the minor-unit integers stay comparable); values are KRW won (KRW exponent 0,
 * so minor == major). `totalNet` sums `netAmount` over approval transactions.
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
      /**
       * 구성원 id. **`null`이면 '공용'** 버킷이다 — 공용으로 표시한 카드의 결제는
       * 사람에게 귀속시키지 않는다. 카드 문자에 누가 썼는지가 없으므로 소유자에게
       * 전부 몰아주는 것보다 "공용"이 사실에 가깝다(금액은 쪼개지 않는다).
       */
      memberId: z.string().nullable(),
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

/**
 * `GET /v1/analytics/months` — 거래가 **있는** 달의 목록(오름차순, Asia/Seoul 기준).
 *
 * 왜 별도 엔드포인트인가: 홈·예산의 월 스위처가 임의의 달로 이동하면 데이터가 없는
 * 달에서 빈 화면과 `-100%` 델타를 보여준다. 실측(2026-08) 데이터는 2026-03과
 * 2026-07 사이가 비어 있어 화살표를 4번 눌러야 다음 데이터에 닿았다. 클라이언트가
 * 이 목록으로 **건너뛴다**(ADR-0026).
 *
 * `net`은 다른 analytics 집계와 동일한 정의(approval · 제외 아님 · 자산이동 아님 ·
 * KRW · 공개범위 필터)의 순지출이므로, 스위처 라벨에 그대로 쓸 수 있다.
 */
export const analyticsMonthsSchema = z.object({
  timezone: z.string(),
  items: z.array(
    z.object({
      /** `YYYY-MM` (Asia/Seoul). */
      month: z.string(),
      net: z.number().int(),
      count: z.number().int(),
    }),
  ),
});
export type AnalyticsMonths = z.infer<typeof analyticsMonthsSchema>;
