/**
 * 별칭 병합이 `merchant_category_rules`를 어떻게 옮길지 정하는 계획 + 적용.
 *
 * 왜 서비스에서 떼어냈나: 이 판단이 틀리면 사용자가 손으로 확정한 카테고리가 조용히
 * 사라지고(P1-17), 그 사실은 몇 달 뒤 학습 데이터셋이 깨질 때에야 드러난다. DB 없이
 * 전 분기를 고정할 수 있어야 회귀를 막을 수 있어서 순수 함수로 뽑았다.
 *
 * 규칙과 그 근거:
 *
 * 1. **사람 확정이 모델 예측을 이긴다.** 대표에 이미 규칙이 있어도 그것이
 *    `model_prediction`이면 별칭 쪽 `human_confirmed`로 덮는다. 종전 코드는 대표에
 *    규칙이 있으면 승격 자체를 건너뛰고 별칭 규칙을 통째로 지웠다 — 사람의 확정이
 *    사라지고 모델 추측이 남는 정확히 반대의 결과였다.
 *
 * 2. **사람 확정이 서로 다른 카테고리로 둘 이상이면 시스템이 고르지 않는다.**
 *    병합을 거부하고 무엇과 무엇이 충돌하는지 돌려준다(ADR-0029 `merged`와 같은 원칙 —
 *    사용자의 판단을 시스템이 임의로 승계하면, 그 결과가 틀렸을 때 되돌릴 근거가
 *    남지 않는다). 대표 자신의 사람 확정도 같은 자격의 주장으로 센다.
 *
 * 3. **별칭 쪽 `human_confirmed` 규칙은 지우지 않는다.** `feedback_events`는
 *    append-only라 규칙만 지우면 계보(`targetId = sha256(householdId, merchantPattern)`)가
 *    짝을 잃고, 데이터셋 빌드가 `merchant dataset lineage is incomplete or stale`로
 *    영영 실패한다. 남겨도 새 거래에는 영향이 없다 — 승격 경로가 별칭을 대표로 먼저
 *    해석한 뒤 규칙을 찾기 때문이다. 오히려 별칭을 해제하면 그 결정이 그대로 되살아난다.
 *
 * 4. **`dataset_snapshot_items`가 참조하는 규칙도 지우지 않는다.** FK가 ON DELETE
 *    no action이라 지우는 순간 23503으로 별칭 등록 트랜잭션 전체가 롤백된다.
 *
 * 5. **`merchant_pattern`을 rename하지 않는다.** targetId가 패턴 해시라 rename은
 *    feedback 계보를 끊는다(학습 준비도가 `collect_labels`로 떨어진다). 대표 패턴으로
 *    새로 upsert하고, 사람 확정을 승계할 때만 `feedback_events`를 **같은 트랜잭션에서
 *    짝으로** 남긴다. 모델 예측을 옮길 때는 feedback을 쓰지 않는다 — 확인하지 않은
 *    추측을 사람 확정으로 둔갑시키면 학습 gold가 오염된다(ADR-0019 §4).
 */
import { schema, type Db } from '@family/database';
import { createMerchantCategoryTargetId } from '@family/shared';
import { and, eq, inArray } from 'drizzle-orm';

/** 트랜잭션 핸들 — 다른 서비스와 같은 방식으로 유도한다. */
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export type MerchantRuleSource =
  | 'human_confirmed'
  | 'model_prediction'
  | 'system_rule';

/** 계획에 필요한 `merchant_category_rules` 한 행. */
export interface MerchantRuleRow {
  id: string;
  merchantPattern: string;
  categoryId: string;
  source: MerchantRuleSource;
  predictionTraceId: string | null;
  confirmedAt: Date | null;
  createdBy: string | null;
  updatedAt: Date;
}

export interface MerchantRuleMergeInput {
  /** 최종 대표 패턴. */
  canonical: string;
  /** 대표 + 별칭 패턴들의 규칙 전부(순서 무관). 대표가 아닌 패턴은 전부 별칭으로 본다. */
  rules: readonly MerchantRuleRow[];
  /** `dataset_snapshot_items`가 참조 중인 규칙 id — 지우면 23503으로 롤백된다. */
  snapshotReferencedRuleIds?: ReadonlySet<string>;
  /**
   * 사람이 확정한 카테고리가 갈렸을 때 **사용자가 고른 답**.
   *
   * 이것이 있으면 충돌을 거부하지 않고 이 카테고리로 통일한다. 원칙을 깨지 않는 이유:
   * 시스템이 임의로 고르는 것이 아니라 **사람이 고른 것**이다. ADR-0029가 금지한 것은
   * 전자다 — 시스템이 고르면 그 판단이 틀렸을 때 되돌릴 근거가 남지 않는다.
   *
   * 충돌한 카테고리 중 하나여야 한다. 무관한 카테고리를 받으면 사용자가 보지 못한
   * 제3의 답이 되므로 {@link CATEGORY_NOT_IN_CONFLICT}로 거부한다.
   */
  resolveCategoryId?: string;
}

