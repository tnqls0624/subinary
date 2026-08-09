/**
 * 정기 지출 Radar 서비스 (C-5 최소 제품).
 *
 * 세 가지만 한다: **후보 재계산** · **목록 조회** · **사용자 확정**.
 * 다음 결제 예상일 · 월 정기 지출 총액 · 알림 · 해지 CTA는 의도적으로 없다
 * (`recurring.constants.ts`의 `RECURRING_DEFERRED_SURFACES` 참고).
 *
 * 공개범위는 `@family/database`의 {@link visibilityScope}를 **재사용**한다. 새로 짜지
 * 마라 — 이 저장소는 같은 조건을 5곳에 복붙했다가 네 번째 집계 API에서 통째로 누락해
 * 타인의 private 거래 가맹점명·금액을 노출했다(P0-6).
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  ne,
  not,
  notExists,
  sql,
} from 'drizzle-orm';

import type {
  RecurringDecisionResponse,
  RecurringNeedsReviewReason,
  RecurringSeriesItem,
  RecurringSeriesListResponse,
  RecurringRecomputeResponse,
} from '@family/contracts';
import {
  REDACTED_MERCHANT_LABEL,
  notTransferCategory,
  schema,
  spendPeriodWindow,
  visibilityScope,
  type Db,
} from '@family/database';
import {
  buildMerchantAliasIndex,
  regroupByCanonicalMerchant,
  resolveCanonicalMerchant,
} from '@family/shared';

import { DB } from '../database/database.constants';
import {
  detectRecurringCandidates,
  type RecurringCandidate,
  type RecurringOccurrence,
} from './detect';
import { reconcileSeries, type DecidedSeries } from './reconcile';
import {
  RECURRING_LOOKBACK_MONTHS,
  isRecurringRadarEnabled,
} from './recurring.constants';

/** 반복 거절을 후보에 붙일 때 보는 창(일). api `listDeclines` 기본값과 같다. */
const DECLINE_LINK_WINDOW_DAYS = 60;

/** 거절 묶음을 "반복"으로 볼 최소 시도 수. ADR-0024 §4와 같은 임계. */
const DECLINE_LINK_MIN_ATTEMPTS = 2;

