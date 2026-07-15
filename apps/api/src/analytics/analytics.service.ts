/**
 * Analytics domain service (Phase 5 Build Spec §5.1).
 *
 * Read-only spend analytics computed entirely in SQL (`sum`/`count`/`group by`
 * via drizzle) — never with LLM prompts or JS reduce loops (spec §1.1). Net
 * spend is `sum(netAmount) WHERE transactionType='approval'`: cancellations are
 * already folded into an approval's `netAmount`, and standalone cancellation
 * rows carry `netAmount = 0`, so summing over approvals never double-counts.
 *
 * Visibility scope (spec §1.2, PRD §8/§16/§26) is enforced here in the service
 * layer against the actor's household membership: amounts include the actor's
 * own rows ∪ `visibility='household'` ∪ `visibility='summary_only'` (another
 * member's amounts too); another member's `private` rows are excluded and
 * counted in `meta.excludedByPermission`. Only the `merchants` breakdown reveals
 * a merchant name, so another member's `summary_only` rows are grouped under the
 * `'(비공개)'` label there.
 *
 * Periods (spec §1.3) are resolved on the Asia/Seoul calendar. Korea observes a
 * fixed UTC+9 offset with no DST, so month boundaries are exact fixed-offset
 * arithmetic — no timezone library dependency is introduced (spec §7).
 *
 * All monetary outputs are KRW integers; logs never carry amounts or PII.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';

import type {
  CardBreakdown,
  CategoryBreakdown,
  MemberBreakdown,
  MerchantBreakdown,
  MonthlyAnalytics,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { assertKrwInteger, DEFAULT_TIMEZONE } from '@family/shared';

import { DB } from '../database/database.constants';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Fixed Asia/Seoul (KST) offset in milliseconds — UTC+9, no DST. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Top-N merchants returned by the merchants breakdown (spec §5.1). */
const TOP_MERCHANTS = 20;

/** Labels for null/redacted grouping keys (spec §5.1). */
const LABEL_UNCATEGORIZED = '미분류';
const LABEL_UNLINKED_CARD = '미연결';
const LABEL_UNKNOWN_MERCHANT = '미확인 가맹점';
const LABEL_REDACTED = '(비공개)';

/* -------------------------------------------------------------------------- */
/* Query shapes                                                               */
/* -------------------------------------------------------------------------- */

/** Raw period query parameters (`month=YYYY-MM` or `from`/`to` ISO datetimes). */
export interface PeriodQuery {
  month?: string;
  from?: string;
  to?: string;
}

/** A resolved analytics window plus the immediately preceding comparison window. */
interface ResolvedPeriod {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
  timezone: string;
}

/** The shared analytics meta block (identical across every breakdown). */
type AnalyticsMeta = MonthlyAnalytics['meta'];

