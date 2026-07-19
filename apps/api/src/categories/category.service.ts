/**
 * Category service (Phase 4 Build Spec §5.2, extended).
 *
 * Read: the catalogue is the union of system categories (`householdId = null`)
 * and a household's own custom categories. Write (custom only): any active
 * household member may create/rename/delete a household category; system
 * categories are immutable. Deleting a custom category reverts its transactions
 * to unclassified and removes dependent merchant rules / category budgets.
 */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, or } from 'drizzle-orm';

import type {
  CategoryCreateRequest,
  CategorySummary,
  CategoryUpdateRequest,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';

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
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtimePublisher: RealtimePublisherService,
  ) {}

  /**
   * Lists system categories plus the given household's custom categories.
   * System first, then custom, each ordered by slug for stability.
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
      .orderBy(
        asc(schema.expenseCategories.isSystem),
        asc(schema.expenseCategories.slug),
      );

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

  /**
   * Creates a household custom category (name only). Slug is an opaque,
   * per-household identifier; `isSystem` is always false. Any active member may
   * create. Duplicate names (incl. system) within the household are rejected.
   */
  async createCategory(
    userId: string,
    input: CategoryCreateRequest,
  ): Promise<CategorySummary> {
    await this.requireMembership(input.householdId, userId);
    const name = input.name.trim();
    await this.assertNameAvailable(input.householdId, name);

    const [row] = await this.db
      .insert(schema.expenseCategories)
      .values({
        householdId: input.householdId,
        slug: `custom-${randomUUID().slice(0, 8)}`,
        name,
        isSystem: false,
      })
      .returning();
    return toCategorySummary(row);
  }

  /** Renames a household custom category. System categories are immutable. */
  async updateCategory(
    userId: string,
    id: string,
    input: CategoryUpdateRequest,
  ): Promise<CategorySummary> {
    const cat = await this.getCustomOrThrow(id);
    const householdId = cat.householdId as string;
    await this.requireMembership(householdId, userId);
    const name = input.name.trim();
    await this.assertNameAvailable(householdId, name, id);

    const [row] = await this.db
      .update(schema.expenseCategories)
      .set({ name })
      .where(eq(schema.expenseCategories.id, id))
      .returning();
    // 이름 변경이 가족의 거래/분석 라벨에 반영되도록 힌트 발행(best-effort).
    void this.realtimePublisher.publish(householdId, 'categories.changed');
    return toCategorySummary(row);
  }

  /**
   * Deletes a household custom category. Transactions using it revert to
   * unclassified (categoryId = null); dependent merchant rules and
   * category-scoped budgets are removed. System categories cannot be deleted.
   */
  async deleteCategory(userId: string, id: string): Promise<void> {
    const cat = await this.getCustomOrThrow(id);
    const householdId = cat.householdId as string;
    await this.requireMembership(householdId, userId);

    await this.db.transaction(async (tx) => {
      // 이 카테고리를 쓰던 거래는 '미분류'로 되돌린다.
      await tx
        .update(schema.cardTransactions)
        .set({ categoryId: null })
        .where(eq(schema.cardTransactions.categoryId, id));
      // 이 카테고리를 가리키는 가맹점 자동분류 규칙 제거.
      await tx
        .delete(schema.merchantCategoryRules)
        .where(eq(schema.merchantCategoryRules.categoryId, id));
      // 이 카테고리에 묶인 카테고리-스코프 예산 제거(고아 방지).
      await tx
        .delete(schema.budgets)
        .where(
          and(
            eq(schema.budgets.scopeType, 'category'),
            eq(schema.budgets.scopeRefId, id),
          ),
        );
      await tx
        .delete(schema.expenseCategories)
        .where(eq(schema.expenseCategories.id, id));
    });
    // 거래가 미분류로 되돌아가고 예산/규칙이 정리되므로 가족 화면에 힌트 발행.
    void this.realtimePublisher.publish(householdId, 'categories.changed');
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId` (403 otherwise,
   * without disclosing whether the household exists — PRD §26).
   */
  private async requireMembership(
    householdId: string,
    userId: string,
  ): Promise<void> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);
    if (!member) throw new ForbiddenException('not a household member');
  }

  /** Loads a category by id, ensuring it is an editable household custom one. */
  private async getCustomOrThrow(id: string): Promise<schema.ExpenseCategory> {
    const [cat] = await this.db
      .select()
      .from(schema.expenseCategories)
      .where(eq(schema.expenseCategories.id, id))
      .limit(1);
    if (!cat) throw new NotFoundException('category not found');
    if (cat.isSystem || cat.householdId == null) {
      throw new ForbiddenException('시스템 카테고리는 수정/삭제할 수 없어요');
    }
    return cat;
  }

  /** Rejects a name already used by a system or this household's category. */
  private async assertNameAvailable(
    householdId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const norm = (s: string) => s.trim().toLowerCase();
    const existing = await this.listCategories(householdId);
    const clash = existing.some(
      (c) => c.id !== excludeId && norm(c.name) === norm(name),
    );
    if (clash) throw new ConflictException('이미 있는 카테고리 이름이에요');
  }
}