@Injectable()
export class RecurringService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ---------------------------------------------------------------------- */
  /* 조회                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * 후보·확정 목록. **flag가 꺼져 있으면 빈 목록 + `enabled:false`** 를 준다.
   *
   * 404·403이 아니라 200인 이유: 화면이 "아직 켜지 않았습니다"를 정직하게 말할 수 있어야
   * 한다. 빈 목록만 주면 사용자는 "정기 결제가 없다"로 읽고, 그건 없는 사실이다.
   */
  async list(
    actorUserId: string,
    householdId: string,
  ): Promise<RecurringSeriesListResponse> {
    if (!householdId) {
      throw new BadRequestException('householdId is required');
    }
    const actorMemberId = await this.requireMembership(householdId, actorUserId);

    if (!isRecurringRadarEnabled()) {
      return { enabled: false, provisional: true, items: [], computedAt: null };
    }

    const rows = await this.db
      .select({
        id: schema.recurringSeries.id,
        memberId: schema.recurringSeries.memberId,
        merchantCanonical: schema.recurringSeries.merchantCanonical,
        amountMin: schema.recurringSeries.amountMin,
        amountMax: schema.recurringSeries.amountMax,
        amountMedian: schema.recurringSeries.amountMedian,
        currency: schema.recurringSeries.currency,
        cadence: schema.recurringSeries.cadence,
        intervalDays: schema.recurringSeries.intervalDays,
        occurrenceCount: schema.recurringSeries.occurrenceCount,
        firstSeenAt: schema.recurringSeries.firstSeenAt,
        lastSeenAt: schema.recurringSeries.lastSeenAt,
        status: schema.recurringSeries.status,
        needsReviewReason: schema.recurringSeries.needsReviewReason,
        moneyContractVersion: schema.recurringSeries.moneyContractVersion,
        computedAt: schema.recurringSeries.computedAt,
        // 타인의 `summary_only` 근거가 하나라도 있으면 이름을 가린다(금액은 남긴다).
        redacted: exists(this.summaryOnlyEvidence(actorMemberId)),
      })
      .from(schema.recurringSeries)
      .where(
        and(
          eq(schema.recurringSeries.householdId, householdId),
          this.visibleToActor(actorMemberId),
        ),
      )
      .orderBy(
        desc(schema.recurringSeries.lastSeenAt),
        asc(schema.recurringSeries.merchantCanonical),
      );

    const declines = await this.recentDeclines(householdId);
    const items: RecurringSeriesItem[] = rows.map((r) => {
      const linked = declines.get(`${r.merchantCanonical}`);
      return {
        id: r.id,
        merchant: r.redacted ? REDACTED_MERCHANT_LABEL : r.merchantCanonical,
        amount: r.amountMedian,
        amountMin: r.amountMin,
        amountMax: r.amountMax,
        currency: r.currency,
        cadence: r.cadence,
        intervalDays: r.intervalDays,
        occurrenceCount: r.occurrenceCount,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        status: r.status,
        needsReviewReason:
          (r.needsReviewReason as RecurringNeedsReviewReason | null) ?? null,
        mine: r.memberId === actorMemberId,
        moneyContractVersion: r.moneyContractVersion,
        // 이름을 가린 항목에는 거절 사유도 붙이지 않는다 — 사유가 곧 가맹점 힌트다.
        recentDeclineReason: r.redacted ? null : (linked?.reason ?? null),
        recentDeclineAttempts: r.redacted ? 0 : (linked?.attempts ?? 0),
      };
    });

    const computedAt = rows.reduce<Date | null>(
      (max, r) => (max === null || r.computedAt > max ? r.computedAt : max),
      null,
    );
    return {
      enabled: true,
      // ADR-0027 enforce + 과거 수리 뒤 전량 재계산해야 false가 된다.
      provisional: true,
      items,
      computedAt: computedAt ? computedAt.toISOString() : null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 사용자 확정                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * "정기 결제 맞음 / 아님". 이게 최소 제품의 전부다.
   *
   * 볼 수 있는 구성원이면 누구나 확정할 수 있다 — 공용 카드의 구독을 실제로 관리하는
   * 사람이 결제 카드 소유자가 아닐 수 있다(ADR-0024가 거절 알림을 전원에게 보내는 것과
   * 같은 이유). 볼 수 없는 series는 존재 자체를 알리지 않는다(404).
   */
  async decide(
    actorUserId: string,
    seriesId: string,
    decision: 'confirmed' | 'rejected',
  ): Promise<RecurringDecisionResponse> {
    if (!isRecurringRadarEnabled()) {
      throw new ForbiddenException('recurring radar is not enabled');
    }
    const [series] = await this.db
      .select({
        id: schema.recurringSeries.id,
        householdId: schema.recurringSeries.householdId,
      })
      .from(schema.recurringSeries)
      .where(eq(schema.recurringSeries.id, seriesId))
      .limit(1);
    if (!series) throw new NotFoundException('recurring series not found');

    const actorMemberId = await this.requireMembership(
      series.householdId,
      actorUserId,
    );

    const [updated] = await this.db
      .update(schema.recurringSeries)
      .set({
        status: decision,
        statusChangedAt: new Date(),
        statusChangedBy: actorUserId,
        // 사용자가 다시 판단했으므로 재검토 표시는 걷는다(CHECK: reason은 needs_review 전용).
        needsReviewReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.recurringSeries.id, seriesId),
          this.visibleToActor(actorMemberId),
        ),
      )
      .returning({
        id: schema.recurringSeries.id,
        status: schema.recurringSeries.status,
      });
    // 볼 수 없는 series는 "권한 없음"이 아니라 "없음"이다 — 존재를 알리지 않는다.
    if (!updated) throw new NotFoundException('recurring series not found');
    return { id: updated.id, status: updated.status };
  }

  /* ---------------------------------------------------------------------- */
  /* 재계산                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * 후보 전량 재계산.
   *
   * 미확정 후보(`candidate`)는 **폐기·재생성 가능한 projection**이라 통째로 지우고 다시
   * 만든다. 사용자가 판단한 series는 근거 거래 ID의 **교집합**으로 이어 붙이고, 근거가
   * 사라졌거나 합쳐/갈라졌으면 `needs_review`로 남긴다 — 조용히 지우지 않는다.
   *
   * 별칭 등록·해제가 과거 거래의 canonical 신원을 바꾸므로, 그 뒤에는 이 재계산을
   * 한 번 돌려야 후보가 현재 신원과 맞는다.
   *
   * ⚠️ 재계산 실패가 기존 거래나 사용자의 결정을 삭제하면 안 된다(PO 판정 Q5-4).
   * 그래서 전 과정을 한 트랜잭션에 넣는다 — 중간에 죽으면 아무것도 바뀌지 않는다.
   */
  async recompute(
    actorUserId: string,
    householdId: string,
  ): Promise<RecurringRecomputeResponse> {
    await this.requireMembership(householdId, actorUserId);

    const occurrences = await this.loadOccurrences(householdId);
    const candidates = detectRecurringCandidates(occurrences);

    const decided = await this.loadDecidedSeries(householdId);
    const plan = reconcileSeries(decided, candidates);
    const computedAt = new Date();

    await this.db.transaction(async (tx) => {
      // 1. 미확정 후보는 통째로 버린다(evidence는 FK cascade).
      await tx
        .delete(schema.recurringSeries)
        .where(
          and(
            eq(schema.recurringSeries.householdId, householdId),
            eq(schema.recurringSeries.status, 'candidate'),
          ),
        );

      // 2. 이어 붙일 것 — 신원(id)과 상태를 그대로 두고 계산값만 갱신한다.
      for (const { seriesId, candidateIndex } of plan.updates) {
        await this.applyCandidate(
          tx,
          seriesId,
          candidates[candidateIndex],
          computedAt,
          null,
        );
      }

      // 3. 재검토가 필요해진 것.
      for (const { seriesId, reason, candidateIndex } of plan.needsReview) {
        if (candidateIndex !== null) {
          await this.applyCandidate(
            tx,
            seriesId,
            candidates[candidateIndex],
            computedAt,
            reason,
          );
          continue;
        }
        // 근거를 건드리지 않는다 — 거래가 잠시 안 보이는 것과 영영 사라진 것을
        // 이 시점에 구별할 수 없고, 지워 버리면 되돌릴 근거가 없다.
        await tx
          .update(schema.recurringSeries)
          .set({
            status: 'needs_review',
            needsReviewReason: reason,
            statusChangedAt: computedAt,
            // 시스템이 바꾼 것이므로 사람 id를 남기지 않는다.
            statusChangedBy: null,
            computedAt,
            updatedAt: computedAt,
          })
          .where(eq(schema.recurringSeries.id, seriesId));
      }

      // 4. 새 후보.
      for (const index of plan.inserts) {
        const candidate = candidates[index];
        const [inserted] = await tx
          .insert(schema.recurringSeries)
          .values({
            householdId,
            memberId: candidate.memberId,
            merchantCanonical: candidate.merchantCanonical,
            amountMin: candidate.amountMin,
            amountMax: candidate.amountMax,
            amountMedian: candidate.amountMedian,
            currency: candidate.currency,
            intervalDays: candidate.intervalDays,
            cadence: candidate.cadence,
            occurrenceCount: candidate.occurrenceCount,
            firstSeenAt: candidate.firstSeenAt,
            lastSeenAt: candidate.lastSeenAt,
            status: 'candidate',
            algorithmVersion: candidate.algorithmVersion,
            moneyContractVersion: candidate.moneyContractVersion,
            computedAt,
          })
          .returning({ id: schema.recurringSeries.id });
        await tx.insert(schema.recurringSeriesEvidence).values(
          candidate.transactionIds.map((transactionId) => ({
            seriesId: inserted.id,
            transactionId,
          })),
        );
      }
    });

    return {
      created: plan.inserts.length,
      updated: plan.updates.length,
      needsReview: plan.needsReview.length,
      computedAt: computedAt.toISOString(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 내부                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * 판별 입력 — **정확히 지시된 필터만** 통과시킨다.
   *
   * 성공한 승인(`approved`/`partially_cancelled`) · `excluded_at IS NULL` ·
   * `net_amount > 0` · 비자산이동 · canonical 가맹점이 있는 행.
   *
   * ⛔ `declined`는 소비가 아니므로 후보를 만들지 않는다 — 거절을 거래로 만들지 않는
   * ADR-0024의 결정을 여기서 우회하면 유령 정기결제가 생긴다. 거절은 이미 생긴 후보의
   * **실패 신호**로만 붙인다({@link recentDeclines}).
   */
  private async loadOccurrences(
    householdId: string,
  ): Promise<RecurringOccurrence[]> {
    const to = new Date();
    const from = new Date(to);
    from.setUTCMonth(from.getUTCMonth() - RECURRING_LOOKBACK_MONTHS);

    const rows = await this.db
      .select({
        id: schema.cardTransactions.id,
        memberId: schema.cardTransactions.memberId,
        merchantRaw: schema.cardTransactions.merchantRaw,
        merchantNormalized: schema.cardTransactions.merchantNormalized,
        netAmount: schema.cardTransactions.netAmount,
        currency: schema.cardTransactions.currency,
        approvedAt: schema.cardTransactions.approvedAt,
        createdAt: schema.cardTransactions.createdAt,
        moneyContractVersion: schema.cardTransactions.moneyContractVersion,
      })
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.householdId, householdId),
          eq(schema.cardTransactions.transactionType, 'approval'),
          inArray(schema.cardTransactions.status, [
            'approved',
            'partially_cancelled',
          ]),
          isNull(schema.cardTransactions.excludedAt),
          gt(schema.cardTransactions.netAmount, 0),
          // 자산 이동(현금 인출·선불 충전)은 소비가 아니다(ADR-0025).
          notTransferCategory(),
          // 창은 지출 집계와 같은 규약을 쓴다 — approvedAt이 NULL이어도 빠지지 않는다.
          spendPeriodWindow(from, to),
        ),
      );

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

    const occurrences: RecurringOccurrence[] = [];
    for (const r of rows) {
      // 신원은 **원문에서 다시 해석**한다. `merchant_normalized`는 별칭 등록 시
      // 백필된 값이라 백필이 밀리면 옛 이름으로 남는데, 그 상태로 묶으면 P1-16과
      // 같은 종류의 분열이 후보 쪽에서 재발한다. 원문이 없는 행(수기 입력 등)만
      // 저장된 값을 믿는다.
      const canonical = r.merchantRaw
        ? resolveCanonicalMerchant(r.merchantRaw, householdId, aliasIndex)
        : r.merchantNormalized;
      if (!canonical) continue;
      occurrences.push({
        transactionId: r.id,
        memberId: r.memberId,
        merchantCanonical: canonical,
        netAmount: r.netAmount,
        currency: r.currency,
        occurredAt: r.approvedAt ?? r.createdAt,
        moneyContractVersion: r.moneyContractVersion,
      });
    }
    return occurrences;
  }

  /** 사용자가 이미 판단한(또는 재검토 대기 중인) series와 그 근거. */
  private async loadDecidedSeries(
    householdId: string,
  ): Promise<DecidedSeries[]> {
    const rows = await this.db
      .select({
        id: schema.recurringSeries.id,
        transactionId: schema.recurringSeriesEvidence.transactionId,
      })
      .from(schema.recurringSeries)
      .leftJoin(
        schema.recurringSeriesEvidence,
        eq(schema.recurringSeriesEvidence.seriesId, schema.recurringSeries.id),
      )
      .where(
        and(
          eq(schema.recurringSeries.householdId, householdId),
          ne(schema.recurringSeries.status, 'candidate'),
        ),
      );

    const byId = new Map<string, string[]>();
    for (const r of rows) {
      const list = byId.get(r.id) ?? [];
      if (r.transactionId) list.push(r.transactionId);
      byId.set(r.id, list);
    }
    return [...byId.entries()].map(([id, transactionIds]) => ({
      id,
      transactionIds,
    }));
  }

  /** series의 계산값·근거를 후보로 덮어쓴다. `reason`이 있으면 재검토 표시도 남긴다. */
  private async applyCandidate(
    tx: Db,
    seriesId: string,
    candidate: RecurringCandidate,
    computedAt: Date,
    reason: RecurringNeedsReviewReason | null,
  ): Promise<void> {
    await tx
      .update(schema.recurringSeries)
      .set({
        memberId: candidate.memberId,
        merchantCanonical: candidate.merchantCanonical,
        amountMin: candidate.amountMin,
        amountMax: candidate.amountMax,
        amountMedian: candidate.amountMedian,
        currency: candidate.currency,
        intervalDays: candidate.intervalDays,
        cadence: candidate.cadence,
        occurrenceCount: candidate.occurrenceCount,
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
        algorithmVersion: candidate.algorithmVersion,
        moneyContractVersion: candidate.moneyContractVersion,
        computedAt,
        updatedAt: computedAt,
        ...(reason
          ? {
              status: 'needs_review' as const,
              needsReviewReason: reason,
              statusChangedAt: computedAt,
              statusChangedBy: null,
            }
          : {}),
      })
      .where(eq(schema.recurringSeries.id, seriesId));

    await tx
      .delete(schema.recurringSeriesEvidence)
      .where(eq(schema.recurringSeriesEvidence.seriesId, seriesId));
    await tx.insert(schema.recurringSeriesEvidence).values(
      candidate.transactionIds.map((transactionId) => ({
        seriesId,
        transactionId,
      })),
    );
  }

  /**
   * 최근 반복 거절을 canonical 가맹점별로 모은다 — 후보에 **실패 신호**로 붙인다.
   *
   * 묶는 순서는 api `listDeclines`·worker 스케줄러와 같다(별칭 적용 → 묶기 → 임계).
   * 여기서 순서를 뒤집으면 P1-16이 세 번째 경로에서 재발한다.
   */
  private async recentDeclines(
    householdId: string,
  ): Promise<Map<string, { attempts: number; reason: string | null }>> {
    const since = new Date(
      Date.now() - DECLINE_LINK_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const events = await this.db
      .select({
        householdId: schema.cardSmsEvents.householdId,
        merchantRaw: schema.cardSmsEvents.merchantRaw,
        reason: schema.cardSmsEvents.declineReason,
        occurredAt: schema.cardSmsEvents.occurredAt,
        createdAt: schema.cardSmsEvents.createdAt,
      })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.householdId, householdId),
          eq(schema.cardSmsEvents.transactionType, 'declined'),
          gte(schema.cardSmsEvents.createdAt, since),
        ),
      );
    if (events.length === 0) return new Map();

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

    // 금액은 묶음 축에서 뺀다 — 구독 요금이 바뀐 뒤 실패해도 같은 series의 신호다.
    const groups = regroupByCanonicalMerchant(events, {
      aliases: aliasIndex,
      householdId: (e) => e.householdId,
      merchantRaw: (e) => e.merchantRaw,
      subKey: () => '',
      weight: () => 1,
      orderAt: (e) => e.occurredAt ?? e.createdAt,
    });

    const byMerchant = new Map<
      string,
      { attempts: number; reason: string | null }
    >();
    for (const g of groups) {
      if (g.canonical === null) continue;
      if (g.total < DECLINE_LINK_MIN_ATTEMPTS) continue;
      byMerchant.set(g.canonical, {
        attempts: g.total,
        // 사유는 최신 시도의 것 — 원인이 바뀔 수 있다(한도초과 → 분실신고).
        reason: g.latest.reason ?? null,
      });
    }
    return byMerchant;
  }

  /**
   * 액터가 이 series를 볼 수 있는가 — **근거 거래 하나라도 볼 수 없으면 감춘다**.
   *
   * `visibilityScope()`를 그대로 부정해서 쓴다. 여기에 조건을 손으로 다시 적으면
   * 규칙이 갈라지고, 갈라진 순간이 곧 유출이다(P0-6).
   */
  private visibleToActor(actorMemberId: string) {
    return notExists(
      this.db
        .select({ one: sql`1` })
        .from(schema.recurringSeriesEvidence)
        .innerJoin(
          schema.cardTransactions,
          eq(
            schema.cardTransactions.id,
            schema.recurringSeriesEvidence.transactionId,
          ),
        )
        .where(
          and(
            eq(
              schema.recurringSeriesEvidence.seriesId,
              schema.recurringSeries.id,
            ),
            not(visibilityScope(actorMemberId)),
          ),
        ),
    );
  }

  /** 타인의 `summary_only` 근거가 있는가 — 있으면 금액은 두고 이름만 가린다. */
  private summaryOnlyEvidence(actorMemberId: string) {
    return this.db
      .select({ one: sql`1` })
      .from(schema.recurringSeriesEvidence)
      .innerJoin(
        schema.cardTransactions,
        eq(
          schema.cardTransactions.id,
          schema.recurringSeriesEvidence.transactionId,
        ),
      )
      .where(
        and(
          eq(schema.recurringSeriesEvidence.seriesId, schema.recurringSeries.id),
          ne(schema.cardTransactions.memberId, actorMemberId),
          eq(schema.cardTransactions.visibility, 'summary_only'),
        ),
      );
  }

  /**
   * `userId`가 `householdId`의 활성 구성원인지 강제하고 액터의 `memberId`를 준다
   * (공개범위 스코프에 필요). 비구성원에게는 가구 존재 여부를 드러내지 않는 403
   * (PRD §26 · 다른 도메인 서비스와 같은 관례).
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
    if (!member) throw new ForbiddenException('not a household member');
    return member.id;
  }
}