/**
 * `resolveCategoryId`가 충돌 목록에 없을 때의 표식.
 *
 * 충돌을 그대로 돌려주되 이 필드로 "고른 답이 후보 밖"임을 알린다 — 호출부가
 * 일반 충돌과 구분해 다른 메시지를 낼 수 있어야 한다.
 */
export const CATEGORY_NOT_IN_CONFLICT = 'category_not_in_conflict' as const;

/** "이 패턴은 이 카테고리다"라는 사람의 확정 하나. */
export interface MerchantRuleClaim {
  merchantPattern: string;
  categoryId: string;
}

export interface MerchantRuleMergeConflict {
  /**
   * 사용자가 고른 `resolveCategoryId`가 충돌 후보 밖이라 거부된 경우.
   * 없으면 평범한 충돌(고른 답이 아직 없음)이다.
   */
  reason?: typeof CATEGORY_NOT_IN_CONFLICT;
  /** 충돌한 사람 확정 전부(패턴 오름차순) — 사용자에게 그대로 보여줄 근거다. */
  claims: MerchantRuleClaim[];
  /** 충돌한 카테고리 id(중복 제거). */
  categoryIds: string[];
}

export interface MerchantCanonicalRuleUpsert {
  categoryId: string;
  source: MerchantRuleSource;
  predictionTraceId: string | null;
  confirmedAt: Date | null;
  createdBy: string | null;
  /** 이 결정이 어느 패턴에서 왔는지(로그·테스트 근거). */
  fromPattern: string;
  /** true면 같은 트랜잭션에서 `feedback_events`를 짝으로 남겨야 한다. */
  writeFeedbackEvent: boolean;
}

/** 별칭 규칙을 지우지 않고 남긴 이유. */
export type KeptMerchantRuleReason = 'human_lineage' | 'dataset_snapshot';

export interface KeptMerchantRule {
  id: string;
  merchantPattern: string;
  reason: KeptMerchantRuleReason;
}

export interface MerchantRuleMergePlan {
  /** null이 아니면 병합을 거부해야 한다 — 나머지 필드는 전부 비어 있다. */
  conflict: MerchantRuleMergeConflict | null;
  canonicalUpsert: MerchantCanonicalRuleUpsert | null;
  deleteRuleIds: string[];
  keptRules: KeptMerchantRule[];
}

/**
 * 같은 후보가 여럿일 때의 결정 순서 — 최근 갱신 우선, 동률이면 패턴 사전순.
 * 사전순 tiebreak가 없으면 입력 순서(=DB 반환 순서)에 결과가 흔들려 재현이 안 된다.
 */
function pickLatest(
  rules: readonly MerchantRuleRow[],
): MerchantRuleRow | null {
  if (rules.length === 0) return null;
  return [...rules].sort(
    (a, b) =>
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      a.merchantPattern.localeCompare(b.merchantPattern),
  )[0]!;
}

