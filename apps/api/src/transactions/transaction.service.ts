/**
 * Transaction domain service (Phase 4 Build Spec §5.3).
 *
 * Read/write side of the normalized card-transaction model. Authorization and
 * visibility scope are enforced *here* in the service layer against the actor's
 * household membership (`userId` → active `memberId`, PRD §8/§26) — controllers
 * never make trust decisions.
 *
 * Visibility rules (spec §1.4): a listing returns the actor's own transactions
 * ∪ `visibility='household'`; another member's `private` rows are excluded, and
 * another member's `summary_only` rows are included with the merchant/memo
 * masked (`masked: true`). Amounts always count toward summaries.
 *
 * Money invariants (spec §1.2): amounts are KRW integers. For an `approval`
 * row `netAmount = amount - cancelledAmount`; a `cancellation` row keeps
 * `netAmount = 0` and links to its approval via `parentTransactionId`.
 *
 * Logs never carry amounts, merchant names, memos, or other PII.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type {
  HouseholdRole,
  LinkCancellationRequest,
  MerchantLabelCandidateListResponse,
  MerchantLabelTrainingReadiness,
  TransactionListResponse,
  TransactionSummary,
  TransactionSummaryResponse,
  TransactionUpdateRequest,
} from '@family/contracts';
import {
  revokeMerchantRuleLineage,
  schema,
  type Db,
  notTransferCategory,
  spendPeriodWindow,
  visibilityScope,
} from '@family/database';
import {
  assertKrwInteger,
  createMerchantCategoryTargetId,
  DEFAULT_TIMEZONE,
  MERCHANT_TRAINING_READINESS,
} from '@family/shared';

import { DB } from '../database/database.constants';
import { moneyRejectionToHttp } from '../money/money-rejection';
import { MoneyShadowService } from '../money/money-shadow.service';
import { MoneyWriteService } from '../money/money-write.service';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';
import {
  actorCanSeeApproval,
  cancellationCandidateFilter,
  cancellationCandidateOrder,
} from './cancellation-candidates';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Pagination bounds (default 50, max 100 — mirrors card-sms query). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Transaction kinds (mirrors DB `txnType`). */
const TXN_TYPES = ['approval', 'cancellation'] as const;
type TxnType = (typeof TXN_TYPES)[number];

/** Transaction statuses (mirrors DB `txnStatus`). */
const TXN_STATUSES = [
  'approved',
  'partially_cancelled',
  'cancelled',
  'pending_review',
  'duplicate_suspected',
] as const;
type TxnStatus = (typeof TXN_STATUSES)[number];

/** Card/transaction visibility (mirrors DB `cardVisibility`). */
type Visibility = 'private' | 'household' | 'summary_only';

/** Roles allowed to mutate any household member's transaction. */
const PRIVILEGED_ROLES: readonly HouseholdRole[] = ['owner', 'admin'];

/**
 * 검색어 최대 길이. 초과분은 잘라낸다(거절이 아니라 절삭 — 사용자가 붙여넣기로 긴
 * 문자열을 넣어도 화면이 400으로 깨지지 않게 한다). 가맹점명이 200자를 넘지 않는다.
 */
const SEARCH_MAX_LENGTH = 100;

/* -------------------------------------------------------------------------- */
/* Query shapes                                                               */
/* -------------------------------------------------------------------------- */

/** Raw list query parameters (all strings — parsed/validated in the service). */
export interface TransactionListQuery {
  householdId?: string;
  memberId?: string;
  cardId?: string;
  type?: string;
  status?: string;
  categoryId?: string;
  from?: string;
  to?: string;
  minAmount?: string;
  maxAmount?: string;
  /** 가맹점·메모 부분 일치 검색어. 공백만이면 무시한다. */
  q?: string;
  limit?: string;
  cursor?: string;
}

/** Raw summary query parameters. */
export interface TransactionSummaryQuery {
  householdId?: string;
  from?: string;
  to?: string;
}

/** Decoded keyset cursor: order by `(createdAt desc, id desc)`. */
interface Cursor {
  createdAt: Date;
  id: string;
}

/** Actor membership resolved for a household. */
interface ActorMembership {
  memberId: string;
  role: HouseholdRole;
}

