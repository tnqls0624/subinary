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
import { revokeTrainingRuns, schema, type Db } from '@family/database';
import {
  assertKrwInteger,
  createMerchantCategoryTargetId,
  DEFAULT_TIMEZONE,
  MERCHANT_TRAINING_READINESS,
} from '@family/shared';

import { DB } from '../database/database.constants';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';

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
      this.visibilityScope(actor.memberId),
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
      // 요약 합계는 KRW 전용(amount=minor units라 외화 혼입 시 오염). 응답에도
      // currency:'KRW' 마커를 내려 클라이언트가 ₩ 포맷을 확정하게 한다.
      eq(schema.cardTransactions.currency, 'KRW'),
      this.visibilityScope(actor.memberId),
      gte(schema.cardTransactions.approvedAt, from),
      lt(schema.cardTransactions.approvedAt, to),
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
    if (input.amount !== undefined) {
      // 금액 수정은 취소 연결이 없는 단순 거래에서만(netAmount 불변식 보호).
      if (current.cancelledAmount !== 0 || current.parentTransactionId !== null) {
        throw new BadRequestException(
          '취소가 연결된 거래는 금액을 수정할 수 없어요',
        );
      }
      assertKrwInteger(input.amount);
      updates.amount = input.amount;
      // 승인은 net = amount(취소 없음), 취소 행은 net이 항상 0.
      updates.netAmount = current.transactionType === 'approval' ? input.amount : 0;
    }
    if (input.occurredAt !== undefined) {
      const occurred = new Date(input.occurredAt);
      if (current.transactionType === 'approval') {
        updates.approvedAt = occurred;
      } else {
        updates.cancelledAt = occurred;
      }
    }

    // The category change and the (optional) rule upsert are atomic.
    const effectiveMerchant =
      input.merchantNormalized ?? current.merchantNormalized;

    await this.db.transaction(async (tx) => {
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

        // 이미 Gold snapshot에 포함된 규칙의 label이 바뀌면 과거 artifact는
        // immutable하게 보존하되 평가 근거로는 즉시 revoke한다.
        if (previousRule && previousRule.categoryId !== input.categoryId) {
          const snapshotRows = await tx
            .select({ id: schema.datasetSnapshotItems.datasetSnapshotId })
            .from(schema.datasetSnapshotItems)
            .where(
              eq(
                schema.datasetSnapshotItems.merchantCategoryRuleId,
                previousRule.id,
              ),
            );
          const snapshotIds = [
            ...new Set(snapshotRows.map((snapshot) => snapshot.id)),
          ];
          if (snapshotIds.length > 0) {
            const revokedSnapshots = await tx
              .update(schema.datasetSnapshots)
              .set({
                status: 'revoked',
                revokedAt: now,
                revocationReason: 'merchant_category_rule_changed',
                updatedAt: now,
              })
              .where(
                and(
                  inArray(schema.datasetSnapshots.id, snapshotIds),
                  ne(schema.datasetSnapshots.status, 'revoked'),
                ),
              )
              .returning({ id: schema.datasetSnapshots.id });
            if (revokedSnapshots.length > 0) {
              await revokeTrainingRuns(
                tx,
                revokedSnapshots.map((snapshot) => snapshot.id),
                'merchant_category_rule_changed',
                now,
              );
              const revokedEvaluations = await tx
                .update(schema.evaluationRuns)
                .set({
                  status: 'revoked',
                  revokedAt: now,
                  revocationReason: 'merchant_category_rule_changed',
                })
                .where(
                  and(
                    inArray(
                      schema.evaluationRuns.datasetSnapshotId,
                      revokedSnapshots.map((snapshot) => snapshot.id),
                    ),
                    ne(schema.evaluationRuns.status, 'revoked'),
                  ),
                )
                .returning({ id: schema.evaluationRuns.id });
              if (revokedEvaluations.length > 0) {
                const suspendedAliases = await tx
                  .update(schema.modelAliases)
                  .set({
                    suspendedAt: now,
                    suspensionReason: 'evaluation_revoked',
                    updatedAt: now,
                  })
                  .where(
                    inArray(
                      schema.modelAliases.evaluationRunId,
                      revokedEvaluations.map((evaluation) => evaluation.id),
                    ),
                  )
                  .returning({ id: schema.modelAliases.id });
                if (suspendedAliases.length > 0) {
                  await tx
                    .update(schema.modelCanaryRuns)
                    .set({
                      status: 'superseded',
                      decisionReason: 'evaluation_revoked',
                      lastEvaluatedAt: now,
                      updatedAt: now,
                    })
                    .where(
                      and(
                        inArray(
                          schema.modelCanaryRuns.modelAliasId,
                          suspendedAliases.map((alias) => alias.id),
                        ),
                        eq(schema.modelCanaryRuns.status, 'monitoring'),
                      ),
                    );
                }
              }
            }
          }
        }
      }
    });

    const row = await this.loadSummaryRow(id);
    // 편집 결과를 가족의 다른 열린 화면에 전파(best-effort, fire-and-forget).
    void this.realtimePublisher.publish(row.txn.householdId);
    return buildSummary(row.txn, row.categorySlug, false);
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

    const approval = await this.loadTransaction(input.approvalTransactionId);
    if (approval.householdId !== cancellation.householdId) {
      throw new BadRequestException('transactions belong to different households');
    }
    if (approval.transactionType !== 'approval') {
      throw new BadRequestException('target is not an approval transaction');
    }
    // amount는 minor units라 통화가 다르면 뺄셈/비교가 무의미하다(USD 취소를 KRW
    // 승인에 연결 등). 동일 통화 거래끼리만 연결을 허용한다.
    if (approval.currency !== cancellation.currency) {
      throw new BadRequestException('transactions have different currencies');
    }

    const remaining = approval.amount - approval.cancelledAmount;
    if (cancellation.amount > remaining) {
      throw new BadRequestException(
        'cancellation amount exceeds remaining approved balance',
      );
    }

    const newCancelled = approval.cancelledAmount + cancellation.amount;
    assertKrwInteger(newCancelled);
    const newNet = approval.amount - newCancelled;
    assertKrwInteger(newNet);
    const newStatus: TxnStatus =
      newCancelled >= approval.amount ? 'cancelled' : 'partially_cancelled';

    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.cardTransactions)
        .set({
          cancelledAmount: newCancelled,
          netAmount: newNet,
          status: newStatus,
          updatedAt: now,
        })
        .where(eq(schema.cardTransactions.id, approval.id));

      await tx
        .update(schema.cardTransactions)
        .set({
          parentTransactionId: approval.id,
          status: 'approved',
          updatedAt: now,
        })
        .where(eq(schema.cardTransactions.id, cancellation.id));
    });

    const row = await this.loadSummaryRow(approval.id);
    // 취소↔승인 연결을 가족의 다른 열린 화면에 전파(best-effort).
    void this.realtimePublisher.publish(row.txn.householdId);
    return buildSummary(row.txn, row.categorySlug, false);
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
    return buildSummary(row.txn, row.categorySlug, false);
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
    return buildSummary(row.txn, row.categorySlug, false);
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
    return buildSummary(row.txn, row.categorySlug, false);
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
    return buildSummary(row.txn, row.categorySlug, false);
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

    if (current.transactionType === 'approval') {
      const [child] = await this.db
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

    await this.db.transaction(async (tx) => {
      // 연결된 취소를 지우면 부모 승인 잔액을 역산 복원한다.
      if (
        current.transactionType === 'cancellation' &&
        current.parentTransactionId
      ) {
        const [approval] = await tx
          .select()
          .from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.id, current.parentTransactionId))
          .limit(1);
        if (approval) {
          const newCancelled = Math.max(
            0,
            approval.cancelledAmount - current.amount,
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

  /**
   * The visibility WHERE fragment (§1.4): own rows ∪ `household`/`summary_only`.
   * Another member's `private` rows are excluded; `summary_only` rows are kept
   * here and masked at projection time.
   */
  private visibilityScope(actorMemberId: string): SQL {
    const scope = or(
      eq(schema.cardTransactions.memberId, actorMemberId),
      inArray(schema.cardTransactions.visibility, ['household', 'summary_only']),
    );
    // Both operands are defined, so `or` always yields a SQL fragment.
    return scope as SQL;
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