/** 규칙 병합 계획. DB를 만지지 않는다. */
export function planMerchantRuleMerge(
  input: MerchantRuleMergeInput,
): MerchantRuleMergePlan {
  const referenced = input.snapshotReferencedRuleIds ?? new Set<string>();
  const canonicalRule =
    input.rules.find((rule) => rule.merchantPattern === input.canonical) ?? null;
  const aliasRules = input.rules.filter(
    (rule) => rule.merchantPattern !== input.canonical,
  );

  // 사람 확정 주장 전부 — 대표 자신의 확정도 같은 자격으로 센다.
  const humanRules = [
    ...(canonicalRule?.source === 'human_confirmed' ? [canonicalRule] : []),
    ...aliasRules.filter((rule) => rule.source === 'human_confirmed'),
  ];
  const humanCategoryIds = [...new Set(humanRules.map((r) => r.categoryId))];

  // 사람 확정이 갈렸는데 사용자가 답을 골랐으면, 그 답으로 통일한다.
  // 고른 답이 충돌 후보 밖이면 진행하지 않는다 — 사용자가 보지 못한 제3의 카테고리로
  // 과거 거래가 옮겨가면 그것은 확정이 아니라 사고다.
  const resolved =
    humanCategoryIds.length > 1 && input.resolveCategoryId !== undefined
      ? humanCategoryIds.includes(input.resolveCategoryId)
        ? input.resolveCategoryId
        : CATEGORY_NOT_IN_CONFLICT
      : null;

  if (humanCategoryIds.length > 1 && resolved === null) {
    // 규칙 2. 아무것도 지우지 않고, 아무것도 옮기지 않는다.
    return {
      conflict: {
        claims: humanRules
          .map((rule) => ({
            merchantPattern: rule.merchantPattern,
            categoryId: rule.categoryId,
          }))
          .sort((a, b) => a.merchantPattern.localeCompare(b.merchantPattern)),
        categoryIds: [...humanCategoryIds].sort(),
      },
      canonicalUpsert: null,
      deleteRuleIds: [],
      keptRules: [],
    };
  }

  if (resolved === CATEGORY_NOT_IN_CONFLICT) {
    return {
      conflict: {
        reason: CATEGORY_NOT_IN_CONFLICT,
        claims: humanRules
          .map((rule) => ({
            merchantPattern: rule.merchantPattern,
            categoryId: rule.categoryId,
          }))
          .sort((a, b) => a.merchantPattern.localeCompare(b.merchantPattern)),
        categoryIds: [...humanCategoryIds].sort(),
      },
      canonicalUpsert: null,
      deleteRuleIds: [],
      keptRules: [],
    };
  }

  let canonicalUpsert: MerchantCanonicalRuleUpsert | null = null;
  if (humanRules.length > 0 && typeof resolved === 'string') {
    // 규칙 1-b. 충돌을 사용자가 풀었다 — 고른 카테고리를 대표에 확정한다.
    //
    // 다른 카테고리를 주장하던 별칭 규칙은 **지우지 않는다**(아래 `keptRules`의
    // `human_lineage`). 사용자가 그때 그렇게 판단했다는 사실 자체는 학습 계보이고,
    // 지금 답이 갈렸다고 과거 판단을 없던 일로 만들 이유가 없다.
    const winner = pickLatest(
      humanRules.filter((rule) => rule.categoryId === resolved),
    );
    if (winner && canonicalRule?.categoryId !== resolved) {
      canonicalUpsert = {
        categoryId: resolved,
        source: 'human_confirmed',
        predictionTraceId: null,
        confirmedAt: winner.confirmedAt,
        createdBy: winner.createdBy,
        fromPattern: winner.merchantPattern,
        writeFeedbackEvent: true,
      };
    }
  } else if (humanRules.length > 0) {
    // 규칙 1. 대표가 이미 사람 확정을 들고 있으면(카테고리가 하나임은 위에서 확인)
    // 할 일이 없다. 아니면 별칭의 사람 확정으로 덮는다.
    if (canonicalRule?.source !== 'human_confirmed') {
      const winner = pickLatest(
        aliasRules.filter((rule) => rule.source === 'human_confirmed'),
      );
      if (winner) {
        canonicalUpsert = {
          categoryId: winner.categoryId,
          source: 'human_confirmed',
          // 사람이 확정한 규칙은 특정 예측의 산물이 아니다(transaction.service와 동일).
          predictionTraceId: null,
          confirmedAt: winner.confirmedAt,
          createdBy: winner.createdBy,
          fromPattern: winner.merchantPattern,
          writeFeedbackEvent: true,
        };
      }
    }
  } else if (!canonicalRule) {
    // 사람 확정이 하나도 없다. 대표에 규칙이 없을 때만 최근 별칭 규칙을 복사한다
    // (대표에 이미 추측이 있으면 그대로 둔다 — 종전 동작과 같다).
    // source를 올리지 않는다: 확인하지 않은 추측을 gold로 만들지 않는다(ADR-0019 §4).
    const winner = pickLatest(aliasRules);
    if (winner) {
      canonicalUpsert = {
        categoryId: winner.categoryId,
        source: winner.source,
        predictionTraceId: winner.predictionTraceId,
        confirmedAt: winner.confirmedAt,
        createdBy: winner.createdBy,
        fromPattern: winner.merchantPattern,
        writeFeedbackEvent: false,
      };
    }
  }

  const deleteRuleIds: string[] = [];
  const keptRules: KeptMerchantRule[] = [];
  for (const rule of aliasRules) {
    if (rule.source === 'human_confirmed') {
      // 규칙 3 — 계보가 붙어 있다.
      keptRules.push({
        id: rule.id,
        merchantPattern: rule.merchantPattern,
        reason: 'human_lineage',
      });
      continue;
    }
    if (referenced.has(rule.id)) {
      // 규칙 4 — 지우면 트랜잭션 전체가 23503으로 롤백된다.
      keptRules.push({
        id: rule.id,
        merchantPattern: rule.merchantPattern,
        reason: 'dataset_snapshot',
      });
      continue;
    }
    deleteRuleIds.push(rule.id);
  }

  return { conflict: null, canonicalUpsert, deleteRuleIds, keptRules };
}