@Injectable()
export class TransactionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtimePublisher: RealtimePublisherService,
    // ADR-0027 3단계: 금액 수정·취소 연결 결과를 새 계약과 대조해 기록만 한다.
    // 이 서비스는 취소 산술의 두 번째 사본이다(worker 승격이 첫 번째) — 두 사본이
    // 같은 답을 내는지가 전환 전에 확인해야 할 값이다.
    private readonly moneyShadow: MoneyShadowService,
    // ADR-0027 5단계: enforce가 켜지면 금액 수정·취소 연결을 이쪽이 소유한다.
    private readonly moneyWrite: MoneyWriteService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* List / read                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists transactions for a household the actor belongs to, applying the
   * visibility scope (§1.4) and the optional filters (PRD §17.4). Newest first,
   * keyset-paginated. Another member's `summary_only` rows are masked.
   */
  async list(
    userId: string,
    query: TransactionListQuery,
  ): Promise<TransactionListResponse> {
    const householdId = this.requireHouseholdId(query.householdId);
    const actor = await this.requireMembership(householdId, userId);

    const take = this.parseLimit(query.limit);
    const keyset = this.decodeCursor(query.cursor);

    const conditions: SQL[] = [
      eq(schema.cardTransactions.householdId, householdId),
      visibilityScope(actor.memberId),
    ];

    if (query.memberId) {
      conditions.push(eq(schema.cardTransactions.memberId, query.memberId));
    }
    if (query.cardId) {
      conditions.push(eq(schema.cardTransactions.cardId, query.cardId));
    }
    if (query.type !== undefined) {
      conditions.push(
        eq(schema.cardTransactions.transactionType, this.parseType(query.type)),
      );
    }
    if (query.status !== undefined) {
      conditions.push(
        eq(schema.cardTransactions.status, this.parseStatus(query.status)),
      );
    }
    if (query.categoryId) {
      conditions.push(eq(schema.cardTransactions.categoryId, query.categoryId));
    }
    // 기간 필터는 승인시각(approvedAt) 기준이되, 미파싱으로 NULL인 거래는 SQL
    // 3치 논리상 `NULL >= from`이 항상 false라 어떤 달을 골라도 목록에서 빠진다.
    // createdAt(문자 수신 시각)으로 폴백해 누락을 막는다(정렬 축과도 일치).
    // COALESCE를 SQL 표현식으로 만들면 드라이버가 컬럼 타입을 몰라 Date 바인딩이
    // 깨지므로, 컬럼 기반 OR(approvedAt 우선, NULL이면 createdAt)로 표현한다.
    const from = this.parseDate(query.from, 'from');
    if (from) {
      conditions.push(
        or(
          gte(schema.cardTransactions.approvedAt, from),
          and(
            isNull(schema.cardTransactions.approvedAt),
            gte(schema.cardTransactions.createdAt, from),
          ),
        ) as SQL,
      );
    }
    const to = this.parseDate(query.to, 'to');
    if (to) {
      conditions.push(
        or(
          lt(schema.cardTransactions.approvedAt, to),
          and(
            isNull(schema.cardTransactions.approvedAt),
            lt(schema.cardTransactions.createdAt, to),
          ),
        ) as SQL,
      );
    }
    // 금액 필터는 원(KRW) 기준값이고 amount는 minor units라, 외화(다른 스케일)와
    // 교차 비교하면 틀린다($22.00=2200이 2,000~3,000원 필터에 오매칭). 금액 필터가
    // 걸리면 KRW 거래로 스코프를 제한한다.
    const minAmount = this.parseAmount(query.minAmount, 'minAmount');
    const maxAmount = this.parseAmount(query.maxAmount, 'maxAmount');
    if (minAmount !== undefined || maxAmount !== undefined) {
      conditions.push(eq(schema.cardTransactions.currency, 'KRW'));
    }
    if (minAmount !== undefined) {
      conditions.push(gte(schema.cardTransactions.amount, minAmount));
    }
    if (maxAmount !== undefined) {
      conditions.push(lte(schema.cardTransactions.amount, maxAmount));
    }
    const search = this.parseSearch(query.q);
    if (search) {
      conditions.push(this.searchScope(search, actor.memberId));
    }
    if (keyset) {
      const after = or(
        lt(schema.cardTransactions.createdAt, keyset.createdAt),
        and(
          eq(schema.cardTransactions.createdAt, keyset.createdAt),
          lt(schema.cardTransactions.id, keyset.id),
        ),
      );
      if (after) {
        conditions.push(after);
      }
    }

    const rows = await this.db
      .select({
        txn: schema.cardTransactions,
        categorySlug: schema.expenseCategories.slug,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.cardTransactions.categoryId, schema.expenseCategories.id),
      )
      .where(and(...conditions))
      .orderBy(
        desc(schema.cardTransactions.createdAt),
        desc(schema.cardTransactions.id),
      )
      .limit(take + 1);

    let nextCursor: string | null = null;
    let page = rows;
    if (rows.length > take) {
      page = rows.slice(0, take);
      const last = page[page.length - 1];
      if (last) {
        nextCursor = this.encodeCursor(last.txn);
      }
    }

    const items = page.map((r) =>
      buildSummary(r.txn, r.categorySlug, maskedFor(r.txn, actor.memberId)),
    );
    return { items, nextCursor };
  }

  /**
   * Returns a single transaction scoped to the actor's household membership.
   * Another member's `private` row is reported as not-found (no disclosure);
   * another member's `summary_only` row is returned masked.
   */
  async get(userId: string, id: string): Promise<TransactionSummary> {
    const row = await this.loadSummaryRow(id);
    const actor = await this.requireMembership(row.txn.householdId, userId);

    if (
      row.txn.memberId !== actor.memberId &&
      row.txn.visibility === 'private'
    ) {
      throw new NotFoundException('transaction not found');
    }

    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /**
   * Verification-oriented month summary (spec §5.3). Sums `netAmount` over
   * `approval` rows whose `approvedAt` falls in `[from, to)`, honouring the
   * actor's visibility scope. `summary_only` amounts are included (only the
   * merchant is masked, elsewhere); another member's `private` rows are excluded.
   */
  async summary(
    userId: string,
    query: TransactionSummaryQuery,
  ): Promise<TransactionSummaryResponse> {
    const householdId = this.requireHouseholdId(query.householdId);
    const actor = await this.requireMembership(householdId, userId);

    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (!from || !to) {
      throw new BadRequestException('from and to are required (ISO datetime)');
    }

    const conditions: SQL[] = [
      eq(schema.cardTransactions.householdId, householdId),
      eq(schema.cardTransactions.transactionType, 'approval'),
      // '중복이라 제외' 확정 거래는 요약 합계에서도 뺀다(analytics/budgets와 동일).
      isNull(schema.cardTransactions.excludedAt),
      // 자산 이동도 지출 요약에서 뺀다(같은 규칙).
      notTransferCategory(),
      // 요약 합계는 KRW 전용(amount=minor units라 외화 혼입 시 오염). 응답에도
      // currency:'KRW' 마커를 내려 클라이언트가 ₩ 포맷을 확정하게 한다.
      eq(schema.cardTransactions.currency, 'KRW'),
      visibilityScope(actor.memberId),
      // 기간 창은 analytics/예산과 같은 공통 헬퍼(ADR-0026) — 세 경로의 같은 달 총액이
      // 일치해야 이 요약이 검증 기준으로 쓸 수 있다.
      spendPeriodWindow(from, to),
    ];

    const [agg] = await this.db
      .select({
        totalNet: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
        totalApproved: sql<string>`coalesce(sum(${schema.cardTransactions.amount}), 0)`,
        totalCancelled: sql<string>`coalesce(sum(${schema.cardTransactions.cancelledAmount}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .where(and(...conditions));

    const totalNet = toInt(agg?.totalNet);
    const totalApproved = toInt(agg?.totalApproved);
    const totalCancelled = toInt(agg?.totalCancelled);
    const count = toInt(agg?.count);
    assertKrwInteger(totalNet);
    assertKrwInteger(totalApproved);
    assertKrwInteger(totalCancelled);

    const memberRows = await this.db
      .selectDistinct({ memberId: schema.cardTransactions.memberId })
      .from(schema.cardTransactions)
      .where(and(...conditions));

    return {
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: DEFAULT_TIMEZONE,
      },
      currency: 'KRW',
      totalNet,
      totalApproved,
      totalCancelled,
      includedMembers: memberRows.map((r) => r.memberId),
      count,
    };
  }

  /**
   * 사람 확정 규칙이 없는 가맹점을 수정 가능한 거래 범위에서 집계한다.
   * 다른 구성원의 private/summary_only 가맹점은 원문 노출을 막기 위해 제외하고,
   * AI prediction은 추천값으로만 반환한다.
   */
  async listMerchantLabelCandidates(
    userId: string,
    householdIdInput: string | undefined,
    limitInput: string | undefined,
  ): Promise<MerchantLabelCandidateListResponse> {
    const householdId = this.requireHouseholdId(householdIdInput);
    const actor = await this.requireMembership(householdId, userId);
    const take = this.parseLimit(limitInput);
    const canMutateHouseholdRows = PRIVILEGED_ROLES.includes(actor.role);
    const mutableMerchantScope = canMutateHouseholdRows
      ? or(
          eq(schema.cardTransactions.memberId, actor.memberId),
          eq(schema.cardTransactions.visibility, 'household'),
        )
      : eq(schema.cardTransactions.memberId, actor.memberId);

    const latestTransactionAt = sql<Date>`max(coalesce(
      ${schema.cardTransactions.approvedAt},
      ${schema.cardTransactions.createdAt}
    ))`;
    const transactionCount = sql<number>`count(*)::int`;
    const candidatePriority = sql<number>`case
      when ${schema.merchantCategoryRules.source} = 'model_prediction' then 0
      else 1
    end`;
    const rowsQuery = this.db
      .select({
        representativeTransactionId: sql<string>`(
          array_agg(
            ${schema.cardTransactions.id}
            order by coalesce(
              ${schema.cardTransactions.approvedAt},
              ${schema.cardTransactions.createdAt}
            ) desc, ${schema.cardTransactions.id} desc
          )
        )[1]`,
        merchantNormalized: schema.cardTransactions.merchantNormalized,
        transactionCount,
        latestTransactionAt,
        ruleSource: schema.merchantCategoryRules.source,
        suggestedCategoryId: schema.merchantCategoryRules.categoryId,
        suggestedCategorySlug: schema.expenseCategories.slug,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.merchantCategoryRules,
        and(
          eq(
            schema.merchantCategoryRules.householdId,
            schema.cardTransactions.householdId,
          ),
          eq(
            schema.merchantCategoryRules.merchantPattern,
            schema.cardTransactions.merchantNormalized,
          ),
        ),
      )
      .leftJoin(
        schema.expenseCategories,
        eq(
          schema.merchantCategoryRules.categoryId,
          schema.expenseCategories.id,
        ),
      )
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          isNull(schema.cardTransactions.excludedAt),
          sql`${schema.cardTransactions.merchantNormalized} is not null`,
          sql`btrim(${schema.cardTransactions.merchantNormalized}) <> ''`,
          mutableMerchantScope as SQL,
          or(
            isNull(schema.merchantCategoryRules.id),
            eq(schema.merchantCategoryRules.source, 'model_prediction'),
          ),
        ),
      )
      .groupBy(
        schema.cardTransactions.merchantNormalized,
        schema.merchantCategoryRules.source,
        schema.merchantCategoryRules.categoryId,
        schema.expenseCategories.slug,
      )
      .orderBy(
        candidatePriority,
        desc(transactionCount),
        desc(latestTransactionAt),
      )
      .limit(take + 1);

    const [rows, trainingReadiness] = await Promise.all([
      rowsQuery,
      this.getMerchantLabelTrainingReadiness(householdId),
    ]);

    return {
      items: rows.slice(0, take).map((row) => {
        if (row.merchantNormalized === null) {
          throw new Error('merchant label candidate has no normalized merchant');
        }
        return {
          representativeTransactionId: row.representativeTransactionId,
          merchantNormalized: row.merchantNormalized,
          transactionCount: row.transactionCount,
          latestTransactionAt: new Date(
            row.latestTransactionAt,
          ).toISOString(),
          source:
            row.ruleSource === 'model_prediction'
              ? 'model_prediction'
              : 'unlabeled',
          suggestedCategoryId: row.suggestedCategoryId,
          suggestedCategorySlug: row.suggestedCategorySlug,
        };
      }),
      hasMore: rows.length > take,
      trainingReadiness,
    };
  }

  /** 가맹점명을 반환하지 않고 현재 사람 라벨 진입 게이트만 집계한다. */
  private async getMerchantLabelTrainingReadiness(
    householdId: string,
  ): Promise<MerchantLabelTrainingReadiness> {
    const [rules, feedbackRows] = await Promise.all([
      this.db
        .select({
          merchantPattern: schema.merchantCategoryRules.merchantPattern,
          categoryId: schema.merchantCategoryRules.categoryId,
        })
        .from(schema.merchantCategoryRules)
        .where(
          and(
            eq(schema.merchantCategoryRules.householdId, householdId),
            eq(schema.merchantCategoryRules.source, 'human_confirmed'),
            isNotNull(schema.merchantCategoryRules.confirmedAt),
          ),
        ),
      this.db
        .select({
          targetId: schema.feedbackEvents.targetId,
          categoryId: sql<string | null>`${schema.feedbackEvents.label} ->> 'categoryId'`,
        })
        .from(schema.feedbackEvents)
        .where(
          and(
            eq(schema.feedbackEvents.householdId, householdId),
            eq(schema.feedbackEvents.targetType, 'merchant-category'),
            eq(schema.feedbackEvents.source, 'human_confirmed'),
          ),
        ),
    ]);

    const labelsByClass = new Map<string, number>();
    for (const rule of rules) {
      labelsByClass.set(
        rule.categoryId,
        (labelsByClass.get(rule.categoryId) ?? 0) + 1,
      );
    }
    const lineage = new Set(
      feedbackRows
        .filter(
          (row): row is { targetId: string; categoryId: string } =>
            row.categoryId !== null,
        )
        .map((row) => `${row.targetId}:${row.categoryId}`),
    );
    const missingLineage = rules.filter((rule) => {
      const targetId = createMerchantCategoryTargetId(
        householdId,
        rule.merchantPattern,
      );
      return !lineage.has(`${targetId}:${rule.categoryId}`);
    }).length;
    const minimumClassLabels =
      labelsByClass.size === 0
        ? 0
        : Math.min(...labelsByClass.values());
    const ready =
      missingLineage === 0 &&
      rules.length >= MERCHANT_TRAINING_READINESS.minimumLabels &&
      labelsByClass.size >= MERCHANT_TRAINING_READINESS.minimumClasses &&
      minimumClassLabels >=
        MERCHANT_TRAINING_READINESS.minimumLabelsPerClass;

    return {
      humanConfirmedLabels: rules.length,
      requiredLabels: MERCHANT_TRAINING_READINESS.minimumLabels,
      distinctClasses: labelsByClass.size,
      requiredClasses: MERCHANT_TRAINING_READINESS.minimumClasses,
      minimumClassLabels,
      requiredLabelsPerClass:
        MERCHANT_TRAINING_READINESS.minimumLabelsPerClass,
      missingLineage,
      status: ready ? 'ready' : 'collect_labels',
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Updates a transaction (owner/admin, or the member who owns the row).
   * Changing `categoryId` with `applyRule` upserts a `merchant_category_rules`
   * entry `(householdId, merchantNormalized) → categoryId` so *future*
   * promotions/reclassifications pick it up (never retroactive). Changing
   * `cardId` re-inherits the card visibility unless `visibility` is set too.
   */
  async update(
    userId: string,
    id: string,
    input: TransactionUpdateRequest,
  ): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    const updates: Partial<schema.NewCardTransaction> = {
      updatedAt: new Date(),
    };

    if (input.categoryId !== undefined) {
      await this.assertCategoryUsable(input.categoryId, current.householdId);
      updates.categoryId = input.categoryId;
    }
    if (input.merchantNormalized !== undefined) {
      updates.merchantNormalized = input.merchantNormalized;
    }
    if (input.memberId !== undefined) {
      await this.assertMemberInHousehold(input.memberId, current.householdId);
      updates.memberId = input.memberId;
    }
    if (input.cardId !== undefined) {
      if (input.cardId === null) {
        updates.cardId = null;
        if (input.visibility === undefined) {
          updates.visibility = 'household';
        }
      } else {
        const card = await this.loadCard(input.cardId, current.householdId);
        updates.cardId = card.id;
        if (input.visibility === undefined) {
          updates.visibility = card.visibility as Visibility;
        }
      }
    }
    if (input.visibility !== undefined) {
      updates.visibility = input.visibility;
    }
    if (input.memo !== undefined) {
      updates.memo = input.memo;
    }
    /**
     * ADR-0027 5단계: 금액·거래시각은 enforce가 켜지면 **새 계약이 소유한다.**
     * 거래시각이 바뀌면 환율 기준일이 바뀌고 그러면 순액도 다시 계산돼야 하는데,
     * 예전 경로는 `approvedAt`만 갈아끼우고 금액은 그대로 뒀다(D-1). 그래서 둘을
     * 한 명령으로 묶어 `amendApproval`에 넘긴다 — 부분 반영으로 체인을 깨진 상태에
     * 두지 않는 것이 ADR §2다.
     */
    const moneyFieldsChanged =
      input.amount !== undefined || input.occurredAt !== undefined;
    const enforceMoney = this.moneyWrite.enforced && moneyFieldsChanged;

    if (input.amount !== undefined) {
      // 금액 수정은 취소 연결이 없는 단순 거래에서만(netAmount 불변식 보호).
      if (current.cancelledAmount !== 0 || current.parentTransactionId !== null) {
        throw new BadRequestException(
          '취소가 연결된 거래는 금액을 수정할 수 없어요',
        );
      }
      assertKrwInteger(input.amount);
      if (!enforceMoney) {
        updates.amount = input.amount;
        // 승인은 net = amount(취소 없음), 취소 행은 net이 항상 0.
        updates.netAmount = current.transactionType === 'approval' ? input.amount : 0;
      }
    }
    if (input.occurredAt !== undefined && !enforceMoney) {
      const occurred = new Date(input.occurredAt);
      if (current.transactionType === 'approval') {
        updates.approvedAt = occurred;
      } else {
        updates.cancelledAt = occurred;
      }
    }

    if (enforceMoney) {
      // 새 계약의 수정 명령은 승인 체인만 다룬다. 취소 행의 금액을 바꾸면 연결된
      // 승인의 상계도 함께 바뀌어야 하는데 예전 경로는 그것을 하지 않았다 —
      // 그 조용한 불일치를 이어받지 않고 거부한다.
      if (current.transactionType !== 'approval') {
        throw new BadRequestException(
          '취소 거래의 금액과 거래 시각은 수정할 수 없어요. 연결을 해제한 뒤 다시 등록해 주세요.',
        );
      }
      if (current.originalCurrency !== null) {
        throw new BadRequestException(
          '외화 거래의 금액은 앱에서 수정할 수 없어요. 원화 환산은 거래일 환율로 고정돼요.',
        );
      }
    }

    // The category change and the (optional) rule upsert are atomic.
    const effectiveMerchant =
      input.merchantNormalized ?? current.merchantNormalized;

    await this.db.transaction(async (tx) => {
      // 금액 명령을 먼저 돌린다 — 잠금 순서(승인→취소)를 이 명령이 소유하므로,
      // 같은 트랜잭션에서 다른 UPDATE가 앞서면 P0-4에서 고정한 순서가 흐트러진다.
      if (enforceMoney) {
        const outcome = await this.moneyWrite.commands.amendApproval(
          {
            approvalId: id,
            ...(input.amount === undefined ? {} : { minorUnits: input.amount }),
            ...(input.occurredAt === undefined
              ? {}
              : { occurredAt: new Date(input.occurredAt) }),
          },
          { tx },
        );
        if (!outcome.ok) throw moneyRejectionToHttp(outcome.reason);
      }
      await tx
        .update(schema.cardTransactions)
        .set(updates)
        .where(eq(schema.cardTransactions.id, id));

      // 단일 거래 카테고리 수정도 사람 확정 라벨이다. 가맹점 원문은 저장하지
      // 않고 transaction id를 통해 권한/원본 데이터를 역추적한다.
      if (input.categoryId !== undefined) {
        await tx.insert(schema.feedbackEvents).values({
          householdId: current.householdId,
          targetType: 'transaction-category',
          targetId: id,
          labelSchemaVersion: 'transaction-category-v1',
          label: { categoryId: input.categoryId },
          source: 'human_confirmed',
          actorUserId: userId,
          occurredAt: new Date(),
        });
      }

      if (input.applyRule && input.categoryId !== undefined && effectiveMerchant) {
        const now = new Date();
        const targetId = createMerchantCategoryTargetId(
          current.householdId,
          effectiveMerchant,
        );
        const [previousRule] = await tx
          .select({
            id: schema.merchantCategoryRules.id,
            categoryId: schema.merchantCategoryRules.categoryId,
          })
          .from(schema.merchantCategoryRules)
          .where(
            and(
              eq(
                schema.merchantCategoryRules.householdId,
                current.householdId,
              ),
              eq(
                schema.merchantCategoryRules.merchantPattern,
                effectiveMerchant,
              ),
            ),
          )
          .limit(1);
        await tx
          .insert(schema.merchantCategoryRules)
          .values({
            householdId: current.householdId,
            merchantPattern: effectiveMerchant,
            categoryId: input.categoryId,
            source: 'human_confirmed',
            predictionTraceId: null,
            confirmedAt: now,
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [
              schema.merchantCategoryRules.householdId,
              schema.merchantCategoryRules.merchantPattern,
            ],
            set: {
              categoryId: input.categoryId,
              source: 'human_confirmed',
              predictionTraceId: null,
              confirmedAt: now,
              createdBy: userId,
              updatedAt: now,
            },
          });
        await tx.insert(schema.feedbackEvents).values({
          householdId: current.householdId,
          targetType: 'merchant-category',
          targetId,
          labelSchemaVersion: 'merchant-category-v1',
          label: { categoryId: input.categoryId },
          source: 'human_confirmed',
          actorUserId: userId,
          occurredAt: now,
        });

        /**
         * 이미 Gold snapshot에 포함된 규칙의 label이 바뀌면 과거 artifact는
         * immutable하게 보존하되 평가 근거로는 즉시 revoke한다.
         *
         * 연쇄 자체는 `@family/database`의 공용 구현을 부른다 — 같은 5단계가
         * `learning-dataset.service.ts`에도 있고, 소급 일괄 재분류가 세 번째 사본을
         * 만들면 그중 하나가 단계를 빠뜨린 채 조용히 남는다.
         */
        if (previousRule && previousRule.categoryId !== input.categoryId) {
          await revokeMerchantRuleLineage(
            tx,
            [previousRule.id],
            'merchant_category_rule_changed',
            now,
          );
        }
      }
    });

    const row = await this.loadSummaryRow(id);
    // 편집 결과를 가족의 다른 열린 화면에 전파(best-effort, fire-and-forget).
    void this.realtimePublisher.publish(row.txn.householdId);
    // 금액·거래시각을 바꿨다면 새 계약은 환율 기준일까지 다시 고른다 — 그 차이를 센다.
    if (input.amount !== undefined || input.occurredAt !== undefined) {
      this.moneyShadow.observe(id, 'api_transaction_update');
    }
    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /**
   * 이 취소 행에 연결할 수 있는 승인 후보 전량(`GET :id/cancellation-candidates`).
   *
   * ## 왜 목록 API로는 안 되는가
   *
   * 웹 모달이 `list({ type:'approval', limit:100 })`로 최근 100건만 받아 클라이언트에서
   * 걸렀다. `MAX_LIMIT=100`이 상한이라 limit을 올려 우회할 수도 없어, **100건 밖의
   * 승인은 사용자가 연결할 방법이 없었다.** 승인이 100건을 넘긴 뒤에야 조용히 발생하는
   * 결함이다(2026-08-11 실측 136건).
   *
   * ## LIMIT을 걸지 않는다
   *
   * 이 엔드포인트의 존재 이유가 "말없이 잘려서 도달 불가"를 없애는 것이므로 상한을 두지
   * 않고, 커서도 쓰지 않는다(`nextCursor: null` = 이게 전부라는 뜻). 반환 행 수는
   * household의 승인 중 **통화 일치 + 잔액 ≥ 취소액 + 취소보다 앞선 것**으로 좁혀지므로
   * 전체 승인 수보다 훨씬 작다. 수만 건 규모가 되면 그때 검색 파라미터와 함께
   * 페이지네이션을 도입한다 — 그전에 상한을 두면 같은 결함을 다시 만든다.
   *
   * 권한 게이트는 {@link linkCancellation}과 **같다**: 후보 목록은 승인의 금액·가맹점·
   * 날짜를 드러내므로, 연결할 수 없는 사람에게 보여 주면 조회 수단이 된다.
   */
  async listCancellationCandidates(
    userId: string,
    cancellationId: string,
  ): Promise<TransactionListResponse> {
    const cancellation = await this.loadTransaction(cancellationId);
    const actor = await this.requireMembership(
      cancellation.householdId,
      userId,
    );
    this.assertCanMutate(actor, cancellation.memberId);

    if (cancellation.transactionType !== 'cancellation') {
      throw new BadRequestException('source is not a cancellation transaction');
    }
    // 이미 연결된 취소에 후보를 돌려주면 "고를 수 있다"는 거짓 신호가 된다. 빈 배열도
    // 거짓말이다("후보가 없다"와 "이미 연결됐다"는 다른 사실이다). 저장 경로와 같은
    // 409로 사실을 그대로 알린다.
    if (cancellation.parentTransactionId) {
      throw new ConflictException('cancellation is already linked');
    }

    const rows = await this.db
      .select({
        txn: schema.cardTransactions,
        categorySlug: schema.expenseCategories.slug,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.cardTransactions.categoryId, schema.expenseCategories.id),
      )
      .where(cancellationCandidateFilter(cancellation, actor.memberId))
      .orderBy(...cancellationCandidateOrder(cancellation));

    const items = rows.map((r) =>
      buildSummary(r.txn, r.categorySlug, maskedFor(r.txn, actor.memberId)),
    );
    return { items, nextCursor: null };
  }

  /**
   * Manually links a `cancellation` row to its `approval` (spec §5.3). Validates
   * same household, that the target is an approval and the source a cancellation,
   * and that the cancelled amount does not exceed the remaining approved balance.
   * Accumulates `cancelledAmount`, recomputes `netAmount`/`status` on the
   * approval, and marks the cancellation resolved. Runs in one DB transaction.
   */
  async linkCancellation(
    userId: string,
    cancellationId: string,
    input: LinkCancellationRequest,
  ): Promise<TransactionSummary> {
    const cancellation = await this.loadTransaction(cancellationId);
    const actor = await this.requireMembership(
      cancellation.householdId,
      userId,
    );
    this.assertCanMutate(actor, cancellation.memberId);

    if (cancellation.transactionType !== 'cancellation') {
      throw new BadRequestException('source is not a cancellation transaction');
    }
    if (cancellation.parentTransactionId) {
      throw new ConflictException('cancellation is already linked');
    }

    /*
     * 잔액 검증과 누적을 **승인 행을 잠근 뒤** 다시 한다.
     *
     * 이전 구현은 트랜잭션 밖에서 읽은 `cancelledAmount`로 새 합계를 미리 계산하고
     * 조건 없이 덮어썼다. 두 취소가 같은 초기값을 읽으면 나중 update만 남아 취소액이
     * 통째로 유실되고 `netAmount`·월 지출·예산 사용률이 **실제보다 크게** 나온다.
     * 잔액 초과 검사도 잠그기 전 값으로 하면 검사 자체가 무의미하다.
     *
     * 잠금 순서는 **승인 → 취소**로 고정한다({@link remove}의 역산 경로도 같다).
     * 반대로 잠그는 경로가 하나라도 생기면 link/delete 교차 시 데드락이 된다.
     */
    if (this.moneyWrite.enforced) {
      /**
       * ADR-0027 5단계. 금액 조작(claim → 잔액 검증 → 체인 재계산)은 새 계약이 소유하고,
       * **권한과 공개범위는 여기 남는다** — 도메인 서비스는 누가 무엇을 볼 수 있는지
       * 모르고, 알아야 할 이유도 없다.
       *
       * 승인 행을 `for('update')`로 잠그지 않는 것이 중요하다. 재연결이면 도메인이
       * `[이전 부모, 새 부모]`를 **id 오름차순으로** 잠그는데, 여기서 새 부모를 먼저
       * 잠가 두면 그 순서가 뒤집혀 교착이 된다. 검증은 잠금 없이 읽고, 경합에 민감한
       * 조건(household·통화·잔액·중복 연결)은 도메인이 잠근 뒤 다시 본다.
       */
      await this.db.transaction(async (tx) => {
        const [approval] = await tx
          .select()
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, input.approvalTransactionId))
          .limit(1);
        if (!approval) {
          throw new NotFoundException('transaction not found');
        }
        // 공개범위는 API의 책임이다. 존재를 숨기는 404 정책도 그대로 유지한다.
        if (!actorCanSeeApproval(approval, actor.memberId)) {
          throw new NotFoundException('transaction not found');
        }

        const outcome = await this.moneyWrite.commands.linkCancellation(
          { cancellationId: cancellation.id, approvalId: approval.id },
          { tx },
        );
        if (!outcome.ok) throw moneyRejectionToHttp(outcome.reason);
      });
    } else {
      await this.db.transaction(async (tx) => {
        const [approval] = await tx
          .select()
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, input.approvalTransactionId))
          .for('update')
          .limit(1);
        if (!approval) {
          throw new NotFoundException('transaction not found');
        }
        if (approval.householdId !== cancellation.householdId) {
          throw new BadRequestException(
            'transactions belong to different households',
          );
        }
        if (approval.transactionType !== 'approval') {
          throw new BadRequestException('target is not an approval transaction');
        }
        /*
         * 승인 대상에도 공개범위를 건다.
         *
         * 이 검사가 없던 동안 저장 경로는 household·승인여부·통화·잔액만 봤고,
         * 타인의 `private` 승인이라도 UUID만 알면 **연결(= 쓰기)** 이 됐다. 게다가
         * 응답이 그 승인의 요약을 마스킹 없이 돌려줘 가려졌던 가맹점명까지 드러났다.
         * 후보 엔드포인트가 타인의 `summary_only` 승인을 (가맹점만 가린 채) 후보로
         * 주므로 그 id로 곧장 도달할 수 있었다 — 추측이 필요 없는 경로였다.
         *
         * 역할 예외를 두지 않는다. `visibilityScope()`도 owner/admin을 봐주지 않아
         * 목록·상세·집계 어디서도 타인의 `private`은 보이지 않는다. 여기만 열면
         * "owner는 볼 수 없는 거래를 고칠 수 있다"가 되어 규약이 갈라진다.
         * (`assertCanMutate`의 권한자 예외는 **취소 행**에 적용된다 — 가족의 취소를
         * 대신 정리하는 것은 허용하되, 대상 승인은 본인이 볼 수 있는 것이어야 한다.)
         */
        if (!actorCanSeeApproval(approval, actor.memberId)) {
          // 존재를 숨긴다. 403을 주면 "그런 승인이 있긴 하다"가 새어 나가고,
          // 상세 조회(:301 부근)도 같은 이유로 404를 준다.
          throw new NotFoundException('transaction not found');
        }
        // amount는 minor units라 통화가 다르면 뺄셈/비교가 무의미하다(USD 취소를 KRW
        // 승인에 연결 등). 동일 통화 거래끼리만 연결을 허용한다.
        if (approval.currency !== cancellation.currency) {
          throw new BadRequestException('transactions have different currencies');
        }

        const now = new Date();

        // 취소 행을 원자적으로 claim한다 — 이미 연결된 취소를 두 번 연결하면 승인 잔액이
        // 두 번 깎인다. 승인 갱신은 claim이 성공한 뒤에만 한다.
        const [claimed] = await tx
          .update(schema.cardTransactions)
          .set({
            parentTransactionId: approval.id,
            status: 'approved',
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.cardTransactions.id, cancellation.id),
              isNull(schema.cardTransactions.parentTransactionId),
            ),
          )
          .returning({ amount: schema.cardTransactions.amount });
        if (!claimed) {
          throw new ConflictException('cancellation is already linked');
        }

        const remaining = approval.amount - approval.cancelledAmount;
        if (claimed.amount > remaining) {
          throw new BadRequestException(
            'cancellation amount exceeds remaining approved balance',
          );
        }

        const newCancelled = approval.cancelledAmount + claimed.amount;
        assertKrwInteger(newCancelled);
        const newNet = approval.amount - newCancelled;
        assertKrwInteger(newNet);
        const newStatus: TxnStatus =
          newCancelled >= approval.amount ? 'cancelled' : 'partially_cancelled';

        await tx
          .update(schema.cardTransactions)
          .set({
            cancelledAmount: newCancelled,
            netAmount: newNet,
            status: newStatus,
            updatedAt: now,
          })
          .where(eq(schema.cardTransactions.id, approval.id));
      });
    }

    const row = await this.loadSummaryRow(input.approvalTransactionId);
    // 취소↔승인 연결을 가족의 다른 열린 화면에 전파(best-effort).
    void this.realtimePublisher.publish(row.txn.householdId);
    // 사람이 고른 부모와 새 후보 규칙이 고를 부모가 같은지 센다(`link_target_differs`).
    this.moneyShadow.observe(cancellationId, 'api_link_cancellation');
    // 마스킹을 actor 기준으로 다시 계산한다. `false` 고정이던 동안 타인의
    // `summary_only` 승인에 연결하면 가려졌던 가맹점명이 응답으로 드러났다.
    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /** Flags a transaction as a suspected duplicate (owner/admin or row owner). */
  async markDuplicate(
    userId: string,
    id: string,
  ): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    await this.db
      .update(schema.cardTransactions)
      .set({ status: 'duplicate_suspected', updatedAt: new Date() })
      .where(eq(schema.cardTransactions.id, id));

    const row = await this.loadSummaryRow(id);
    // 편집 결과를 가족의 다른 열린 화면에 전파(best-effort, fire-and-forget).
    void this.realtimePublisher.publish(row.txn.householdId);
    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /**
   * Clears a `duplicate_suspected`/`pending_review` flag, recomputing the
   * canonical status and `netAmount` from the row's amounts.
   */
  async markValid(userId: string, id: string): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    if (
      current.status !== 'duplicate_suspected' &&
      current.status !== 'pending_review'
    ) {
      throw new BadRequestException('transaction is not pending review');
    }

    let status: TxnStatus;
    let netAmount: number;
    if (current.transactionType === 'approval') {
      netAmount = current.amount - current.cancelledAmount;
      assertKrwInteger(netAmount);
      status =
        current.cancelledAmount >= current.amount
          ? 'cancelled'
          : current.cancelledAmount > 0
            ? 'partially_cancelled'
            : 'approved';
    } else {
      // A cancellation row carries no net amount of its own.
      netAmount = 0;
      status = 'approved';
    }

    await this.db
      .update(schema.cardTransactions)
      .set({ status, netAmount, updatedAt: new Date() })
      .where(eq(schema.cardTransactions.id, id));

    const row = await this.loadSummaryRow(id);
    // 편집 결과를 가족의 다른 열린 화면에 전파(best-effort, fire-and-forget).
    void this.realtimePublisher.publish(row.txn.householdId);
    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /**
   * Excludes a transaction from every total/budget (사용자가 '중복이라 제외' 확정).
   * Sets `excludedAt=now` — a flag orthogonal to `status` so the row keeps its
   * kind/amounts for history while dropping out of aggregations. Idempotent.
   */
  async exclude(userId: string, id: string): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    if (current.excludedAt === null) {
      await this.db
        .update(schema.cardTransactions)
        .set({ excludedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.cardTransactions.id, id));
    }

    const row = await this.loadSummaryRow(id);
    // 편집 결과를 가족의 다른 열린 화면에 전파(best-effort, fire-and-forget).
    void this.realtimePublisher.publish(row.txn.householdId);
    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /** Undoes {@link exclude}: `excludedAt=null` so the row counts again. Idempotent. */
  async include(userId: string, id: string): Promise<TransactionSummary> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    if (current.excludedAt !== null) {
      await this.db
        .update(schema.cardTransactions)
        .set({ excludedAt: null, updatedAt: new Date() })
        .where(eq(schema.cardTransactions.id, id));
    }

    const row = await this.loadSummaryRow(id);
    // 편집 결과를 가족의 다른 열린 화면에 전파(best-effort, fire-and-forget).
    void this.realtimePublisher.publish(row.txn.householdId);
    return buildSummary(
      row.txn,
      row.categorySlug,
      maskedFor(row.txn, actor.memberId),
    );
  }

  /**
   * 거래를 하드 삭제한다(되돌리기 불가 — 되돌림이 필요하면 exclude 사용).
   * - 자식 취소가 연결된 승인은 차단(취소를 먼저 처리해야 함).
   * - 연결된 취소를 삭제하면 부모 승인의 cancelledAmount/netAmount/status를 역산
   *   복원한다({@link linkCancellation}의 역연산).
   * source `card_sms_event`는 원문 감사용으로 남긴다. ⚠️ 삭제한 거래의 source를
   * **수동 재파싱**하면 재생성될 수 있으나(자동 재파싱 경로 없음), 재파싱=소스
   * 재도출이라 의도된 동작으로 본다.
   */
  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    const current = await this.loadTransaction(id);
    const actor = await this.requireMembership(current.householdId, userId);
    this.assertCanMutate(actor, current.memberId);

    await this.db.transaction(async (tx) => {
      if (current.transactionType === 'approval') {
        // 자식 검사와 삭제 사이에 취소가 연결되면 자기참조 FK 위반(500)이 난다.
        // 승인 행을 잠근 뒤 검사해야 진행 중인 linkCancellation과 직렬화된다.
        const [locked] = await tx
          .select({ id: schema.cardTransactions.id })
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, id))
          .for('update')
          .limit(1);
        if (!locked) {
          throw new NotFoundException('transaction not found');
        }
        const [child] = await tx
          .select({ id: schema.cardTransactions.id })
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.parentTransactionId, id))
          .limit(1);
        if (child) {
          throw new ConflictException(
            '연결된 취소 거래가 있어 삭제할 수 없어요. 취소 거래를 먼저 삭제하세요',
          );
        }
      }

      // 연결된 취소를 지우면 부모 승인 잔액을 역산 복원한다. 잠금 순서는
      // linkCancellation과 동일하게 **승인 → 취소**다(반대로 잠그면 데드락).
      if (
        current.transactionType === 'cancellation' &&
        current.parentTransactionId
      ) {
        const [approval] = await tx
          .select()
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, current.parentTransactionId))
          .for('update')
          .limit(1);
        // 잠근 뒤 취소 행을 다시 읽는다 — 잠금 전 값으로 역산하면 동시 연결/해제가
        // 서로의 누적을 덮어쓴다. 부모가 바뀌었으면(다른 요청이 먼저 처리) 역산하지 않는다.
        const [linked] = await tx
          .select({
            amount: schema.cardTransactions.amount,
            parentTransactionId: schema.cardTransactions.parentTransactionId,
          })
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, id))
          .for('update')
          .limit(1);
        if (approval && linked && linked.parentTransactionId === approval.id) {
          const newCancelled = Math.max(
            0,
            approval.cancelledAmount - linked.amount,
          );
          assertKrwInteger(newCancelled);
          const newNet = approval.amount - newCancelled;
          assertKrwInteger(newNet);
          const newStatus: TxnStatus =
            newCancelled >= approval.amount
              ? 'cancelled'
              : newCancelled > 0
                ? 'partially_cancelled'
                : 'approved';
          await tx
            .update(schema.cardTransactions)
            .set({
              cancelledAmount: newCancelled,
              netAmount: newNet,
              status: newStatus,
              updatedAt: new Date(),
            })
            .where(eq(schema.cardTransactions.id, approval.id));
        }
      }

      await tx
        .delete(schema.cardTransactions)
        .where(eq(schema.cardTransactions.id, id));
    });

    // 삭제를 가족의 다른 열린 화면에 전파(best-effort, fire-and-forget).
    void this.realtimePublisher.publish(current.householdId);
    return { deleted: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Authorization + loaders                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforces that `userId` is an active member of `householdId` and returns the
   * actor's `memberId`/`role`. Non-members get a 403 that does not disclose
   * whether the household exists (PRD §26).
   */
  private async requireMembership(
    householdId: string,
    userId: string,
    roles?: readonly HouseholdRole[],
  ): Promise<ActorMembership> {
    const [member] = await this.db
      .select({
        id: schema.householdMembers.id,
        role: schema.householdMembers.role,
      })
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
    return { memberId: member.id, role: member.role };
  }

  /** Owner/admin, or the member who owns the row, may mutate it. */
  private assertCanMutate(actor: ActorMembership, rowMemberId: string): void {
    if (PRIVILEGED_ROLES.includes(actor.role)) {
      return;
    }
    if (actor.memberId === rowMemberId) {
      return;
    }
    throw new ForbiddenException('insufficient permission for this transaction');
  }

  /** 검색어 정규화: 트림 후 빈 문자열이면 undefined(필터를 걸지 않는다). */
  private parseSearch(raw: string | undefined): string | undefined {
    const trimmed = raw?.trim();
    return trimmed ? trimmed.slice(0, SEARCH_MAX_LENGTH) : undefined;
  }

  /**
   * 가맹점·메모 부분 일치 검색 WHERE 조각.
   *
   * ⚠️ **마스킹 대상 행은 검색에서 아예 제외한다.** 타인의 `summary_only` 거래는
   * 응답에서 가맹점·메모가 null로 가려지지만(`maskedFor`), 검색은 그것만으로 부족하다
   * — `q=산부인과`로 한 건이 나오면 **결과의 존재 자체**가 "누가 거기 갔다"를 알려준다.
   * 가려진 값으로는 사용자가 왜 매칭됐는지도 알 수 없어 화면도 이상해진다.
   * 그래서 매칭 대상을 "본인 행 ∪ household 공개 행"으로 좁힌다.
   *
   * 대소문자 무시는 `ilike`, 사용자 입력의 와일드카드(`%` `_`)와 이스케이프(`\`)는
   * 리터럴로 취급한다 — `%`를 그대로 넘기면 전체 매칭이 되어 검색이 아니라 목록이 된다.
   *
   * 인덱스 없이 순차 스캔이지만 규모가 수백 행이라 무의미하다. 수만 행이 되면
   * `pg_trgm` GIN 인덱스를 붙인다(확장은 이미 설치돼 있다 — slack_messages가 쓴다).
   */
  private searchScope(term: string, actorMemberId: string): SQL {
    const pattern = `%${term.replace(/([\\%_])/g, '\\$1')}%`;
    const textMatch = or(
      ilike(schema.cardTransactions.merchantRaw, pattern),
      ilike(schema.cardTransactions.merchantNormalized, pattern),
      ilike(schema.cardTransactions.memo, pattern),
    ) as SQL;
    const notMasked = or(
      eq(schema.cardTransactions.memberId, actorMemberId),
      ne(schema.cardTransactions.visibility, 'summary_only'),
    ) as SQL;
    return and(notMasked, textMatch) as SQL;
  }

  /** Loads a raw transaction row or throws 404. */
  private async loadTransaction(id: string): Promise<schema.CardTransaction> {
    const [txn] = await this.db
      .select()
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.id, id))
      .limit(1);
    if (!txn) {
      throw new NotFoundException('transaction not found');
    }
    return txn;
  }

  /** Loads a transaction row joined with its category slug, or throws 404. */
  private async loadSummaryRow(
    id: string,
  ): Promise<{ txn: schema.CardTransaction; categorySlug: string | null }> {
    const [row] = await this.db
      .select({
        txn: schema.cardTransactions,
        categorySlug: schema.expenseCategories.slug,
      })
      .from(schema.cardTransactions)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.cardTransactions.categoryId, schema.expenseCategories.id),
      )
      .where(eq(schema.cardTransactions.id, id))
      .limit(1);
    if (!row) {
      throw new NotFoundException('transaction not found');
    }
    return row;
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

  /** Loads a card scoped to the household, or throws 400. */
  private async loadCard(
    cardId: string,
    householdId: string,
  ): Promise<schema.PaymentCard> {
    const [card] = await this.db
      .select()
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
    return card;
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

  /** Clamps the requested page size to `[1, MAX_LIMIT]` (default 50). */
  private parseLimit(limit: string | undefined): number {
    if (limit === undefined) {
      return DEFAULT_LIMIT;
    }
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return Math.min(parsed, MAX_LIMIT);
  }

  private parseType(type: string): TxnType {
    if (!TXN_TYPES.includes(type as TxnType)) {
      throw new BadRequestException('invalid transaction type filter');
    }
    return type as TxnType;
  }

  private parseStatus(status: string): TxnStatus {
    if (!TXN_STATUSES.includes(status as TxnStatus)) {
      throw new BadRequestException('invalid status filter');
    }
    return status as TxnStatus;
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (value === undefined || value === '') {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be an ISO datetime`);
    }
    return parsed;
  }

  private parseAmount(
    value: string | undefined,
    field: string,
  ): number | undefined {
    if (value === undefined || value === '') {
      return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }
    return parsed;
  }

  /** Encodes an opaque `base64url("<epochMs>:<uuid>")` keyset cursor. */
  private encodeCursor(row: { createdAt: Date; id: string }): string {
    return Buffer.from(
      `${row.createdAt.getTime()}:${row.id}`,
      'utf8',
    ).toString('base64url');
  }

  /** Decodes an opaque `base64url("<epochMs>:<uuid>")` keyset cursor. */
  private decodeCursor(cursor: string | undefined): Cursor | undefined {
    if (cursor === undefined || cursor === '') {
      return undefined;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('invalid cursor');
    }
    const sep = decoded.indexOf(':');
    if (sep <= 0) {
      throw new BadRequestException('invalid cursor');
    }
    const epochMs = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isInteger(epochMs) || id === '') {
      throw new BadRequestException('invalid cursor');
    }
    return { createdAt: new Date(epochMs), id };
  }
}

