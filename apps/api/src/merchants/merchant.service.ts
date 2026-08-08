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
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  redactedMerchantLabel,
  schema,
  visibilityScope,
  type Db,
} from '@family/database';
import { normalizeMerchant } from '@family/shared';
import type {
  MerchantAliasCreateRequest,
  MerchantAliasCreateResponse,
  MerchantAliasDeleteResponse,
  MerchantSummary,
} from '@family/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB } from '../database/database.constants';

/** 별칭 등록/해제는 가구 전체 집계를 바꾸므로 관리 권한을 요구한다. */
const ADMIN_ROLES = ['owner', 'admin'] as const;

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
  ): Promise<MerchantSummary[]> {
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
      return {
        name,
        transactionCount: Number(agg?.transactionCount ?? 0),
        netTotal: Number(agg?.netTotal ?? 0),
        lastTransactionAt: last ? new Date(last).toISOString() : null,
        aliasOf: aliasOf.get(name) ?? null,
        aliasId: aliasIdByAlias.get(name) ?? null,
        aliases: aliasesByCanonical.get(name) ?? [],
        categoryId: rule?.categoryId ?? null,
        categoryName: rule?.categoryName ?? null,
      };
    });

    // 지출 큰 것 먼저 — 정리할 가치가 큰 가맹점이 위로 온다.
    items.sort((a, b) => b.netTotal - a.netTotal || a.name.localeCompare(b.name));
    return items;
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

      // 5. 카테고리 규칙 병합. 대표에 규칙이 없으면 별칭 규칙 하나를 대표로 승격한다.
      //    우선순위는 `human_confirmed`(사용자 확정) → 최근 갱신 순이다. 시각만 보면
      //    나중에 생긴 자동 학습(`model_prediction`)이 사람의 확정을 덮어버린다
      //    (실측: 자동 `팀오투 -> 기타`가 사용자 확정 `-> 여행`보다 최신이었다).
      const patterns = [canonical, ...allAliases];
      const rules = await tx
        .select({
          id: schema.merchantCategoryRules.id,
          pattern: schema.merchantCategoryRules.merchantPattern,
          source: schema.merchantCategoryRules.source,
          updatedAt: schema.merchantCategoryRules.updatedAt,
        })
        .from(schema.merchantCategoryRules)
        .where(
          and(
            eq(schema.merchantCategoryRules.householdId, householdId),
            inArray(schema.merchantCategoryRules.merchantPattern, patterns),
          ),
        )
        .orderBy(desc(schema.merchantCategoryRules.updatedAt));

      const canonicalRule = rules.find((r) => r.pattern === canonical);
      if (!canonicalRule) {
        const promote =
          rules.find((r) => r.source === 'human_confirmed') ?? rules[0];
        if (promote) {
          // UNIQUE(householdId, merchantPattern) 충돌 없음 — 대표 패턴 규칙이 없음을 확인했다.
          await tx
            .update(schema.merchantCategoryRules)
            .set({ merchantPattern: canonical, updatedAt: new Date() })
            .where(eq(schema.merchantCategoryRules.id, promote.id));
        }
      }
      const removed = await tx
        .delete(schema.merchantCategoryRules)
        .where(
          and(
            eq(schema.merchantCategoryRules.householdId, householdId),
            inArray(schema.merchantCategoryRules.merchantPattern, allAliases),
          ),
        )
        .returning({ id: schema.merchantCategoryRules.id });

      return {
        canonical,
        created: created.map((c) => ({
          id: c.id,
          alias: c.alias,
          canonical: c.canonical,
          createdAt: c.createdAt.toISOString(),
        })),
        transactionsUpdated: updated.length,
        rulesMerged: removed.length,
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
