import { z } from 'zod';

/**
 * Expense-category projection for `GET /v1/categories` (PRD §15; PRD §31 Phase 4).
 * System categories carry `isSystem: true` and are shared across households.
 */
export const categorySummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
});
export type CategorySummary = z.infer<typeof categorySummarySchema>;

/**
 * `POST /v1/categories` — create a household custom category (name only).
 * The server derives an opaque per-household slug; `isSystem` is always false.
 * Duplicate names within the household (incl. system categories) are rejected.
 */
export const categoryCreateRequestSchema = z.object({
  householdId: z.string().uuid(),
  name: z.string().trim().min(1).max(20),
});
export type CategoryCreateRequest = z.infer<typeof categoryCreateRequestSchema>;

/** `PATCH /v1/categories/:id` — rename a household custom category. */
export const categoryUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(20),
});
export type CategoryUpdateRequest = z.infer<typeof categoryUpdateRequestSchema>;
