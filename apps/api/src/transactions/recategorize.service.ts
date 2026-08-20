/**
 * 카테고리 소급 재분류 — "이 가맹점, 과거 것도 같이 바꿔줘".
 *
 * ## 왜 필요한가 (실측)
 *
 * 규칙은 **미래 거래에만** 적용된다(`transaction.service.ts`가 `never retroactive`로
 * 못 박은 의도적 안전장치다 — 규칙 하나가 과거를 조용히 재분류하면 지난달 통계가
 * 사용자 모르게 바뀐다). 그런데 그 안전장치에는 **대안이 없었다.** 남은 선택지가
 * "하나씩 다 고치기"뿐이라 실제로 그렇게 쓰이고 있었다:
 *
 *   쿠팡 4회/3거래 · 모바일티머니선불 4회/3거래 · 교정 110회/93거래(전체의 절반)
 *   교정한 가맹점 82개는 **전부 규칙을 이미 갖고 있었다.**
 *
 * 즉 빠진 것은 소급 적용 자체가 아니라 **소급을 사용자가 보고 결정할 방법**이다.
 *
 * ## 이 서비스가 지키는 것
 *
 * 1. **미리보기와 적용이 같은 함수로 대상을 고른다**({@link collectTargets}).
 *    조건을 두 벌로 적으면 사용자가 동의한 숫자와 실제 결과가 갈리고, 그러면
 *    되돌리기 이전에 신뢰가 깨진다.
 * 2. **카테고리 컬럼만 쓴다.** 금액 컬럼은 ADR-0027이 세운 초크포인트를 통과해야
 *    하고, 여기는 그 경로가 아니다.
 * 3. **읽기보다 좁게 쓴다**({@link mutableByActor}). 가맹점 이름을 키로 남의 행을
 *    UPDATE하면 `summary_only`가 감추던 이름-존재 결합이 되살아난다.
 * 4. **되돌릴 수 있다.** 적용 단위를 batch로 남기고 행별 이전 값을 보존한다.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type {
  CategoryRuleList,
  RecategorizeBatchList,
  RecategorizeMonth,
  RecategorizePreview,
  RecategorizeRequest,
  RecategorizeResponse,
  RecategorizeRevertResponse,
} from '@family/contracts';
import {
  mutableByActor,
  revokeMerchantRuleLineage,
  schema,
  visibilityScope,
  type Db,
} from '@family/database';
import {
  buildMerchantAliasIndex,
  createMerchantCategoryTargetId,
  normalizeMerchant,
  resolveCanonicalMerchant,
} from '@family/shared';

import { DB } from '../database/database.constants';

/** 가구당 거래가 수백 건 규모라는 전제 위의 상한. 넘으면 적용을 거부한다. */
const MAX_TARGETS = 500;