/* -------------------------------------------------------------------------- */
/* Row → contract projection                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a row must be masked for the actor: another member's `summary_only`
 * row hides its merchant/memo but still reports its amounts.
 */
function maskedFor(txn: schema.CardTransaction, actorMemberId: string): boolean {
  return txn.memberId !== actorMemberId && txn.visibility === 'summary_only';
}

/** Projects a transaction row (+ category slug) to its contract summary. */
export function buildSummary(
  txn: schema.CardTransaction,
  categorySlug: string | null,
  masked: boolean,
): TransactionSummary {
  return {
    id: txn.id,
    householdId: txn.householdId,
    memberId: txn.memberId,
    cardId: txn.cardId,
    transactionType: txn.transactionType,
    status: txn.status,
    amount: txn.amount,
    cancelledAmount: txn.cancelledAmount,
    netAmount: txn.netAmount,
    currency: txn.currency,
    originalAmount: txn.originalAmount,
    originalCurrency: txn.originalCurrency,
    exchangeRate: txn.exchangeRate,
    merchantRaw: masked ? null : txn.merchantRaw,
    merchantNormalized: masked ? null : txn.merchantNormalized,
    categoryId: txn.categoryId,
    categorySlug,
    approvedAt: txn.approvedAt ? txn.approvedAt.toISOString() : null,
    cancelledAt: txn.cancelledAt ? txn.cancelledAt.toISOString() : null,
    installmentMonths: txn.installmentMonths,
    parentTransactionId: txn.parentTransactionId,
    visibility: txn.visibility,
    memo: masked ? null : txn.memo,
    masked,
    excludedAt: txn.excludedAt ? txn.excludedAt.toISOString() : null,
    createdAt: txn.createdAt.toISOString(),
  };
}

/** Coerces a driver-returned numeric aggregate (string | number) to an int. */
function toInt(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