export interface ApplyMerchantRuleMergeParams {
  householdId: string;
  canonical: string;
  /** 병합을 실행한 사용자 — feedback의 행위자다. */
  actorUserId: string;
  plan: MerchantRuleMergePlan;
  now: Date;
}

/**
 * 계획을 실제로 쓴다. 호출자는 반드시 별칭 upsert·거래 백필과 **같은 트랜잭션**에서
 * 부른다 — 규칙만 쓰이고 feedback이 빠지면 데이터셋 빌드가 400으로 죽고, feedback만
 * 쓰이면 미래 승격이 옛 카테고리를 계속 쓴다.
 */
export async function applyMerchantRuleMerge(
  tx: DbTransaction,
  params: ApplyMerchantRuleMergeParams,
): Promise<{ rulesRemoved: number }> {
  const { householdId, canonical, actorUserId, plan, now } = params;
  if (plan.conflict) {
    // 거부된 병합을 실수로 적용하면 사용자의 확정 하나가 소리 없이 사라진다.
    throw new Error('cannot apply a merchant rule merge plan that conflicts');
  }

  const upsert = plan.canonicalUpsert;
  if (upsert) {
    // 사람 확정인데 `confirmed_at`이 비어 있으면(과거 데이터 이상) 데이터셋 빌더의
    // `confirmed_at is not null` 필터에서 탈락한다 — 승계 시각으로 채워 계보를 지킨다.
    const confirmedAt =
      upsert.confirmedAt ??
      (upsert.source === 'human_confirmed' ? now : null);
    await tx
      .insert(schema.merchantCategoryRules)
      .values({
        householdId,
        merchantPattern: canonical,
        categoryId: upsert.categoryId,
        source: upsert.source,
        predictionTraceId: upsert.predictionTraceId,
        confirmedAt,
        createdBy: upsert.createdBy,
      })
      // 유니크 제약이 (household_id, merchant_pattern) 하나뿐이라 다른 조합을 주면
      // 런타임 오류다.
      .onConflictDoUpdate({
        target: [
          schema.merchantCategoryRules.householdId,
          schema.merchantCategoryRules.merchantPattern,
        ],
        set: {
          categoryId: upsert.categoryId,
          source: upsert.source,
          predictionTraceId: upsert.predictionTraceId,
          confirmedAt,
          createdBy: upsert.createdBy,
          updatedAt: now,
        },
      });

    if (upsert.writeFeedbackEvent) {
      // targetId는 반드시 공용 헬퍼로 만든다 — SQL 백필(0027)과 형식이 갈리면
      // 계보가 통째로 끊긴다.
      await tx.insert(schema.feedbackEvents).values({
        householdId,
        targetType: 'merchant-category',
        targetId: createMerchantCategoryTargetId(householdId, canonical),
        labelSchemaVersion: 'merchant-category-v1',
        label: { categoryId: upsert.categoryId },
        source: 'human_confirmed',
        actorUserId,
        // 데이터셋 빌더는 target별 **최신** feedback을 규칙과 대조한다. 승계 시각을
        // 써야 새 규칙과 짝이 맞는다(원래 확정 시각을 쓰면 옛 이벤트에 밀린다).
        occurredAt: now,
      });
    }
  }

  if (plan.deleteRuleIds.length === 0) return { rulesRemoved: 0 };
  const removed = await tx
    .delete(schema.merchantCategoryRules)
    .where(
      and(
        eq(schema.merchantCategoryRules.householdId, householdId),
        inArray(schema.merchantCategoryRules.id, plan.deleteRuleIds),
      ),
    )
    .returning({ id: schema.merchantCategoryRules.id });
  return { rulesRemoved: removed.length };
}
