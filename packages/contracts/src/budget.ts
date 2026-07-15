import { z } from 'zod';

/** Budget scope (PRD §7.2; mirrors DB `budgetScopeType`). */
export const budgetScopeTypeSchema = z.enum(['household', 'member', 'category', 'card']);
export type BudgetScopeType = z.infer<typeof budgetScopeTypeSchema>;

/** Budget recurrence (mirrors DB `budgetPeriod`). Only monthly budgets in Phase 5. */
const budgetPeriodSchema = z.enum(['monthly']);

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
});
export type BudgetCreateRequest = z.infer<typeof budgetCreateRequestSchema>;

/** `PATCH /v1/budgets/:id` — rename or re-limit a budget (owner/admin only). */
export const budgetUpdateRequestSchema = z.object({
  name: z.string().max(100).optional(),
  amount: z.number().int().positive().optional(),
});
export type BudgetUpdateRequest = z.infer<typeof budgetUpdateRequestSchema>;

// --- Responses ---

/**
 * Budget projection with the current month's usage (Phase 5 §1.4).
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
  amount: z.number().int(),
  spent: z.number().int(),
  remaining: z.number().int(),
  usageRate: z.number(),
  period: budgetPeriodSchema,
  currency: z.string(),
});
export type BudgetSummary = z.infer<typeof budgetSummarySchema>;

/** `GET /v1/budgets` — budgets for a household with `month=YYYY-MM` usage. */
export const budgetListResponseSchema = z.object({
  items: z.array(budgetSummarySchema),
  month: z.string(),
});
export type BudgetListResponse = z.infer<typeof budgetListResponseSchema>;