/** 이 역할은 타인의 `household` 거래도 재분류할 수 있다. */
const PRIVILEGED_ROLES = ['owner', 'admin'] as const;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 서울 벽시계 기준 `YYYY-MM`. 달 경계는 사용자의 달과 같아야 한다. */
function seoulMonth(at: Date): string {
  const shifted = new Date(at.getTime() + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface Actor {
  memberId: string;
  privileged: boolean;
}

interface Target {
  id: string;
  categoryId: string | null;
  netAmount: number;
  at: Date;
}

@Injectable()
export class RecategorizeService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ---------------------------------------------------------------------- */
  /* 대상 선정 — 미리보기와 적용이 공유하는 단 하나의 정의                     */
  /* ---------------------------------------------------------------------- */

  /**
   * 같은 가맹점의 재분류 대상 거래를 고른다.
   *
   * 신원은 **원문에서 다시 해석**한다(`merchant_raw` 우선). `merchant_normalized`는
   * 별칭 등록 시 백필된 값이라 백필이 밀리거나 별칭 미적용 경로(수동 입력·검토 확정)로
   * 들어온 행은 옛 이름으로 남아 있고, 저장된 값만 등호 비교하면 그런 행이 통째로
   * 빠진다. 원문이 없는 수기 거래만 저장된 값을 믿는다 — 그 행은 신원이 그것뿐이다.
   */
  private async collectTargets(
    householdId: string,
    actor: Actor,
    merchant: string,
  ): Promise<{ canonical: string; targets: Target[] }> {
    const aliasIndex = buildMerchantAliasIndex(
      await this.db
        .select({
          householdId: schema.merchantAliases.householdId,
          alias: schema.merchantAliases.alias,
          canonical: schema.merchantAliases.canonical,
        })
        .from(schema.merchantAliases)
        .where(eq(schema.merchantAliases.householdId, householdId)),
    );

    const canonical =
      resolveCanonicalMerchant(merchant, householdId, aliasIndex) ??
      normalizeMerchant(merchant);
    if (canonical.length === 0) {
      throw new BadRequestException('가맹점 이름이 비어 있어요');
    }

    const rows = await this.db
      .select({
        id: schema.cardTransactions.id,
        categoryId: schema.cardTransactions.categoryId,
        netAmount: schema.cardTransactions.netAmount,
        approvedAt: schema.cardTransactions.approvedAt,
        createdAt: schema.cardTransactions.createdAt,
        merchantRaw: schema.cardTransactions.merchantRaw,
        merchantNormalized: schema.cardTransactions.merchantNormalized,
      })
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          isNull(schema.cardTransactions.excludedAt),
          // 하드 플로어 — 볼 수 없는 것은 세지도 바꾸지도 않는다.
          visibilityScope(actor.memberId),
          // 쓰기 상한 — 읽기보다 좁다(타인 summary_only 제외).
          mutableByActor(actor.memberId, actor.privileged),
        ),
      );

    const targets: Target[] = [];
    for (const row of rows) {
      const rowCanonical = row.merchantRaw
        ? resolveCanonicalMerchant(row.merchantRaw, householdId, aliasIndex)
        : row.merchantNormalized;
      if (rowCanonical !== canonical) continue;
      targets.push({
        id: row.id,
        categoryId: row.categoryId,
        netAmount: row.netAmount,
        // 집계 창과 같은 규약 — approvedAt이 없어도 빠지지 않는다.
        at: row.approvedAt ?? row.createdAt,
      });
    }
    return { canonical, targets };
  }

  /* ---------------------------------------------------------------------- */
  /* 미리보기                                                                */
  /* ---------------------------------------------------------------------- */

  async preview(
    userId: string,
    householdId: string,
    merchant: string,
    categoryId: string,
  ): Promise<RecategorizePreview> {
    const actor = await this.requireMembership(householdId, userId);
    const toCategory = await this.requireCategory(categoryId, householdId);
    const { canonical, targets } = await this.collectTargets(householdId, actor, merchant);

    // 이미 그 카테고리인 거래는 바꿀 것이 없다 — 건수에 넣으면 "3건 바꿈"이라 해놓고
    // 실제로는 1건만 달라져 사용자가 본 숫자와 결과가 갈린다.
    const pending = targets.filter((t) => t.categoryId !== toCategory.id);

    const fromIds = [...new Set(pending.map((t) => t.categoryId).filter((v): v is string => v !== null))];
    const fromCategories = fromIds.length
      ? await this.db
          .select({
            id: schema.expenseCategories.id,
            name: schema.expenseCategories.name,
            isTransfer: schema.expenseCategories.isTransfer,
          })
          .from(schema.expenseCategories)
          .where(inArray(schema.expenseCategories.id, fromIds))
      : [];

    /**
     * 자산이동 경계를 넘는가.
     *
     * 자산이동은 지출 합계에서 빠진다(ADR-0025). 그래서 일반 ↔ 자산이동 사이를 옮기면
     * **총지출이 실제로 변한다** — "카테고리만 바꾸니 총액은 그대로"라는 전제가 여기서만
     * 거짓이 되므로 화면이 다른 문장으로 경고해야 한다. 미분류(NULL)는 지출로 세므로
     * 일반 카테고리와 같은 쪽으로 본다.
     */
    const fromTransferFlags = new Set<boolean>(
      pending.map((t) => {
        if (t.categoryId === null) return false;
        return fromCategories.find((c) => c.id === t.categoryId)?.isTransfer ?? false;
      }),
    );
    const transferBoundaryCrossed = [...fromTransferFlags].some(
      (flag) => flag !== toCategory.isTransfer,
    );

    const months = await this.buildMonths(
      householdId,
      pending,
      fromIds,
      toCategory.id,
      transferBoundaryCrossed,
    );

    const sorted = [...pending].sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      merchantCanonical: canonical,
      toCategoryId: toCategory.id,
      toCategoryName: toCategory.name,
      count: pending.length,
      amount: pending.reduce((sum, t) => sum + t.netAmount, 0),
      oldestAt: sorted[0]?.at.toISOString() ?? null,
      newestAt: sorted[sorted.length - 1]?.at.toISOString() ?? null,
      months,
      fromCategoryNames: [
        ...new Set(
          pending.map((t) =>
            t.categoryId === null
              ? '미분류'
              : (fromCategories.find((c) => c.id === t.categoryId)?.name ?? '미분류'),
          ),
        ),
      ],
      transferBoundaryCrossed,
      exceedsLimit: pending.length > MAX_TARGETS,
      limit: MAX_TARGETS,
    };
  }

  /**
   * 달별 요약 + 그 달 예산이 영향을 받는지.
   *
   * `budgetKnown`을 따로 두는 이유: 그 달에 예산 행 자체가 없으면 "영향 없음"이 아니라
   * "판단할 근거가 없음"이다. 둘을 같은 `false`로 내보내면 사용자가 잘못 안심한다.
   */
  private async buildMonths(
    householdId: string,
    pending: Target[],
    fromIds: string[],
    toCategoryId: string,
    transferBoundaryCrossed: boolean,
  ): Promise<RecategorizeMonth[]> {
    const buckets = new Map<string, { count: number; amount: number }>();
    for (const t of pending) {
      const key = seoulMonth(t.at);
      const bucket = buckets.get(key) ?? { count: 0, amount: 0 };
      bucket.count += 1;
      bucket.amount += t.netAmount;
      buckets.set(key, bucket);
    }
    if (buckets.size === 0) return [];

    const budgets = await this.db
      .select({
        scopeType: schema.budgets.scopeType,
        scopeRefId: schema.budgets.scopeRefId,
        effectiveMonth: schema.budgets.effectiveMonth,
      })
      .from(schema.budgets)
      .where(eq(schema.budgets.householdId, householdId));

    // 관심 스코프: from ∪ {to}. to 쪽이 더 중요하다 — 사용률이 올라가 초과를 유발한다.
    const watched = new Set([...fromIds, toCategoryId]);
    return [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([month, bucket]) => {
        const inMonth = budgets.filter((b) => b.effectiveMonth.slice(0, 7) === month);
        return {
          month,
          count: bucket.count,
          amount: bucket.amount,
          // 자산이동 경계를 넘으면 총지출이 바뀌므로 **모든 스코프**가 영향을 받는다.
          budgetAffected: transferBoundaryCrossed
            ? inMonth.length > 0
            : inMonth.some(
                (b) => b.scopeType === 'category' && b.scopeRefId !== null && watched.has(b.scopeRefId),
              ),
          budgetKnown: inMonth.length > 0,
        };
      });
  }

  /* ---------------------------------------------------------------------- */
  /* 적용                                                                    */
  /* ---------------------------------------------------------------------- */

  async apply(userId: string, input: RecategorizeRequest): Promise<RecategorizeResponse> {
    const actor = await this.requireMembership(input.householdId, userId);
    const toCategory = await this.requireCategory(input.categoryId, input.householdId);
    const { canonical, targets } = await this.collectTargets(
      input.householdId,
      actor,
      input.merchant,
    );
    const pending = targets.filter((t) => t.categoryId !== toCategory.id);

    if (pending.length > MAX_TARGETS) {
      throw new BadRequestException(
        `한 번에 ${MAX_TARGETS}건까지만 바꿀 수 있어요. 기간을 나눠서 정리해 주세요.`,
      );
    }
    /**
     * 사용자가 동의한 숫자와 지금 바꿀 숫자가 다르면 진행하지 않는다. 그 사이 새 거래가
     * 들어왔거나 다른 기기에서 분류가 바뀐 것이고, 다른 숫자로 밀어붙이면 되돌리기를
     * 만들어 둔 의미가 없다.
     */
    if (pending.length !== input.expectedCount) {
      throw new ConflictException(
        '그 사이 거래가 바뀌었어요. 다시 확인한 뒤 진행해 주세요.',
      );
    }
    if (pending.length === 0) {
      throw new BadRequestException('바꿀 거래가 없어요.');
    }

    const now = new Date();
    const batchId = await this.db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(schema.categoryRecategorizeBatches)
        .values({
          householdId: input.householdId,
          merchantCanonical: canonical,
          toCategoryId: toCategory.id,
          appliedCount: pending.length,
          appliedBy: userId,
          appliedAt: now,
        })
        .returning({ id: schema.categoryRecategorizeBatches.id });
      if (!batch) throw new Error('failed to create recategorize batch');

      // 이전 값은 **행별로** 남긴다 — 대상들의 현재 카테고리가 제각각(일부 NULL)이라
      // batch에 단일 from 컬럼을 두는 가정 자체가 거짓이다.
      await tx.insert(schema.categoryRecategorizeItems).values(
        pending.map((t) => ({
          batchId: batch.id,
          transactionId: t.id,
          previousCategoryId: t.categoryId,
        })),
      );

      /**
       * 카테고리 컬럼만 쓴다. `.set()`에 **리터럴**을 주는 것이 중요하다 — 변수를
       * 넘기면 금액 쓰기 아키텍처 스캐너가 컬럼을 판정하지 못해 `<dynamic>` 위반으로
       * 세고, 그 리포트는 이미 상한(12)에 닿아 있다.
       */
      await tx
        .update(schema.cardTransactions)
        .set({ categoryId: toCategory.id, updatedAt: now })
        .where(
          inArray(
            schema.cardTransactions.id,
            pending.map((t) => t.id),
          ),
        );

      // 사람이 확정한 라벨이므로 계보를 남긴다. 규칙만 쓰고 feedback을 빠뜨리면
      // 학습 데이터셋 빌드가 'lineage is incomplete or stale'로 실패한다.
      const targetId = createMerchantCategoryTargetId(input.householdId, canonical);
      const [previousRule] = await tx
        .select({
          id: schema.merchantCategoryRules.id,
          categoryId: schema.merchantCategoryRules.categoryId,
        })
        .from(schema.merchantCategoryRules)
        .where(
          and(
            eq(schema.merchantCategoryRules.householdId, input.householdId),
            eq(schema.merchantCategoryRules.merchantPattern, canonical),
          ),
        )
        .limit(1);

      await tx
        .insert(schema.merchantCategoryRules)
        .values({
          householdId: input.householdId,
          merchantPattern: canonical,
          categoryId: toCategory.id,
          source: 'human_confirmed',
          confirmedAt: now,
          createdBy: userId,
        })
        .onConflictDoUpdate({
          target: [
            schema.merchantCategoryRules.householdId,
            schema.merchantCategoryRules.merchantPattern,
          ],
          set: {
            categoryId: toCategory.id,
            source: 'human_confirmed',
            predictionTraceId: null,
            confirmedAt: now,
            createdBy: userId,
            updatedAt: now,
          },
        });

      await tx.insert(schema.feedbackEvents).values({
        householdId: input.householdId,
        targetType: 'merchant-category',
        targetId,
        labelSchemaVersion: 'merchant-category-v1',
        label: { categoryId: toCategory.id },
        source: 'human_confirmed',
        actorUserId: userId,
        occurredAt: now,
      });

      // 규칙 label이 실제로 바뀐 경우에만, **한 번만** 연쇄를 돈다.
      if (previousRule && previousRule.categoryId !== toCategory.id) {
        await revokeMerchantRuleLineage(
          tx,
          [previousRule.id],
          'merchant_category_rule_changed',
          now,
        );
      }
      return batch.id;
    });

    return { batchId, appliedCount: pending.length };
  }

  /* ---------------------------------------------------------------------- */
  /* 이력 · 되돌리기                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * 규칙 목록 + 각 규칙이 남긴 **소급 대상 건수**.
   *
   * 건수를 함께 내보내는 이유: 이 화면의 목적은 "무엇이 자동으로 붙는지 보는 것"만이
   * 아니라 "그래서 과거는 어떻게 되어 있는지"를 보여주는 것이다. 규칙과 다른 카테고리로
   * 남은 거래가 0건이면 소급할 것이 없고, 그때 버튼을 띄우면 눌러도 아무 일이 없다.
   *
   * 대상 판정은 {@link collectTargets}를 그대로 쓴다 — 목록의 숫자와 미리보기의 숫자가
   * 갈리면 사용자는 둘 중 어느 것도 믿지 않는다.
   */
  async listRules(userId: string, householdId: string): Promise<CategoryRuleList> {
    const actor = await this.requireMembership(householdId, userId);
    const rows = await this.db
      .select({
        id: schema.merchantCategoryRules.id,
        merchantPattern: schema.merchantCategoryRules.merchantPattern,
        categoryId: schema.merchantCategoryRules.categoryId,
        source: schema.merchantCategoryRules.source,
        confirmedAt: schema.merchantCategoryRules.confirmedAt,
        updatedAt: schema.merchantCategoryRules.updatedAt,
        categoryName: schema.expenseCategories.name,
      })
      .from(schema.merchantCategoryRules)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.expenseCategories.id, schema.merchantCategoryRules.categoryId),
      )
      .where(eq(schema.merchantCategoryRules.householdId, householdId))
      .orderBy(desc(schema.merchantCategoryRules.updatedAt))
      .limit(300);

    const items = [];
    for (const row of rows) {
      const { targets } = await this.collectTargets(householdId, actor, row.merchantPattern);
      items.push({
        id: row.id,
        merchantPattern: row.merchantPattern,
        categoryId: row.categoryId,
        categoryName: row.categoryName ?? null,
        source: row.source as 'human_confirmed' | 'model_prediction',
        confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
        staleTransactionCount: targets.filter((t) => t.categoryId !== row.categoryId).length,
      });
    }
    return { items };
  }

  /**
   * 규칙을 지운다 — 규칙만 지우고 **거래는 건드리지 않는다.**
   *
   * 이미 붙은 분류를 되돌리려면 되돌리기(batch)를 쓴다. 규칙 삭제가 과거 거래까지
   * 원복시키면 "자동 분류를 그만 쓰겠다"와 "지금까지의 분류를 취소하겠다"가 한 버튼에
   * 묶여, 둘 중 하나만 원한 사용자가 나머지를 잃는다.
   */
  async deleteRule(userId: string, ruleId: string): Promise<{ id: string }> {
    const [rule] = await this.db
      .select({
        id: schema.merchantCategoryRules.id,
        householdId: schema.merchantCategoryRules.householdId,
      })
      .from(schema.merchantCategoryRules)
      .where(eq(schema.merchantCategoryRules.id, ruleId))
      .limit(1);
    if (!rule) throw new NotFoundException('규칙을 찾을 수 없어요');
    await this.requireMembership(rule.householdId, userId);

    // 스냅샷이 참조하는 규칙은 FK(ON DELETE no action)가 막는다. 23503을 그대로
    // 흘리면 사용자는 영문 오류를 보므로 먼저 확인해 사람 말로 답한다.
    const [referenced] = await this.db
      .select({ ruleId: schema.datasetSnapshotItems.merchantCategoryRuleId })
      .from(schema.datasetSnapshotItems)
      .where(eq(schema.datasetSnapshotItems.merchantCategoryRuleId, ruleId))
      .limit(1);
    if (referenced) {
      throw new ConflictException(
        '학습 기록이 참조하는 규칙이라 지울 수 없어요. 카테고리를 바꾸는 것으로 대신해 주세요.',
      );
    }
    await this.db
      .delete(schema.merchantCategoryRules)
      .where(eq(schema.merchantCategoryRules.id, ruleId));
    return { id: ruleId };
  }

  async listBatches(userId: string, householdId: string): Promise<RecategorizeBatchList> {
    await this.requireMembership(householdId, userId);
    const rows = await this.db
      .select({
        id: schema.categoryRecategorizeBatches.id,
        merchantCanonical: schema.categoryRecategorizeBatches.merchantCanonical,
        appliedCount: schema.categoryRecategorizeBatches.appliedCount,
        appliedAt: schema.categoryRecategorizeBatches.appliedAt,
        revertedAt: schema.categoryRecategorizeBatches.revertedAt,
        revertedCount: schema.categoryRecategorizeBatches.revertedCount,
        categoryName: schema.expenseCategories.name,
      })
      .from(schema.categoryRecategorizeBatches)
      .leftJoin(
        schema.expenseCategories,
        eq(schema.expenseCategories.id, schema.categoryRecategorizeBatches.toCategoryId),
      )
      .where(eq(schema.categoryRecategorizeBatches.householdId, householdId))
      .orderBy(desc(schema.categoryRecategorizeBatches.appliedAt))
      .limit(50);

    return {
      items: rows.map((row) => ({
        id: row.id,
        merchantCanonical: row.merchantCanonical,
        toCategoryName: row.categoryName ?? null,
        appliedCount: row.appliedCount,
        appliedAt: row.appliedAt.toISOString(),
        revertedAt: row.revertedAt ? row.revertedAt.toISOString() : null,
        revertedCount: row.revertedCount,
        revertable: row.revertedAt === null,
      })),
    };
  }

  /**
   * 되돌린다 — 단, **적용 이후 사용자가 다시 고친 거래는 건너뛴다.**
   *
   * 복원 대상은 "현재 카테고리가 이 batch가 넣은 값과 같은 행"뿐이다. 그 조건이 없으면
   * 되돌리기가 사용자의 최신 판단을 덮어쓴다. 건너뛴 건수는 응답에 그대로 실어 보낸다.
   */
  async revert(userId: string, batchId: string): Promise<RecategorizeRevertResponse> {
    const [batch] = await this.db
      .select()
      .from(schema.categoryRecategorizeBatches)
      .where(eq(schema.categoryRecategorizeBatches.id, batchId))
      .limit(1);
    if (!batch) throw new NotFoundException('되돌릴 기록을 찾을 수 없어요');
    const actor = await this.requireMembership(batch.householdId, userId);
    if (!actor.privileged && batch.appliedBy !== userId) {
      throw new ForbiddenException('직접 적용한 기록만 되돌릴 수 있어요');
    }
    if (batch.revertedAt !== null) {
      throw new ConflictException('이미 되돌린 기록이에요');
    }

    const items = await this.db
      .select({
        transactionId: schema.categoryRecategorizeItems.transactionId,
        previousCategoryId: schema.categoryRecategorizeItems.previousCategoryId,
      })
      .from(schema.categoryRecategorizeItems)
      .where(eq(schema.categoryRecategorizeItems.batchId, batchId));

    const now = new Date();
    const reverted = await this.db.transaction(async (tx) => {
      let count = 0;
      for (const item of items) {
        const rows = await tx
          .update(schema.cardTransactions)
          .set({ categoryId: item.previousCategoryId, updatedAt: now })
          .where(
            and(
              eq(schema.cardTransactions.id, item.transactionId),
              // 적용 이후 다시 고친 행은 건드리지 않는다.
              eq(schema.cardTransactions.categoryId, batch.toCategoryId),
            ),
          )
          .returning({ id: schema.cardTransactions.id });
        count += rows.length;
      }
      await tx
        .update(schema.categoryRecategorizeBatches)
        .set({ revertedAt: now, revertedBy: userId, revertedCount: count })
        .where(eq(schema.categoryRecategorizeBatches.id, batchId));
      return count;
    });

    return { batchId, revertedCount: reverted, skippedCount: items.length - reverted };
  }

  /* ---------------------------------------------------------------------- */

  /** 비구성원에게는 가구 존재를 드러내지 않는 403을 준다(PRD §26). */
  private async requireMembership(householdId: string, userId: string): Promise<Actor> {
    const [member] = await this.db
      .select({
        memberId: schema.householdMembers.id,
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
    if (!member) throw new ForbiddenException('not a household member');
    return {
      memberId: member.memberId,
      privileged: (PRIVILEGED_ROLES as readonly string[]).includes(member.role),
    };
  }

  private async requireCategory(
    categoryId: string,
    householdId: string,
  ): Promise<{ id: string; name: string; isTransfer: boolean }> {
    const [category] = await this.db
      .select({
        id: schema.expenseCategories.id,
        name: schema.expenseCategories.name,
        isTransfer: schema.expenseCategories.isTransfer,
        householdId: schema.expenseCategories.householdId,
      })
      .from(schema.expenseCategories)
      .where(eq(schema.expenseCategories.id, categoryId))
      .limit(1);
    // 시스템 카테고리는 householdId가 NULL이고 모든 가구가 쓴다.
    if (!category || (category.householdId !== null && category.householdId !== householdId)) {
      throw new NotFoundException('카테고리를 찾을 수 없어요');
    }
    return { id: category.id, name: category.name, isTransfer: category.isTransfer };
  }
}
