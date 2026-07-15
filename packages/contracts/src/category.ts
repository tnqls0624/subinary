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
