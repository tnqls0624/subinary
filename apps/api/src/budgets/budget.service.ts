/**
 * Budget domain service (Phase 5 Build Spec §5.2, §1.4).
 *
 * Authorization is enforced *here* in the service layer against `userId`
 * (PRD §7.2/§26) — controllers never make trust decisions. Every path resolves
 * the caller's active household membership first (`requireMembership`), so a
 * non-member always receives a 403 and never learns whether the household or a
 * budget exists. Budget CRUD (create/update/delete) additionally requires an
 * `owner`/`admin` role; listing is open to any active member.
 *
 * Usage rate (spec §1.4): a budget's `spent` is the **current-month** net spend
 * of its scope — `sum(netAmount) WHERE transactionType='approval'` over the
 * `[monthStart, nextMonthStart)` window (Asia/Seoul, on `approvedAt`) — computed
 * entirely in SQL (never summed in JS). The visibility scope (spec §1.2) is
 * applied: the actor's own rows ∪ `household` ∪ `summary_only`; another member's
 * `private` rows are excluded. `usageRate = spent / amount`,
 * `remaining = amount - spent`.
 *
 * Amounts are KRW integers. Logs never carry amounts or PII.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type {
  BudgetCreateRequest,
  BudgetListResponse,
  BudgetSummary,
  BudgetUpdateRequest,
  HouseholdRole,
} from '@family/contracts';
import { isUniqueViolation, schema, type Db } from '@family/database';
import { assertKrwInteger } from '@family/shared';

import { DB } from '../database/database.constants';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Korea Standard Time is a fixed UTC+9 offset with no DST. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Roles permitted to mutate budgets (spec §1.4 / PRD §7.2). */
const PRIVILEGED_ROLES: readonly HouseholdRole[] = ['owner', 'admin'];

