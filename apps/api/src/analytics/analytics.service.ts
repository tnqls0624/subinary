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
import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  AnalyticsExclusion,
  CardBreakdown,
  CategoryBreakdown,
  MemberBreakdown,
  MerchantBreakdown,
  MonthlyAnalytics,
  AnalyticsMonths,
} from '@family/contracts';
import {
  schema,
  type Db,
  notTransferCategory,
  redactedMerchantLabel,
  spendPeriodWindow,
  transferCategory,
  visibilityScope,
} from '@family/database';
import { assertKrwInteger, DEFAULT_TIMEZONE } from '@family/shared';

import { DB } from '../database/database.constants';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Fixed Asia/Seoul (KST) offset in milliseconds — UTC+9, no DST. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Top-N merchants returned by the merchants breakdown (spec §5.1). */
const TOP_MERCHANTS = 20;

/**
 * Labels for null grouping keys (spec §5.1). 가려진 가맹점 라벨은
 * `@family/database`의 `REDACTED_MERCHANT_LABEL`을 쓴다 — 가맹점 목록 API도 같은
 * 문자열로 그룹핑해야 하므로 여기에 사본을 두지 않는다.
 */
const LABEL_UNCATEGORIZED = '미분류';
const LABEL_UNLINKED_CARD = '미연결';
const LABEL_UNKNOWN_MERCHANT = '미확인 가맹점';

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
    /**
     * 공용으로 표시한 카드의 결제는 사람이 아니라 **'공용'** 으로 묶는다.
     *
     * 카드 문자에는 누가 그었는지가 없다. 거래의 `member_id`는 문자를 전달한 폰의
     * 주인이고, 한 카드의 문자는 한 대에만 오므로 공동사용 카드는 지출이 한 사람에게
     * 전부 몰린다(실측 76% vs 24%). 그 왜곡을 지분 분할로 덮지 않고 — 50/50은 실측이
     * 아니라 가정이다 — 귀속을 **보류한 상태 그대로** 보여준다.
     *
     * 거래 행은 건드리지 않는다. 이 CASE가 조인 시점에 판정하므로 사용자가 카드에
     * 공용 표시를 켜면 **과거 집계까지 함께** 바뀌고, 끄면 그대로 돌아온다.
     */
    const bucketId = sql<
      string | null
    >`case when ${schema.paymentCards.isShared} then null else ${schema.cardTransactions.memberId} end`;
    const bucketName = sql<string>`case when ${schema.paymentCards.isShared} then '공용' else ${schema.users.name} end`;
    const rows = await this.db
      .select({
        memberId: bucketId,
        name: bucketName,
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
      // 카드 미연결 거래도 남아야 하므로 left join이다. 미연결은 `isShared`가 NULL이고
      // `case when NULL then` 은 else 가지를 타므로 종전대로 구성원에 귀속된다.
      .leftJoin(
        schema.paymentCards,
        eq(schema.paymentCards.id, schema.cardTransactions.cardId),
      )
      .where(and(...conds))
      .groupBy(bucketId, bucketName)
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
    const merchantLabel = redactedMerchantLabel(
      actorMemberId,
      LABEL_UNKNOWN_MERCHANT,
    );
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

  /**
   * 거래가 있는 달의 목록(오름차순) — 월 스위처가 빈 달을 건너뛰는 데 쓴다.
   *
   * 기간 필터만 없는 {@link approvalConditions}를 그대로 쓰므로 여기의 `net`은
   * 그 달을 실제로 열었을 때 `monthly.totalNet`과 같은 값이다. 버킷 키는
   * `coalesce(approvedAt, createdAt)`을 Asia/Seoul로 변환한 `YYYY-MM`으로,
   * {@link spendPeriodWindow}가 승인시각 미파싱 거래를 createdAt으로 구제하는
   * 규칙과 일치한다(다른 규칙을 쓰면 스위처에는 보이는데 열면 0원인 달이 생긴다).
   */
  async months(
    userId: string,
    householdId: string | undefined,
  ): Promise<AnalyticsMonths> {
    const hh = this.requireHouseholdId(householdId);
    const actorMemberId = await this.requireMembership(hh, userId);
    const conds = this.approvalConditions(hh, actorMemberId);

    // 파라미터 보간이 없는 표현식이지만, groupBy에는 merchants와 동일하게 ordinal을
    // 쓴다(SELECT alias는 Postgres GROUP BY에서 해석되지 않고, 표현식 객체를 다시
    // 넘기면 placeholder가 어긋난다).
    const monthExpr = sql<string>`to_char(
      coalesce(${schema.cardTransactions.approvedAt}, ${schema.cardTransactions.createdAt})
        at time zone 'Asia/Seoul',
      'YYYY-MM'
    )`;

    const rows = await this.db
      .select({
        month: monthExpr,
        net: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .where(and(...conds))
      .groupBy(sql`1`)
      .orderBy(sql`1 asc`);

    return {
      timezone: DEFAULT_TIMEZONE,
      items: rows.map((r) => {
        const net = toInt(r.net);
        assertKrwInteger(net);
        return { month: r.month, net, count: toInt(r.count) };
      }),
    };
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
      ...this.approvalConditions(householdId, actorMemberId),
      // 기간 창은 @family/database의 공통 헬퍼(ADR-0026). 예산·요약·주간요약·이상지출도
      // 같은 함수를 쓰므로 "같은 달, 다른 총액"이 생기지 않는다.
      spendPeriodWindow(from, to),
    ];
  }

  /**
   * 기간을 **뺀** 지출 집계 조건. `months()`(전 기간을 달별로 버킷팅)와
   * {@link periodApprovalConditions}가 공유하므로, 스위처가 내려주는 달의 net이
   * 그 달을 실제로 열었을 때의 총액과 일치한다.
   */
  private approvalConditions(householdId: string, actorMemberId: string): SQL[] {
    return [
      eq(schema.cardTransactions.householdId, householdId),
      eq(schema.cardTransactions.transactionType, 'approval'),
      // 사용자가 '중복이라 제외' 확정한 거래는 모든 합계/브레이크다운에서 뺀다.
      isNull(schema.cardTransactions.excludedAt),
      // 자산 이동(현금 인출·선불 충전)은 소비가 아니라 잔액 이동이므로 지출에서 뺀다.
      // 이 초크포인트 하나로 monthly/categories/members/cards/merchants가 함께 정화된다.
      notTransferCategory(),
      // 모든 analytics 집계는 KRW 전용이다. amount는 minor units라 외화($22.00=2200)와
      // 원화(₩2,200=2200)가 정수로 구분되지 않으므로, 이 단일 초크포인트에서 통화를
      // 걸러 monthly/categories/members/cards/merchants/sumNet 전부를 정화한다.
      eq(schema.cardTransactions.currency, 'KRW'),
      // 공개범위도 @family/database의 공통 헬퍼다 — 집계 API마다 복사돼 있던 조건이
      // /v1/merchants에서 통째로 누락된 적이 있다(2026-08).
      visibilityScope(actorMemberId),
    ];
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
          // 이미 '중복 제외'된 행은 합계에 애초에 없으므로 '권한으로 제외된 건수'에서도
          // 빼야 이중 집계가 안 된다(다른 집계의 isNull(excludedAt)와 정렬).
          isNull(schema.cardTransactions.excludedAt),
          // 자산 이동도 합계에 없으므로 같은 이유로 이 카운트에서 뺀다.
          notTransferCategory(),
          spendPeriodWindow(period.from, period.to),
          ne(schema.cardTransactions.memberId, actorMemberId),
          eq(schema.cardTransactions.visibility, 'private'),
        ),
      );

    const [manual, transfer] = await Promise.all([
      // 사용자가 직접 뺀 행. `excludedAt`이 먼저이므로 자산 이동 여부는 보지 않는다.
      this.sumExclusion([
        ...this.exclusionBaseConditions(householdId, actorMemberId, period),
        isNotNull(schema.cardTransactions.excludedAt),
      ]),
      // 빼지 **않았는데** 자산 이동이라 지출이 아닌 행. 위 버킷과 겹치지 않게
      // `excludedAt IS NULL`을 함께 건다 — 겹치면 공시 합계가 총액을 넘는다.
      this.sumExclusion([
        ...this.exclusionBaseConditions(householdId, actorMemberId, period),
        isNull(schema.cardTransactions.excludedAt),
        transferCategory(),
      ]),
    ]);

    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        timezone: period.timezone,
      },
      cancellationApplied: true,
      includedMemberIds: memberRows.map((r) => r.memberId),
      excludedByPermission: toInt(excluded?.count),
      excludedManual: manual,
      excludedTransfer: transfer,
    };
  }

  /**
   * 제외 공시의 공통 모집단 — 집계와 **같은** 가구·유형·통화·공개범위·기간 조건.
   *
   * `approvalConditions()`를 재사용하지 않는 이유: 그쪽은 `excludedAt IS NULL`과
   * `notTransferCategory()`를 이미 박아 두었고, 공시는 정확히 그 두 조건에 **걸린**
   * 행을 세는 것이다. 대신 나머지 조건(특히 `visibilityScope`와 `currency='KRW'`)은
   * 반드시 같아야 한다 — 공개범위를 빼면 공시가 타인의 `private` 금액을 알려주는
   * 우회로가 되고, 통화를 빼면 외화 minor units가 원화에 섞여 합계가 무의미해진다.
   */
  private exclusionBaseConditions(
    householdId: string,
    actorMemberId: string,
    period: ResolvedPeriod,
  ): SQL[] {
    return [
      eq(schema.cardTransactions.householdId, householdId),
      eq(schema.cardTransactions.transactionType, 'approval'),
      eq(schema.cardTransactions.currency, 'KRW'),
      visibilityScope(actorMemberId),
      spendPeriodWindow(period.from, period.to),
    ];
  }

  /** 제외 한 덩어리의 건수와 순액 합. */
  private async sumExclusion(conds: SQL[]): Promise<AnalyticsExclusion> {
    const [agg] = await this.db
      .select({
        count: sql<string>`count(*)`,
        net: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
      })
      .from(schema.cardTransactions)
      .where(and(...conds));
    const net = toInt(agg?.net);
    assertKrwInteger(net);
    return { count: toInt(agg?.count), net };
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
