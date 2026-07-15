/**
 * Category read service (Phase 4 Build Spec §5.2).
 *
 * Exposes the category catalogue as the union of system categories
 * (`householdId = null`) and a household's own custom categories (Phase 4 seeds
 * only system categories, so the household set is empty for now). Also provides
 * `resolveSlugToId` for mapping a keyword-rule slug to its system-category id
 * (the promotion worker keeps its own equivalent lookup, spec §5.2/§6).
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, or } from 'drizzle-orm';

import type { CategorySummary } from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';

/** Projects an expense-category row onto its public summary. */
function toCategorySummary(row: schema.ExpenseCategory): CategorySummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    isSystem: row.isSystem,
  };
}

@Injectable()
export class CategoryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Lists system categories plus the given household's custom categories.
   * Ordered by slug for a stable, deterministic response.
   */
  async listCategories(householdId: string): Promise<CategorySummary[]> {
    const rows = await this.db
      .select()
      .from(schema.expenseCategories)
      .where(
        or(
          isNull(schema.expenseCategories.householdId),
          eq(schema.expenseCategories.householdId, householdId),
        ),
      )
      .orderBy(asc(schema.expenseCategories.slug));

    return rows.map(toCategorySummary);
  }

  /**
   * Resolves a system-category `slug` to its id, or `null` when unknown.
   * Scoped to system categories (`householdId IS NULL`).
   */
  async resolveSlugToId(slug: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: schema.expenseCategories.id })
      .from(schema.expenseCategories)
      .where(
        and(
          eq(schema.expenseCategories.slug, slug),
          isNull(schema.expenseCategories.householdId),
        ),
      )
      .limit(1);

    return row?.id ?? null;
  }
}
