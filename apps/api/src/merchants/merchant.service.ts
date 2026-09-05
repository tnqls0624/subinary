/**
 * 가맹점 아이덴티티 서비스 — 사용자가 확정한 "같은 가게" 판단(`merchant_aliases`).
 *
 * 왜 필요한가: `normalizeMerchant`는 결정적 규칙(괄호·법인격·지점 접미사)만 적용하므로
 * 로마자↔한글 음차(`GS25` vs `지에스25`)나 카드사가 **잘라 보낸 이름**
 * (`주식회사우아한형` vs `주식회사 우아한형제들`)은 합칠 수 없다. 실측에서 GS25 한
 * 브랜드가 6개 키로 쪼개져 서로 다른 카테고리(장보기 1 / 식비 5)로 학습됐고, 사용자가
 * 같은 가게를 6번 따로 확정해야 했다.
 *
 * 설계 규칙:
 * - 해석은 승격 경로에서 **1단계만** 한다. 체인(`A->B`, `B->C`)은 등록 시 평탄화한다.
 * - 등록은 과거 데이터도 백필한다 — "같은 가게"라고 했으면 지난 분석도 합쳐져야
 *   사용자 기대에 맞는다. 원문(`merchant_raw`)은 건드리지 않으므로 되돌릴 수 있다.
 */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  redactedMerchantLabel,
  schema,
  visibilityScope,
  type Db,
} from '@family/database';
import {
  createMerchantIdentityTargetId,
  findMerchantIdentityCandidates,
  findTruncationCandidates,
  normalizeMerchant,
} from '@family/shared';
import type {
  MerchantAliasCreateRequest,
  MerchantAliasCreateResponse,
  MerchantAliasDeleteResponse,
  MerchantIdentityCandidate,
  MerchantIdentityRejectRequest,
  MerchantIdentityRejectResponse,
  MerchantSummary,
} from '@family/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB } from '../database/database.constants';
import {
  CATEGORY_NOT_IN_CONFLICT,
  applyMerchantRuleMerge,
  planMerchantRuleMerge,
  type MerchantRuleSource,
} from './merchant-rule-merge';

/** 별칭 등록/해제는 가구 전체 집계를 바꾸므로 관리 권한을 요구한다. */
const ADMIN_ROLES = ['owner', 'admin'] as const;

/**
 * 병합 후보 판단의 feedback 계보 좌표.
 *
 * 기존 `merchant-category`(가맹점→카테고리)와 **분리한다**. 같은 target_type을 쓰면
 * 데이터셋 빌드가 "이 가맹점의 카테고리는 X"와 "이 이름들은 같은 가게가 아니다"를
 * 같은 라벨 축으로 읽는다 — 다른 질문에 대한 답이라 섞으면 둘 다 못 쓴다.
 */
const IDENTITY_TARGET_TYPE = 'merchant-identity';
const IDENTITY_LABEL_SCHEMA = 'merchant-identity-v1';

/**
 * ## 제안 정밀도를 어떻게 세는가
 *
 * 별도 지표 테이블을 만들지 않는다. `feedback_events`가 확정·거절을 모두 담으므로
 * SQL 한 줄로 센다:
 *
 * ```sql
 * select label->>'decision' as decision, label->>'reason' as reason, count(*)
 * from feedback_events
 * where target_type = 'merchant-identity'
 * group by 1, 2 order by 3 desc;
 * ```
 *
 * **정의를 정직하게 적어 둔다**: 이 비율은 "제안한 것 중 몇 %가 맞았나"가 아니라
 * **"사용자가 판단한 것 중 몇 %가 맞았나"**다. 제안됐지만 사용자가 아무 행동도 하지
 * 않은 후보는 분모에 없다. 전자를 세려면 렌더마다 제안을 기록해야 하는데, 화면이
 * 매 렌더 순수 함수로 계산하므로 같은 후보가 수십 번 쌓인다 — 그 비용으로 얻는
 * 정밀도는 "사용자가 무시했다"와 "아직 안 봤다"를 구분하지 못해 어차피 못 쓴다.
 *
 * `reason`은 거절 쪽에만 있다(확정은 화면을 거치지 않은 수동 병합도 포함하므로
 * 유형을 붙이면 제안 성능을 과대평가한다). 유형별 약점은 거절의 `reason` 분포로 읽는다.
 */