/** `month=YYYY-MM` (01–12). */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Coerces a driver-returned numeric aggregate (string | number) to an int. */
function toInt(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/* -------------------------------------------------------------------------- */
/* Query shapes                                                               */
/* -------------------------------------------------------------------------- */

/** Raw list query parameters (validated in the controller DTO). */
export interface BudgetListQuery {
  householdId?: string;
  month?: string;
}

/** Resolved month window (Asia/Seoul) plus the normalized `YYYY-MM` label. */
interface Period {
  from: Date;
  to: Date;
  month: string;
}

@Injectable()
export class BudgetService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ---------------------------------------------------------------------- */
  /* List                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists a household's budgets with each scope's current-month usage. Open to
   * any active member. `month` (optional) selects the accounting month
   * (defaults to the current Asia/Seoul month).
   */
  async list(userId: string, query: BudgetListQuery): Promise<BudgetListResponse> {
    const householdId = this.requireHouseholdId(query.householdId);
    const actor = await this.requireMembership(householdId, userId);
    const period = this.resolvePeriod(query.month);

    const budgets = await this.db
      .select()
      .from(schema.budgets)
      .where(eq(schema.budgets.householdId, householdId))
      .orderBy(asc(schema.budgets.createdAt), asc(schema.budgets.id));

    const labels = await this.buildScopeLabels(budgets);

    const items = await Promise.all(
      budgets.map(async (budget) => {
        const spent = await this.computeSpent(budget, actor.id, period);
        return this.toSummary(budget, spent, labels.get(budget.id) ?? '가족 전체');
      }),
    );

    return { items, month: period.month };
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates a budget (owner/admin only). Validates the scope reference belongs
   * to the household (`household` scope carries no ref). A duplicate scope
   * `(householdId, scopeType, scopeRefId)` yields a 409.
   */
  async create(userId: string, input: BudgetCreateRequest): Promise<BudgetSummary> {
    const actor = await this.requireMembership(
      input.householdId,
      userId,
      PRIVILEGED_ROLES,
    );

    assertKrwInteger(input.amount);
    const scopeRefId = await this.resolveScopeRef(
      input.householdId,
      input.scopeType,
      input.scopeRefId,
    );
    await this.assertNoDuplicate(input.householdId, input.scopeType, scopeRefId);

    let created: schema.Budget | undefined;
    try {
      [created] = await this.db
        .insert(schema.budgets)
        .values({
          householdId: input.householdId,
          name: input.name ?? null,
          scopeType: input.scopeType,
          scopeRefId,
          amount: input.amount,
          createdBy: userId,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('a budget for this scope already exists');
      }
      throw error;
    }
    if (!created) {
      throw new Error('failed to create budget');
    }

    return this.summarize(created, actor.id);
  }

  /**
   * Updates a budget's `name` / `amount` (owner/admin only). Scope is immutable
   * (delete and recreate to change scope). Returns the refreshed summary.
   */
  async update(
    userId: string,
    id: string,
    input: BudgetUpdateRequest,
  ): Promise<BudgetSummary> {
    const budget = await this.loadBudget(id);
    const actor = await this.requireMembership(
      budget.householdId,
      userId,
      PRIVILEGED_ROLES,
    );

    const updates: Partial<schema.NewBudget> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.amount !== undefined) {
      assertKrwInteger(input.amount);
      updates.amount = input.amount;
    }

    const [updated] = await this.db
      .update(schema.budgets)
      .set(updates)
      .where(eq(schema.budgets.id, id))
      .returning();
    if (!updated) {
      throw new NotFoundException('budget not found');
    }

    return this.summarize(updated, actor.id);
  }

  /** Deletes a budget (owner/admin only). */
  async delete(userId: string, id: string): Promise<void> {
    const budget = await this.loadBudget(id);
    await this.requireMembership(budget.householdId, userId, PRIVILEGED_ROLES);
    await this.db.delete(schema.budgets).where(eq(schema.budgets.id, id));
  }

  /* ---------------------------------------------------------------------- */
  /* Spend aggregation (SQL only)                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Current-month net spend of a budget's scope, computed in SQL. Sums
   * `netAmount` over `approval` rows whose `approvedAt` lies in `[from, to)`,
   * honouring the visibility scope (§1.2). Scope filters: `member` →
   * `memberId`, `category` → `categoryId`, `card` → `cardId`; `household` adds
   * no extra filter (household + summary_only rows, others' private excluded).
   */
  private async computeSpent(
    budget: schema.Budget,
    actorMemberId: string,
    period: Period,
  ): Promise<number> {
    const conditions: SQL[] = [
      eq(schema.cardTransactions.householdId, budget.householdId),
      eq(schema.cardTransactions.transactionType, 'approval'),
      gte(schema.cardTransactions.approvedAt, period.from),
      lt(schema.cardTransactions.approvedAt, period.to),
      this.visibilityScope(actorMemberId),
    ];

    switch (budget.scopeType) {
      case 'member':
        if (budget.scopeRefId) {
          conditions.push(eq(schema.cardTransactions.memberId, budget.scopeRefId));
        }
        break;
      case 'category':
        if (budget.scopeRefId) {
          conditions.push(
            eq(schema.cardTransactions.categoryId, budget.scopeRefId),
          );
        }
        break;
      case 'card':
        if (budget.scopeRefId) {
          conditions.push(eq(schema.cardTransactions.cardId, budget.scopeRefId));
        }
        break;
      case 'household':
      default:
        break;
    }

    const [agg] = await this.db
      .select({
        spent: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
      })
      .from(schema.cardTransactions)
      .where(and(...conditions));

    const spent = toInt(agg?.spent);
    assertKrwInteger(spent);
    return spent;
  }

  /**
   * The visibility WHERE fragment (§1.2): own rows ∪ `household`/`summary_only`.
   * Another member's `private` rows are excluded from aggregation.
   */
  private visibilityScope(actorMemberId: string): SQL {
    const scope = or(
      eq(schema.cardTransactions.memberId, actorMemberId),
      inArray(schema.cardTransactions.visibility, ['household', 'summary_only']),
    );
    // Both operands are defined, so `or` always yields a SQL fragment.
    return scope as SQL;
  }

  /* ---------------------------------------------------------------------- */
  /* Scope labels                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolves a display label per budget id: `household` → '가족 전체',
   * `member` → member name (join to users), `category` → category name,
   * `card` → card alias. Name lookups are batched (no N+1).
   */
  private async buildScopeLabels(
    budgets: schema.Budget[],
  ): Promise<Map<string, string>> {
    const memberIds = new Set<string>();
    const categoryIds = new Set<string>();
    const cardIds = new Set<string>();
    for (const budget of budgets) {
      if (!budget.scopeRefId) {
        continue;
      }
      if (budget.scopeType === 'member') {
        memberIds.add(budget.scopeRefId);
      } else if (budget.scopeType === 'category') {
        categoryIds.add(budget.scopeRefId);
      } else if (budget.scopeType === 'card') {
        cardIds.add(budget.scopeRefId);
      }
    }

    const memberNames = new Map<string, string>();
    if (memberIds.size > 0) {
      const rows = await this.db
        .select({
          id: schema.householdMembers.id,
          name: schema.users.name,
        })
        .from(schema.householdMembers)
        .innerJoin(
          schema.users,
          eq(schema.householdMembers.userId, schema.users.id),
        )
        .where(inArray(schema.householdMembers.id, [...memberIds]));
      for (const row of rows) {
        memberNames.set(row.id, row.name);
      }
    }

    const categoryNames = new Map<string, string>();
    if (categoryIds.size > 0) {
      const rows = await this.db
        .select({
          id: schema.expenseCategories.id,
          name: schema.expenseCategories.name,
        })
        .from(schema.expenseCategories)
        .where(inArray(schema.expenseCategories.id, [...categoryIds]));
      for (const row of rows) {
        categoryNames.set(row.id, row.name);
      }
    }

    const cardAliases = new Map<string, string>();
    if (cardIds.size > 0) {
      const rows = await this.db
        .select({
          id: schema.paymentCards.id,
          alias: schema.paymentCards.alias,
        })
        .from(schema.paymentCards)
        .where(inArray(schema.paymentCards.id, [...cardIds]));
      for (const row of rows) {
        cardAliases.set(row.id, row.alias);
      }
    }

    const labels = new Map<string, string>();
    for (const budget of budgets) {
      labels.set(
        budget.id,
        this.scopeLabelFor(budget, memberNames, categoryNames, cardAliases),
      );
    }
    return labels;
  }

  private scopeLabelFor(
    budget: schema.Budget,
    memberNames: Map<string, string>,
    categoryNames: Map<string, string>,
    cardAliases: Map<string, string>,
  ): string {
    switch (budget.scopeType) {
      case 'member':
        return (
          (budget.scopeRefId && memberNames.get(budget.scopeRefId)) ||
          '알 수 없는 구성원'
        );
      case 'category':
        return (
          (budget.scopeRefId && categoryNames.get(budget.scopeRefId)) ||
          '알 수 없는 카테고리'
        );
      case 'card':
        return (
          (budget.scopeRefId && cardAliases.get(budget.scopeRefId)) ||
          '알 수 없는 카드'
        );
      case 'household':
      default:
        return '가족 전체';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Authorization + validation                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId` and (optionally)
   * holds one of `roles`. Non-members get a 403 that does not disclose whether
   * the household exists (PRD §26).
   */
  private async requireMembership(
    householdId: string,
    userId: string,
    roles?: readonly HouseholdRole[],
  ): Promise<schema.HouseholdMember> {
    const [member] = await this.db
      .select()
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);

    if (!member) {
      throw new ForbiddenException('not a household member');
    }
    if (roles && !roles.includes(member.role)) {
      throw new ForbiddenException('insufficient role');
    }
    return member;
  }

  /**
   * Validates and normalizes a budget's scope reference. `household` scope
   * carries no ref (always null); the others require a ref that belongs to the
   * household.
   */
  private async resolveScopeRef(
    householdId: string,
    scopeType: schema.Budget['scopeType'],
    scopeRefId: string | undefined,
  ): Promise<string | null> {
    if (scopeType === 'household') {
      return null;
    }
    if (!scopeRefId) {
      throw new BadRequestException(`scopeRefId is required for ${scopeType} budgets`);
    }
    switch (scopeType) {
      case 'member':
        await this.assertMemberInHousehold(scopeRefId, householdId);
        break;
      case 'category':
        await this.assertCategoryUsable(scopeRefId, householdId);
        break;
      case 'card':
        await this.assertCardInHousehold(scopeRefId, householdId);
        break;
      default:
        break;
    }
    return scopeRefId;
  }

  /**
   * Pre-checks the `(householdId, scopeType, scopeRefId)` uniqueness before
   * insert — the DB unique constraint treats NULL `scopeRefId` (household scope)
   * as distinct, so it alone would not block a second household budget.
   */
  private async assertNoDuplicate(
    householdId: string,
    scopeType: schema.Budget['scopeType'],
    scopeRefId: string | null,
  ): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.budgets.id })
      .from(schema.budgets)
      .where(
        and(
          eq(schema.budgets.householdId, householdId),
          eq(schema.budgets.scopeType, scopeType),
          scopeRefId === null
            ? isNull(schema.budgets.scopeRefId)
            : eq(schema.budgets.scopeRefId, scopeRefId),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ConflictException('a budget for this scope already exists');
    }
  }

  /** Validates a target member belongs to the household. */
  private async assertMemberInHousehold(
    memberId: string,
    householdId: string,
  ): Promise<void> {
    const [member] = await this.db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.id, memberId),
          eq(schema.householdMembers.householdId, householdId),
        ),
      )
      .limit(1);
    if (!member) {
      throw new BadRequestException('member does not belong to this household');
    }
  }

  /** Validates a category exists and is a system default or the household's own. */
  private async assertCategoryUsable(
    categoryId: string,
    householdId: string,
  ): Promise<void> {
    const [category] = await this.db
      .select({
        id: schema.expenseCategories.id,
        householdId: schema.expenseCategories.householdId,
      })
      .from(schema.expenseCategories)
      .where(eq(schema.expenseCategories.id, categoryId))
      .limit(1);
    if (
      !category ||
      (category.householdId !== null && category.householdId !== householdId)
    ) {
      throw new BadRequestException('invalid category');
    }
  }

  /** Validates a card belongs to the household. */
  private async assertCardInHousehold(
    cardId: string,
    householdId: string,
  ): Promise<void> {
    const [card] = await this.db
      .select({ id: schema.paymentCards.id })
      .from(schema.paymentCards)
      .where(
        and(
          eq(schema.paymentCards.id, cardId),
          eq(schema.paymentCards.householdId, householdId),
        ),
      )
      .limit(1);
    if (!card) {
      throw new BadRequestException('card does not belong to this household');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Loaders + projection                                                    */
  /* ---------------------------------------------------------------------- */

  private async loadBudget(id: string): Promise<schema.Budget> {
    const [budget] = await this.db
      .select()
      .from(schema.budgets)
      .where(eq(schema.budgets.id, id))
      .limit(1);
    if (!budget) {
      throw new NotFoundException('budget not found');
    }
    return budget;
  }

  /** Projects a single budget with its current-month spend/label. */
  private async summarize(
    budget: schema.Budget,
    actorMemberId: string,
  ): Promise<BudgetSummary> {
    const period = this.resolvePeriod(undefined);
    const spent = await this.computeSpent(budget, actorMemberId, period);
    const labels = await this.buildScopeLabels([budget]);
    return this.toSummary(budget, spent, labels.get(budget.id) ?? '가족 전체');
  }

  private toSummary(
    budget: schema.Budget,
    spent: number,
    scopeLabel: string,
  ): BudgetSummary {
    const remaining = budget.amount - spent;
    const usageRate = budget.amount > 0 ? spent / budget.amount : 0;
    return {
      id: budget.id,
      householdId: budget.householdId,
      name: budget.name,
      scopeType: budget.scopeType,
      scopeRefId: budget.scopeRefId,
      scopeLabel,
      amount: budget.amount,
      spent,
      remaining,
      usageRate,
      period: budget.period,
      currency: budget.currency,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Input parsing                                                           */
  /* ---------------------------------------------------------------------- */

  private requireHouseholdId(householdId: string | undefined): string {
    if (!householdId) {
      throw new BadRequestException('householdId is required');
    }
    return householdId;
  }

  /**
   * Resolves the accounting month window in Asia/Seoul (fixed UTC+9, no DST).
   * `month=YYYY-MM` selects that month; otherwise the current Seoul month is
   * used. Returns `[from, to)` UTC instants for the `[monthStart, nextMonth)`
   * range plus the normalized `YYYY-MM` label.
   */
  private resolvePeriod(month: string | undefined): Period {
    let year: number;
    let monthIndex: number; // 0-based
    if (month === undefined || month === '') {
      const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
      year = seoulNow.getUTCFullYear();
      monthIndex = seoulNow.getUTCMonth();
    } else {
      if (!MONTH_PATTERN.test(month)) {
        throw new BadRequestException('month must be in YYYY-MM format');
      }
      year = Number(month.slice(0, 4));
      monthIndex = Number(month.slice(5, 7)) - 1;
    }
    // Seoul wall-clock month start converted back to a UTC instant.
    const from = new Date(Date.UTC(year, monthIndex, 1) - KST_OFFSET_MS);
    // `Date.UTC` normalizes December (monthIndex+1 === 12) into the next year.
    const to = new Date(Date.UTC(year, monthIndex + 1, 1) - KST_OFFSET_MS);
    const normalized = `${year.toString().padStart(4, '0')}-${(monthIndex + 1)
      .toString()
      .padStart(2, '0')}`;
    return { from, to, month: normalized };
  }
}