@Injectable()
export class AnalyticsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ---------------------------------------------------------------------- */
  /* Public breakdowns                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Monthly rollup: net spend for the window plus the preceding equal-length
   * window, with the absolute delta and its rate (null when the previous window
   * had zero net spend). Sums are computed in SQL over approval rows within the
   * actor's visibility scope.
   */
  async monthly(
    userId: string,
    householdId: string | undefined,
    query: PeriodQuery,
  ): Promise<MonthlyAnalytics> {
    const hh = this.requireHouseholdId(householdId);
    const actorMemberId = await this.requireMembership(hh, userId);
    const period = this.resolvePeriod(query);

    const currentConds = this.periodApprovalConditions(
      hh,
      actorMemberId,
      period.from,
      period.to,
    );

    const [agg] = await this.db
      .select({
        totalNet: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
        totalApproved: sql<string>`coalesce(sum(${schema.cardTransactions.amount}), 0)`,
        totalCancelled: sql<string>`coalesce(sum(${schema.cardTransactions.cancelledAmount}), 0)`,
        transactionCount: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .where(and(...currentConds));

    const prevConds = this.periodApprovalConditions(
      hh,
      actorMemberId,
      period.previousFrom,
      period.previousTo,
    );
    const [prevAgg] = await this.db
      .select({
        previousNet: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
      })
      .from(schema.cardTransactions)
      .where(and(...prevConds));

    const totalNet = toInt(agg?.totalNet);
    const totalApproved = toInt(agg?.totalApproved);
    const totalCancelled = toInt(agg?.totalCancelled);
    const transactionCount = toInt(agg?.transactionCount);
    const previousNet = toInt(prevAgg?.previousNet);
    assertKrwInteger(totalNet);
    assertKrwInteger(totalApproved);
    assertKrwInteger(totalCancelled);
    assertKrwInteger(previousNet);

    const deltaNet = totalNet - previousNet;
    assertKrwInteger(deltaNet);
    const deltaRate = previousNet === 0 ? null : deltaNet / previousNet;

    const meta = await this.buildMeta(hh, actorMemberId, period);

    return {
      meta,
      totalNet,
      totalApproved,
      totalCancelled,
      transactionCount,
      previousNet,
      deltaNet,
      deltaRate,
    };
  }

  /**
   * Net spend grouped by expense category. `null` categories are surfaced under
   * the `'미분류'` label. `ratio` is each group's net over the period's total.
   */
  async categories(
    userId: string,
    householdId: string | undefined,
    query: PeriodQuery,
  ): Promise<CategoryBreakdown> {
    const hh = this.requireHouseholdId(householdId);
    const actorMemberId = await this.requireMembership(hh, userId);
    const period = this.resolvePeriod(query);
    const conds = this.periodApprovalConditions(
      hh,
      actorMemberId,
      period.from,
      period.to,
    );

    const netExpr = sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`;
    const rows = await this.db
      .select({
        categoryId: schema.cardTransactions.categoryId,
        categorySlug: schema.expenseCategories.slug,
        categoryName: schema.expenseCategories.name,
        net: netExpr,
        count: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.cardTransactions.categoryId, schema.expenseCategories.id),
      )
      .where(and(...conds))
      .groupBy(
        schema.cardTransactions.categoryId,
        schema.expenseCategories.slug,
        schema.expenseCategories.name,
      )
      .orderBy(desc(netExpr));

    const total = await this.sumNet(conds);
    const items = rows.map((r) => {
      const net = toInt(r.net);
      assertKrwInteger(net);
      return {
        categoryId: r.categoryId,
        categorySlug: r.categorySlug,
        categoryName: r.categoryName ?? LABEL_UNCATEGORIZED,
        net,
        ratio: ratio(net, total),
        count: toInt(r.count),
      };
    });

    const meta = await this.buildMeta(hh, actorMemberId, period);
    return { meta, items };
  }

  /**
   * Net spend grouped by household member (joined to the member's user name).
   */
  async members(
    userId: string,
    householdId: string | undefined,
    query: PeriodQuery,
  ): Promise<MemberBreakdown> {
    const hh = this.requireHouseholdId(householdId);
    const actorMemberId = await this.requireMembership(hh, userId);
    const period = this.resolvePeriod(query);
    const conds = this.periodApprovalConditions(
      hh,
      actorMemberId,
      period.from,
      period.to,
    );

    const netExpr = sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`;
    const rows = await this.db
      .select({
        memberId: schema.cardTransactions.memberId,
        name: schema.users.name,
        net: netExpr,
        count: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .innerJoin(
        schema.householdMembers,
        eq(schema.cardTransactions.memberId, schema.householdMembers.id),
      )
      .innerJoin(
        schema.users,
        eq(schema.householdMembers.userId, schema.users.id),
      )
      .where(and(...conds))
      .groupBy(schema.cardTransactions.memberId, schema.users.name)
      .orderBy(desc(netExpr));

    const total = await this.sumNet(conds);
    const items = rows.map((r) => {
      const net = toInt(r.net);
      assertKrwInteger(net);
      return {
        memberId: r.memberId,
        name: r.name,
        net,
        ratio: ratio(net, total),
        count: toInt(r.count),
      };
    });

    const meta = await this.buildMeta(hh, actorMemberId, period);
    return { meta, items };
  }

  /**
   * Net spend grouped by payment card. Transactions with no linked card are
   * surfaced under the `'미연결'` alias with a null issuer.
   */
  async cards(
    userId: string,
    householdId: string | undefined,
    query: PeriodQuery,
  ): Promise<CardBreakdown> {
    const hh = this.requireHouseholdId(householdId);
    const actorMemberId = await this.requireMembership(hh, userId);
    const period = this.resolvePeriod(query);
    const conds = this.periodApprovalConditions(
      hh,
      actorMemberId,
      period.from,
      period.to,
    );

    const netExpr = sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`;
    const rows = await this.db
      .select({
        cardId: schema.cardTransactions.cardId,
        alias: schema.paymentCards.alias,
        issuer: schema.paymentCards.issuer,
        net: netExpr,
        count: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.paymentCards,
        eq(schema.cardTransactions.cardId, schema.paymentCards.id),
      )
      .where(and(...conds))
      .groupBy(
        schema.cardTransactions.cardId,
        schema.paymentCards.alias,
        schema.paymentCards.issuer,
      )
      .orderBy(desc(netExpr));

    const total = await this.sumNet(conds);
    const items = rows.map((r) => {
      const net = toInt(r.net);
      assertKrwInteger(net);
      return {
        cardId: r.cardId,
        alias: r.alias ?? LABEL_UNLINKED_CARD,
        issuer: r.issuer,
        net,
        ratio: ratio(net, total),
        count: toInt(r.count),
      };
    });

    const meta = await this.buildMeta(hh, actorMemberId, period);
    return { meta, items };
  }

  /**
   * Net spend grouped by normalized merchant (top {@link TOP_MERCHANTS}).
   * Grouping key labels are computed in SQL so that another member's
   * `summary_only` rows collapse into `'(비공개)'` (permission masking) and
   * unresolved merchants collapse into `'미확인 가맹점'`.
   */
  async merchants(
    userId: string,
    householdId: string | undefined,
    query: PeriodQuery,
  ): Promise<MerchantBreakdown> {
    const hh = this.requireHouseholdId(householdId);
    const actorMemberId = await this.requireMembership(hh, userId);
    const period = this.resolvePeriod(query);
    const conds = this.periodApprovalConditions(
      hh,
      actorMemberId,
      period.from,
      period.to,
    );

    // Merchant label — masks another member's summary_only merchant name and
    // normalizes null merchants, all as a groupable SQL expression.
    const merchantLabel = sql<string>`case
      when ${schema.cardTransactions.memberId} <> ${actorMemberId}::uuid
        and ${schema.cardTransactions.visibility} = 'summary_only'
        then ${LABEL_REDACTED}
      when ${schema.cardTransactions.merchantNormalized} is null
        then ${LABEL_UNKNOWN_MERCHANT}
      else ${schema.cardTransactions.merchantNormalized}
    end`;
    const netExpr = sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`;

    // Group by ordinal position (`GROUP BY 1` = the first SELECT column, the
    // merchant CASE). Referencing the `merchant` alias fails (Postgres does not
    // resolve SELECT aliases in GROUP BY), and re-passing the `merchantLabel`
    // object gives it fresh parameter placeholders that no longer match the
    // SELECT copy — leaving member_id/visibility "ungrouped". The ordinal groups
    // by the whole CASE, so its inner columns are covered.
    const rows = await this.db
      .select({
        merchant: merchantLabel,
        net: netExpr,
        count: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .where(and(...conds))
      .groupBy(sql`1`)
      .orderBy(desc(netExpr))
      .limit(TOP_MERCHANTS);

    const total = await this.sumNet(conds);
    const items = rows.map((r) => {
      const net = toInt(r.net);
      assertKrwInteger(net);
      return {
        merchant: r.merchant,
        net,
        ratio: ratio(net, total),
        count: toInt(r.count),
      };
    });

    const meta = await this.buildMeta(hh, actorMemberId, period);
    return { meta, items };
  }

  /* ---------------------------------------------------------------------- */
  /* Shared aggregation helpers                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * WHERE fragments common to every breakdown: the household, approval rows
   * only, the actor's visibility scope, and the `[from, to)` window on
   * `approvedAt`.
   */
  private periodApprovalConditions(
    householdId: string,
    actorMemberId: string,
    from: Date,
    to: Date,
  ): SQL[] {
    return [
      eq(schema.cardTransactions.householdId, householdId),
      eq(schema.cardTransactions.transactionType, 'approval'),
      this.visibilityScope(actorMemberId),
      gte(schema.cardTransactions.approvedAt, from),
      lt(schema.cardTransactions.approvedAt, to),
    ];
  }

  /**
   * Visibility WHERE fragment (spec §1.2): the actor's own rows ∪
   * `household`/`summary_only`. Another member's `private` rows are excluded
   * (and counted separately as `excludedByPermission`).
   */
  private visibilityScope(actorMemberId: string): SQL {
    const scope = or(
      eq(schema.cardTransactions.memberId, actorMemberId),
      inArray(schema.cardTransactions.visibility, ['household', 'summary_only']),
    );
    // Both operands are defined, so `or` always yields a SQL fragment.
    return scope as SQL;
  }

  /** SQL sum of `netAmount` over the given conditions (the ratio denominator). */
  private async sumNet(conds: SQL[]): Promise<number> {
    const [agg] = await this.db
      .select({
        net: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
      })
      .from(schema.cardTransactions)
      .where(and(...conds));
    const total = toInt(agg?.net);
    assertKrwInteger(total);
    return total;
  }

  /**
   * Builds the response meta: the resolved period, `cancellationApplied: true`,
   * the distinct included member ids, and the count of another member's
   * `private` approval rows excluded by permission (all in SQL).
   */
  private async buildMeta(
    householdId: string,
    actorMemberId: string,
    period: ResolvedPeriod,
  ): Promise<AnalyticsMeta> {
    const includedConds = this.periodApprovalConditions(
      householdId,
      actorMemberId,
      period.from,
      period.to,
    );

    const memberRows = await this.db
      .selectDistinct({ memberId: schema.cardTransactions.memberId })
      .from(schema.cardTransactions)
      .where(and(...includedConds));

    const [excluded] = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          gte(schema.cardTransactions.approvedAt, period.from),
          lt(schema.cardTransactions.approvedAt, period.to),
          ne(schema.cardTransactions.memberId, actorMemberId),
          eq(schema.cardTransactions.visibility, 'private'),
        ),
      );

    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        timezone: period.timezone,
      },
      cancellationApplied: true,
      includedMemberIds: memberRows.map((r) => r.memberId),
      excludedByPermission: toInt(excluded?.count),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Authorization                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId` and returns the
   * actor's `memberId`. Non-members get a 403 that does not disclose whether the
   * household exists (PRD §26). Lightweight helper mirroring the transactions
   * service (spec §5.1 "requireMembership 경량헬퍼").
   */
  private async requireMembership(
    householdId: string,
    userId: string,
  ): Promise<string> {
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

    if (!member) {
      throw new ForbiddenException('not a household member');
    }
    return member.id;
  }

  /* ---------------------------------------------------------------------- */
  /* Period resolution (Asia/Seoul, fixed UTC+9)                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolves the query into an aggregation window plus the preceding comparison
   * window (spec §1.3). Either both `from`/`to` (ISO datetimes) are given — in
   * which case the previous window is an equal-length span ending at `from` — or
   * `month=YYYY-MM` (default: the current Asia/Seoul month) selects the calendar
   * month and its predecessor. Month boundaries use the fixed KST offset.
   */
  private resolvePeriod(query: PeriodQuery): ResolvedPeriod {
    const hasFrom = query.from !== undefined && query.from !== '';
    const hasTo = query.to !== undefined && query.to !== '';
    if (hasFrom !== hasTo) {
      throw new BadRequestException('from and to must be provided together');
    }

    if (hasFrom && hasTo) {
      const from = new Date(query.from as string);
      const to = new Date(query.to as string);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException('from and to must be ISO datetimes');
      }
      if (to.getTime() <= from.getTime()) {
        throw new BadRequestException('to must be after from');
      }
      const duration = to.getTime() - from.getTime();
      return {
        from,
        to,
        previousFrom: new Date(from.getTime() - duration),
        previousTo: from,
        timezone: DEFAULT_TIMEZONE,
      };
    }

    const { year, monthNumber } = this.parseMonth(query.month);
    return {
      from: this.seoulMonthStart(year, monthNumber),
      to: this.seoulMonthStart(year, monthNumber + 1),
      previousFrom: this.seoulMonthStart(year, monthNumber - 1),
      previousTo: this.seoulMonthStart(year, monthNumber),
      timezone: DEFAULT_TIMEZONE,
    };
  }

  /**
   * Parses `month=YYYY-MM`, defaulting to the current Asia/Seoul month. The
   * current month is derived by shifting `now` by the fixed KST offset and
   * reading the UTC calendar fields (the Seoul wall clock).
   */
  private parseMonth(month: string | undefined): {
    year: number;
    monthNumber: number;
  } {
    if (month === undefined || month === '') {
      const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
      return {
        year: seoulNow.getUTCFullYear(),
        monthNumber: seoulNow.getUTCMonth() + 1,
      };
    }
    const matched = /^(\d{4})-(\d{2})$/.exec(month);
    if (!matched) {
      throw new BadRequestException('month must be formatted as YYYY-MM');
    }
    const year = Number(matched[1]);
    const monthNumber = Number(matched[2]);
    if (monthNumber < 1 || monthNumber > 12) {
      throw new BadRequestException('month must be between 01 and 12');
    }
    return { year, monthNumber };
  }

  /**
   * The UTC instant of `YYYY-MM-01 00:00:00` at Asia/Seoul (fixed UTC+9, no
   * DST). `monthNumber` is 1-based; out-of-range values (0, 13) roll the year
   * over via `Date.UTC` month-index normalization.
   */
  private seoulMonthStart(year: number, monthNumber: number): Date {
    return new Date(Date.UTC(year, monthNumber - 1, 1) - KST_OFFSET_MS);
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
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Coerces a driver-returned numeric aggregate (string | number) to an int. */
function toInt(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** Ratio of a group's net over the period total (0 when the total is 0). */
function ratio(net: number, total: number): number {
  return total === 0 ? 0 : net / total;
}
