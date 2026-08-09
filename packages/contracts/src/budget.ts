import { z } from 'zod';

/** Budget scope (PRD §7.2; mirrors DB `budgetScopeType`). */
export const budgetScopeTypeSchema = z.enum([
  'household',
  'member',
  'category',
  'card',
]);
export type BudgetScopeType = z.infer<typeof budgetScopeTypeSchema>;

/** Budget recurrence (mirrors DB `budgetPeriod`). Only monthly budgets in Phase 5. */
const budgetPeriodSchema = z.enum(['monthly']);

/** 서울 기준 회계월 키. DB에는 이 달의 1일을 `date`로 저장한다. */
export const budgetMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format');
export type BudgetMonth = z.infer<typeof budgetMonthSchema>;

// --- Requests ---

/**
 * `POST /v1/budgets` — create a monthly budget under a household (Phase 5 §5.2).
 * `scopeRefId` targets the member/category/card the budget applies to and is
 * omitted for `household`-wide budgets. Only owners/admins may create (PRD §7.2).
 * `amount` is a positive KRW integer.
 */
export const budgetCreateRequestSchema = z.object({
  householdId: z.string().uuid(),
  name: z.string().max(100).optional(),
  scopeType: budgetScopeTypeSchema,
  scopeRefId: z.string().uuid().optional(),
  amount: z.number().int().positive(),
  /** 생략하면 서울 기준 현재월. 과거월 생성은 서버가 거부한다. */
  effectiveMonth: budgetMonthSchema.optional(),
});
export type BudgetCreateRequest = z.infer<typeof budgetCreateRequestSchema>;

/** `PATCH /v1/budgets/:id` — rename or re-limit a budget (owner/admin only). */
export const budgetUpdateRequestSchema = z.object({
  name: z.string().max(100).optional(),
  amount: z.number().int().positive().optional(),
});
export type BudgetUpdateRequest = z.infer<typeof budgetUpdateRequestSchema>;

/**
 * `POST /v1/budgets/copy` — 한 달의 계획을 바로 다음 달로 명시적으로 복사한다.
 * 같은 사용자 동작의 네트워크 재시도는 HTTP `Idempotency-Key` 헤더로 식별한다.
 */
export const budgetCopyRequestSchema = z.object({
  householdId: z.string().uuid(),
  sourceMonth: budgetMonthSchema,
  targetMonth: budgetMonthSchema,
});
export type BudgetCopyRequest = z.infer<typeof budgetCopyRequestSchema>;

/** 성공한 복사의 안정 응답. 같은 `Idempotency-Key` 재시도에도 같은 ID 집합을 돌려준다. */
export const budgetCopyResponseSchema = z.object({
  sourceMonth: budgetMonthSchema,
  targetMonth: budgetMonthSchema,
  copiedCount: z.number().int().nonnegative(),
  copiedBudgetIds: z.array(z.string().uuid()),
});
export type BudgetCopyResponse = z.infer<typeof budgetCopyResponseSchema>;

// --- Responses ---

/**
 * Budget projection with the selected month's usage (Phase 5 §1.4).
 * `spent` sums `netAmount` over approval transactions within the budget scope,
 * honoring the analytics visibility rules; `remaining = amount - spent` and
 * `usageRate = spent / amount`. `scopeLabel` is the display name for the scope
 * ('가족 전체' / member name / category name / card alias). Amounts are KRW integers.
 */
export const budgetSummarySchema = z.object({
  id: z.string(),
  householdId: z.string(),
  name: z.string().nullable(),
  scopeType: budgetScopeTypeSchema,
  scopeRefId: z.string().nullable(),
  scopeLabel: z.string(),
  effectiveMonth: budgetMonthSchema,
  amount: z.number().int(),
  spent: z.number().int(),
  /** 선택월을 포함한 최근 3개 회계월 실지출 평균. 저장값이 아닌 파생값이다. */
  threeMonthAverageSpent: z.number().int(),
  remaining: z.number().int(),
  usageRate: z.number(),
  period: budgetPeriodSchema,
  currency: z.string(),
});
export type BudgetSummary = z.infer<typeof budgetSummarySchema>;

/** `GET /v1/budgets` — budgets for a household with `month=YYYY-MM` usage. */
export const budgetListResponseSchema = z.object({
  items: z.array(budgetSummarySchema),
  month: budgetMonthSchema,
});
export type BudgetListResponse = z.infer<typeof budgetListResponseSchema>;