@Injectable()
export class MerchantService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 가맹점 목록 — 거래 집계에 별칭·카테고리 상태를 얹는다.
   *
   * 별칭만 등록되고 거래가 없는 이름(백필로 거래가 대표로 옮겨간 경우)도 행으로
   * 남긴다. 그래야 사용자가 "무엇이 무엇으로 묶였는지" 보고 해제할 수 있다.
   */
  async listMerchants(
    userId: string,
    householdId: string,
  ): Promise<{
    items: MerchantSummary[];
    identityCandidates: MerchantIdentityCandidate[];
  }> {
    const actorMemberId = await this.requireMembership(householdId, userId);

    // 공개범위는 analytics와 **같은 헬퍼**를 쓴다. 이 목록은 가맹점명과 순지출을 그대로
    // 보여주므로 조건이 빠지면 타인의 private 거래가 통째로 노출된다(실제 누락 사례).
    // 타인의 summary_only는 금액만 남기고 이름을 '(비공개)'로 접는다.
    const merchantLabel = redactedMerchantLabel(actorMemberId);
    const aggregates = await this.db
      .select({
        name: merchantLabel,
        transactionCount: sql<string>`count(*)`,
        netTotal: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
        lastTransactionAt: sql<Date | null>`max(${schema.cardTransactions.approvedAt})`,
        // 첫 방문 — "이번 달에 새로 간 곳"을 가르는 기준. 마지막 방문으로는
        // 지난달부터 다니던 단골과 구분되지 않는다.
        firstTransactionAt: sql<Date | null>`min(${schema.cardTransactions.approvedAt})`,
      })
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          isNull(schema.cardTransactions.excludedAt),
          sql`${schema.cardTransactions.merchantNormalized} is not null`,
          visibilityScope(actorMemberId),
        ),
      )
      // ordinal로 묶는다 — 표현식 객체를 다시 넘기면 placeholder가 어긋나 masking에
      // 쓰인 member_id/visibility가 "ungrouped"로 남는다(analytics.merchants와 동일).
      .groupBy(sql`1`);

    const aliases = await this.db
      .select({
        id: schema.merchantAliases.id,
        alias: schema.merchantAliases.alias,
        canonical: schema.merchantAliases.canonical,
      })
      .from(schema.merchantAliases)
      .where(eq(schema.merchantAliases.householdId, householdId));

    const rules = await this.db
      .select({
        pattern: schema.merchantCategoryRules.merchantPattern,
        categoryId: schema.expenseCategories.id,
        categoryName: schema.expenseCategories.name,
      })
      .from(schema.merchantCategoryRules)
      .innerJoin(
        schema.expenseCategories,
        eq(schema.expenseCategories.id, schema.merchantCategoryRules.categoryId),
      )
      .where(eq(schema.merchantCategoryRules.householdId, householdId));

    const aliasOf = new Map(aliases.map((a) => [a.alias, a.canonical]));
    const aliasIdByAlias = new Map(aliases.map((a) => [a.alias, a.id]));
    const aliasesByCanonical = new Map<string, string[]>();
    for (const a of aliases) {
      const list = aliasesByCanonical.get(a.canonical) ?? [];
      list.push(a.alias);
      aliasesByCanonical.set(a.canonical, list);
    }
    const ruleByPattern = new Map(rules.map((r) => [r.pattern, r]));

    // 거래가 있는 이름 ∪ 별칭 테이블에 등장하는 모든 이름.
    const names = new Set<string>();
    for (const row of aggregates) {
      if (row.name) names.add(row.name);
    }
    for (const a of aliases) {
      names.add(a.alias);
      names.add(a.canonical);
    }

    const aggByName = new Map(aggregates.map((r) => [r.name, r]));
    const items: MerchantSummary[] = [...names].map((name) => {
      const agg = aggByName.get(name);
      const rule = ruleByPattern.get(name);
      const last = agg?.lastTransactionAt ?? null;
      const first = agg?.firstTransactionAt ?? null;
      return {
        name,
        transactionCount: Number(agg?.transactionCount ?? 0),
        netTotal: Number(agg?.netTotal ?? 0),
        lastTransactionAt: last ? new Date(last).toISOString() : null,
        firstTransactionAt: first ? new Date(first).toISOString() : null,
        aliasOf: aliasOf.get(name) ?? null,
        aliasId: aliasIdByAlias.get(name) ?? null,
        aliases: aliasesByCanonical.get(name) ?? [],
        categoryId: rule?.categoryId ?? null,
        categoryName: rule?.categoryName ?? null,
      };
    });

    // 지출 큰 것 먼저 — 정리할 가치가 큰 가맹점이 위로 온다.
    items.sort((a, b) => b.netTotal - a.netTotal || a.name.localeCompare(b.name));

    /**
     * 사용자가 이미 "같은 가게가 아니다"라고 답한 후보들.
     *
     * 한 번의 거절로 영구히 제외한다. 지시서는 "두 번 거절하면"이라 적었지만
     * 한 번으로 좁혔다 — 사용자가 "아니에요"를 눌렀는데 같은 제안이 다시 올라오면
     * 그것 자체가 도구 신뢰를 깎는다. 규칙이 개선돼 묶음 구성이 달라지면 target id도
     * 달라지므로, 이 제외가 개선을 영구히 막지는 않는다.
     */
    const rejectedRows = await this.db
      .selectDistinct({ targetId: schema.feedbackEvents.targetId })
      .from(schema.feedbackEvents)
      .where(
        and(
          eq(schema.feedbackEvents.householdId, householdId),
          eq(schema.feedbackEvents.targetType, IDENTITY_TARGET_TYPE),
          eq(schema.feedbackEvents.source, 'human_rejected'),
        ),
      );
    const rejected = new Set(rejectedRows.map((r) => r.targetId));

    /**
     * 브랜드/지점 병합 후보.
     *
     * 절단 후보가 다루는 이름은 제외한다 — 실측에서 겹치는 쌍이 있고
     * (`씨유영등포` ⊂ `씨유영등포도림`), 같은 묶음이 두 블록에 나오면 사용자가
     * 같은 가게를 두 번 처리한다. 절단 쪽은 화면이 계산하므로 여기서 **같은 함수를
     * 한 번 더** 부른다(그 결과는 내려주지 않는다).
     *
     * 이 목록은 타인의 `private`/`summary_only` 거래가 접힌 뒤의 이름만 담는다 —
     * `items`가 이미 `redactedMerchantLabel`을 통과했기 때문이다. 후보를 원본
     * 이름으로 다시 계산하면 접어 둔 이름이 제안에 실려 새어 나간다(P0-6).
     */
    const truncationNames = new Set(
      findTruncationCandidates(items).flatMap((g) => [g.canonical, ...g.aliases]),
    );
    const identityCandidates = findMerchantIdentityCandidates(items, {
      excludeNames: truncationNames,
    })
      .filter(
        (g) =>
          !rejected.has(
            createMerchantIdentityTargetId(householdId, [
              g.canonical,
              ...g.aliases,
            ]),
          ),
      )
      .map((g) => ({
        brand: g.brand,
        reason: g.reason,
        canonical: g.canonical,
        aliases: g.aliases,
        transactionCount: g.transactionCount,
        netTotal: g.netTotal,
        evidence: g.evidence.map((e) => ({ ...e })),
      }));

    return { items, identityCandidates };
  }

  /**
   * 병합 후보 거절을 append-only로 남긴다.
   *
   * **상태를 바꾸지 않는다** — 별칭도, 거래도 손대지 않는다. 남는 것은 "사용자가
   * 이 묶음을 아니라고 했다"는 사실 하나이고, 그것이 다음 제안을 거른다.
   *
   * 중복 호출을 막지 않는 이유: feedback_events는 append-only 계보이고, 같은 판단이
   * 두 번 기록되는 것은 사실 왜곡이 아니다(사용자가 실제로 두 번 눌렀다).
   * 조회는 `selectDistinct`로 묶는다.
   */
  async rejectIdentityCandidate(
    userId: string,
    input: MerchantIdentityRejectRequest,
  ): Promise<MerchantIdentityRejectResponse> {
    await this.requireMembership(input.householdId, userId, ADMIN_ROLES);
    // 이름은 목록에 뜬 그대로 오지만, 화면과 서버가 같은 키를 계산해야 하므로
    // 정규화를 한 번 더 통과시킨다(화면이 보낸 값을 그대로 믿지 않는다).
    const names = input.names.map((n) => normalizeMerchant(n)).filter((n) => n.length > 0);
    if (names.length < 2) {
      throw new ConflictException('후보를 이루는 이름이 2개 미만입니다');
    }
    const targetId = createMerchantIdentityTargetId(input.householdId, names);
    await this.db.insert(schema.feedbackEvents).values({
      householdId: input.householdId,
      targetType: IDENTITY_TARGET_TYPE,
      targetId,
      labelSchemaVersion: IDENTITY_LABEL_SCHEMA,
      // 이름 원문은 넣지 않는다 — target id 해시가 신원을 담고, 이 계보는
      // 데이터셋 스냅샷으로 흘러간다(`createMerchantIdentityTargetId` 주석).
      label: {
        decision: 'rejected',
        brand: input.brand,
        reason: input.reason,
        nameCount: names.length,
      },
      source: 'human_rejected',
      actorUserId: userId,
      occurredAt: new Date(),
    });
    return { targetId };
  }

  /**
   * 별칭 일괄 등록 + 과거 데이터 백필.
   *
   * 평탄화 규칙:
   * 1. 요청 `canonical`이 이미 다른 이름의 별칭이면 **그 대표**를 최종 대표로 쓴다
   *    (`C -> X`가 있으면 결과는 전부 `X`로 모인다).
   * 2. 요청 `aliases` 중 하나를 대표로 삼던 기존 별칭들도 최종 대표로 재지정한다
   *    (`B -> A1`이 있고 `A1`을 별칭으로 만들면 `B`가 고아 체인이 되므로).
   */
  async createAliases(
    userId: string,
    input: MerchantAliasCreateRequest,
  ): Promise<MerchantAliasCreateResponse> {
    await this.requireMembership(input.householdId, userId, ADMIN_ROLES);
    const { householdId } = input;

    // 1. 대표 평탄화.
    const [existingForCanonical] = await this.db
      .select({ canonical: schema.merchantAliases.canonical })
      .from(schema.merchantAliases)
      .where(
        and(
          eq(schema.merchantAliases.householdId, householdId),
          eq(schema.merchantAliases.alias, input.canonical),
        ),
      )
      .limit(1);
    const canonical = existingForCanonical?.canonical ?? input.canonical;

    // 2. 별칭 집합 구성 — 요청분 + 요청분을 대표로 갖던 기존 별칭 + (평탄화된 경우) 원래 요청 대표.
    const requested = [...new Set(input.aliases)].filter((a) => a !== canonical);
    const dependents =
      requested.length > 0
        ? await this.db
            .select({ alias: schema.merchantAliases.alias })
            .from(schema.merchantAliases)
            .where(
              and(
                eq(schema.merchantAliases.householdId, householdId),
                inArray(schema.merchantAliases.canonical, requested),
              ),
            )
        : [];
    const allAliases = [
      ...new Set([
        ...requested,
        ...dependents.map((d) => d.alias),
        ...(input.canonical !== canonical ? [input.canonical] : []),
      ]),
    ].filter((a) => a !== canonical && a.length > 0);

    if (allAliases.length === 0) {
      return {
        canonical,
        created: [],
        transactionsUpdated: 0,
        rulesMerged: 0,
      };
    }

    return this.db.transaction(async (tx) => {
      // 3. 별칭 upsert — 이미 있으면 대표를 새 값으로 갱신(재지정 허용).
      const created = await tx
        .insert(schema.merchantAliases)
        .values(
          allAliases.map((alias) => ({
            householdId,
            alias,
            canonical,
            createdBy: userId,
          })),
        )
        .onConflictDoUpdate({
          target: [
            schema.merchantAliases.householdId,
            schema.merchantAliases.alias,
          ],
          set: { canonical, updatedAt: new Date() },
        })
        .returning({
          id: schema.merchantAliases.id,
          alias: schema.merchantAliases.alias,
          canonical: schema.merchantAliases.canonical,
          createdAt: schema.merchantAliases.createdAt,
        });

      // 4. 거래 백필 — 과거 집계도 대표 이름으로 모은다.
      const updated = await tx
        .update(schema.cardTransactions)
        .set({ merchantNormalized: canonical, updatedAt: new Date() })
        .where(
          and(
            eq(schema.cardTransactions.householdId, householdId),
            inArray(schema.cardTransactions.merchantNormalized, allAliases),
          ),
        )
        .returning({ id: schema.cardTransactions.id });

      /**
       * 5. 카테고리 규칙 병합 — 판단은 `planMerchantRuleMerge`가 한다(P1-17).
       *
       * 종전 코드는 대표에 규칙이 **있으면** 승격을 건너뛰고 별칭 규칙을 통째로
       * DELETE했다. 그래서 대표에 `model_prediction`이 있고 별칭에 사람이 확정한
       * 규칙이 있으면 **사람의 확정이 사라지고 모델 추측이 남았다.** 게다가 승격은
       * `merchant_pattern` rename으로 했는데, targetId가 패턴 해시라 rename은
       * `feedback_events` 계보를 끊어 데이터셋 빌드를 영구히 깨뜨린다.
       *
       * 계획을 순수 함수로 뽑은 이유는 이 판단이 틀렸을 때 드러나는 시점이 몇 달 뒤
       * (학습이 깨질 때)라서다 — DB 없이 전 분기를 테스트로 고정해야 회귀를 막는다.
       */
      const patterns = [canonical, ...allAliases];
      const rules = await tx
        .select({
          id: schema.merchantCategoryRules.id,
          merchantPattern: schema.merchantCategoryRules.merchantPattern,
          categoryId: schema.merchantCategoryRules.categoryId,
          source: schema.merchantCategoryRules.source,
          predictionTraceId: schema.merchantCategoryRules.predictionTraceId,
          confirmedAt: schema.merchantCategoryRules.confirmedAt,
          createdBy: schema.merchantCategoryRules.createdBy,
          updatedAt: schema.merchantCategoryRules.updatedAt,
        })
        .from(schema.merchantCategoryRules)
        .where(
          and(
            eq(schema.merchantCategoryRules.householdId, householdId),
            inArray(schema.merchantCategoryRules.merchantPattern, patterns),
          ),
        );

      // 스냅샷이 참조하는 규칙은 지울 수 없다(FK가 ON DELETE no action — 지우면
      // 23503으로 별칭 등록 트랜잭션 전체가 롤백된다).
      const ruleIds = rules.map((rule) => rule.id);
      const referencedRows = ruleIds.length
        ? await tx
            .selectDistinct({
              ruleId: schema.datasetSnapshotItems.merchantCategoryRuleId,
            })
            .from(schema.datasetSnapshotItems)
            .where(
              inArray(schema.datasetSnapshotItems.merchantCategoryRuleId, ruleIds),
            )
        : [];

      const plan = planMerchantRuleMerge({
        canonical,
        resolveCategoryId: input.categoryId,
        rules: rules.map((rule) => ({
          ...rule,
          source: rule.source as MerchantRuleSource,
        })),
        snapshotReferencedRuleIds: new Set(
          referencedRows
            .map((row) => row.ruleId)
            .filter((id): id is string => id !== null),
        ),
      });

      if (plan.conflict) {
        // 사람이 서로 다른 카테고리로 확정한 규칙이 둘 이상이다. 시스템이 임의로
        // 고르면 그 판단이 틀렸을 때 되돌릴 근거가 남지 않는다(ADR-0029 merged 원칙).
        //
        // 사용자가 답을 고르면(`categoryId`) 이 분기에 오지 않는다 — 화면은 카테고리가
        // 갈린 것을 **묶기 전에** 알 수 있으므로(`MerchantSummary.categoryId`) 대표를
        // 고를 때 카테고리도 함께 묻는다. 실측 2026-09-05에 제안 3건이 전부 이 충돌에
        // 걸려 있었고, 그때 화면은 "묶으세요"라고 한 뒤 거부만 했다.
        if (plan.conflict.reason === CATEGORY_NOT_IN_CONFLICT) {
          throw new ConflictException(
            '고른 카테고리가 이 가맹점들에 확정된 것 중에 없어요.',
          );
        }
        throw new ConflictException(
          '묶으려는 가맹점들에 서로 다른 카테고리가 확정돼 있어요. 어느 카테고리로 합칠지 골라 주세요.',
        );
      }

      const { rulesRemoved } = await applyMerchantRuleMerge(tx, {
        householdId,
        canonical,
        actorUserId: userId,
        plan,
        now: new Date(),
      });

      /**
       * 6. 확정 사실을 feedback 계보에도 남긴다 — **같은 트랜잭션 안에서**.
       *
       * 거절(`human_rejected`)만 기록하면 제안 정밀도의 분모만 쌓이고 분자가 없다.
       * "사용자가 판단한 후보 중 몇 %가 맞았나"를 세려면 확정도 같은 target_type에
       * 들어와야 한다.
       *
       * 화면을 거치지 않고 직접 고른 병합도 여기로 들어온다 — 그것은 제안이 아니라
       * 사용자가 스스로 찾은 것이므로 정밀도 분자로 세면 제안 성능을 과대평가한다.
       * 그래서 label에 `brand`·`reason`을 넣지 않는다: 제안에서 온 것만 그 필드를
       * 갖는 거절 쪽과 대칭이 깨지지만, 대칭보다 **분자를 부풀리지 않는 것**이 중요하다.
       * 유형별 정밀도는 거절 쪽 `reason` 분포로 읽는다.
       */
      await tx.insert(schema.feedbackEvents).values({
        householdId,
        targetType: IDENTITY_TARGET_TYPE,
        targetId: createMerchantIdentityTargetId(householdId, [
          canonical,
          ...allAliases,
        ]),
        labelSchemaVersion: IDENTITY_LABEL_SCHEMA,
        label: { decision: 'confirmed', nameCount: allAliases.length + 1 },
        source: 'human_confirmed',
        actorUserId: userId,
        occurredAt: new Date(),
      });

      return {
        canonical,
        created: created.map((c) => ({
          id: c.id,
          alias: c.alias,
          canonical: c.canonical,
          createdAt: c.createdAt.toISOString(),
        })),
        transactionsUpdated: updated.length,
        rulesMerged: rulesRemoved,
      };
    });
  }

  /**
   * 별칭 해제 — 이 별칭으로 묶여 있던 거래를 원문 재정규화 값으로 되돌린다.
   *
   * 어떤 거래가 "이 별칭이었는지"는 `merchant_raw`를 다시 정규화해서 판정한다.
   * `merchant_normalized`만 보면 다른 별칭으로 묶인 것과 구분할 수 없다.
   */
  async deleteAlias(
    userId: string,
    id: string,
  ): Promise<MerchantAliasDeleteResponse> {
    const [row] = await this.db
      .select()
      .from(schema.merchantAliases)
      .where(eq(schema.merchantAliases.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('merchant alias not found');
    await this.requireMembership(row.householdId, userId, ADMIN_ROLES);

    return this.db.transaction(async (tx) => {
      // 대표로 묶인 거래 중 원문이 이 별칭으로 정규화되는 것만 되돌린다.
      const candidates = await tx
        .select({
          id: schema.cardTransactions.id,
          merchantRaw: schema.cardTransactions.merchantRaw,
        })
        .from(schema.cardTransactions)
        .where(
          and(
            eq(schema.cardTransactions.householdId, row.householdId),
            eq(schema.cardTransactions.merchantNormalized, row.canonical),
          ),
        );

      const toRevert = candidates.filter(
        (c) => c.merchantRaw && normalizeMerchant(c.merchantRaw) === row.alias,
      );
      if (toRevert.length > 0) {
        await tx
          .update(schema.cardTransactions)
          .set({ merchantNormalized: row.alias, updatedAt: new Date() })
          .where(
            inArray(
              schema.cardTransactions.id,
              toRevert.map((t) => t.id),
            ),
          );
      }

      await tx
        .delete(schema.merchantAliases)
        .where(eq(schema.merchantAliases.id, id));

      return {
        id: row.id,
        alias: row.alias,
        canonical: row.canonical,
        transactionsReverted: toRevert.length,
      };
    });
  }

  /* ---------------------------------------------------------------------- */

  /**
   * `userId`가 `householdId`의 활성 구성원인지(그리고 `roles` 중 하나인지) 강제하고
   * 액터의 `memberId`를 돌려준다(공개범위 스코프에 필요).
   * 비구성원에게는 가구 존재 여부를 드러내지 않는 403을 준다(PRD §26).
   */
  private async requireMembership(
    householdId: string,
    userId: string,
    roles?: readonly string[],
  ): Promise<string> {
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
    if (!member) throw new ForbiddenException('not a household member');
    if (roles && !roles.includes(member.role)) {
      throw new ForbiddenException('insufficient role');
    }
    return member.id;
  }
}
