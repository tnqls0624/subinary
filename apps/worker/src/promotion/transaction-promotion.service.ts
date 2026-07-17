/**
 * 거래 승격 서비스 (Phase 4 Build Spec §6).
 *
 * 파싱이 끝난 `card_sms_events`(parseStatus in parsed/pending_review, amount 존재)를
 * 정규화된 `card_transactions`로 승격한다. 파싱 워커가 같은 잡 안에서 호출하므로
 * 별도 큐 없이 10초 반영 목표를 유지한다(스펙 §1.1).
 *
 * 규약:
 * - 멱등: `card_transactions.sourceEventId` UNIQUE + `onConflictDoNothing`.
 *   재승격/경합은 기존 레코드를 남기고 승인 잔액을 이중 반영하지 않는다.
 * - 금액은 KRW 정수(부동소수 금지). netAmount 규약(스펙 §1.2):
 *   approval → netAmount = amount - cancelledAmount, cancellation → netAmount = 0.
 * - 카드 자동연결: 파서 `maskedCardNumber` 뒤 4자리 ↔ 같은 household
 *   `payment_cards.maskedNumber` 뒤 4자리(스펙 §1.5). 매칭 없으면 cardId=null,
 *   visibility='household'. 뒤 4자리가 같은 활성 카드가 2장 이상이면 어느 카드인지
 *   확정 불가 → 임의 연결 대신 cardId=null + 후보 중 가장 제한적인 visibility(누출
 *   방지)로 두고, 승인은 pending_review로 표시해 사람 검토를 유도한다.
 * - 카테고리: merchant_category_rules(household, merchantNormalized) →
 *   키워드(categorizeByKeyword → slug → 시스템 expense_categories) →
 *   LLM 제안(category-suggest 큐, 비동기 자가학습) → null (스펙 §1.3).
 *   LLM tier 는 여기서 동기 분류하지 않는다 — 미분류(null)로 승격을 완료하고
 *   가맹점 단위 1회 category-suggest 잡만 enqueue 한다(승격 지연/실패 없음).
 * - 로그는 식별자/거래유형/상태만(금액·가맹점·PII 미기록, 스펙 §6/§1.1).
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';
import {
  assertKrwInteger,
  categorizeByKeyword,
  createLogger,
  normalizeMerchant,
  QUEUE_NAMES,
} from '@family/shared';
import type { Queue } from 'bullmq';
import { and, desc, eq, gte, inArray, isNull, lt, lte, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { DB } from '../database/database.module';

/** 공개 범위(스펙 §2 cardVisibility enum). 카드 없으면 'household'로 상속. */
type CardVisibility = 'private' | 'household' | 'summary_only';

/** 거래 상태(스펙 §2 txnStatus enum). */
type TransactionStatus =
  | 'approved'
  | 'partially_cancelled'
  | 'cancelled'
  | 'pending_review'
  | 'duplicate_suspected';

/**
 * 2차 유사중복 판정 시각 근접 창(±수분, 스펙 §6.6). 같은 카드/금액/가맹점의 승인이
 * 이 창 안에 이미 있으면 새 승인을 duplicate_suspected로 표시한다.
 */
const DUPLICATE_TIME_WINDOW_MS = 5 * 60 * 1000;

/** 카드 자동연결에 필요한 최소 식별 자릿수(뒤 4자리). */
const CARD_TAIL_LENGTH = 4;

/** 카드 자동연결 결과(뒤 4자리 매칭). */
interface CardLink {
  cardId: string | null;
  visibility: CardVisibility;
  /** 뒤 4자리가 같은 활성 카드가 2장 이상이라 카드를 확정하지 못한 경우. */
  ambiguous: boolean;
}

/** visibility 제한 강도 순위(클수록 더 비공개). */
const VISIBILITY_RANK: Record<CardVisibility, number> = {
  household: 0,
  summary_only: 1,
  private: 2,
};

/** 취소 승격 결과(로깅용). */
interface CancellationOutcome {
  status: TransactionStatus;
  linked: boolean;
  skipped: boolean;
}

@Injectable()
export class TransactionPromotionService {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    @Inject(DB) private readonly db: Db,
    // 미분류 승격 시 LLM 카테고리 제안을 트리거하는 category-suggest 큐(생산자).
    @InjectQueue(QUEUE_NAMES.CATEGORY_SUGGEST)
    private readonly categorySuggestQueue: Queue,
    configService: ConfigService,
  ) {
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:transaction-promotion', {
      pretty: nodeEnv !== 'production',
    });
  }

  /**
   * 파싱 이벤트를 거래로 승격한다(스펙 §6 절차). 승격 대상이 아니거나 이미 승격된
   * 경우 조용히 skip한다(멱등). 예외는 상위(잡)로 전파해 재시도되게 둔다.
   */
  async promote(cardSmsEventId: string): Promise<void> {
    if (!cardSmsEventId) {
      throw new Error('promote() called without cardSmsEventId');
    }

    // 1. 이벤트 조회 + 승격 대상 판정.
    const [event] = await this.db
      .select()
      .from(schema.cardSmsEvents)
      .where(eq(schema.cardSmsEvents.id, cardSmsEventId))
      .limit(1);

    if (!event) {
      this.logger.warn({ cardSmsEventId }, 'promotion skipped: event not found');
      return;
    }

    if (event.parseStatus !== 'parsed' && event.parseStatus !== 'pending_review') {
      this.logger.info(
        { cardSmsEventId, parseStatus: event.parseStatus },
        'promotion skipped: parse status not promotable',
      );
      return;
    }

    const amount = event.amount;
    if (amount === null) {
      this.logger.info({ cardSmsEventId }, 'promotion skipped: amount missing');
      return;
    }
    // KRW 정수 불변식(부동소수 차단, PRD §10). 파서 결함을 여기서도 막는다.
    assertKrwInteger(amount);

    const transactionType = event.transactionType;
    if (transactionType !== 'approval' && transactionType !== 'cancellation') {
      this.logger.info(
        { cardSmsEventId, transactionType },
        'promotion skipped: transaction type not promotable',
      );
      return;
    }

    // 2. 멱등 사전 점검(이미 승격됨 → skip). 실질 보증은 insert의 onConflictDoNothing.
    const [existing] = await this.db
      .select({ id: schema.cardTransactions.id })
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.sourceEventId, event.id))
      .limit(1);

    if (existing) {
      this.logger.info(
        { cardSmsEventId, transactionType, status: 'already_promoted' },
        'promotion skipped: already promoted',
      );
      return;
    }

    // 3. 카드 자동연결(뒤 4자리) → cardId, visibility 상속.
    const link = await this.resolveCard(event.householdId, event.maskedCardNumber);

    // 4. 가맹점 정규화(원문 없으면 null).
    const merchantNormalized = event.merchantRaw
      ? normalizeMerchant(event.merchantRaw)
      : null;

    // 5. 카테고리: 사용자 규칙 → 키워드(시스템 카테고리) → null.
    const categoryId = await this.resolveCategoryId(
      event.householdId,
      event.merchantRaw,
      merchantNormalized,
    );

    // 6/7. 거래유형별 승격.
    if (transactionType === 'approval') {
      const status = await this.promoteApproval(
        event,
        amount,
        link,
        merchantNormalized,
        categoryId,
      );
      this.logger.info(
        { cardSmsEventId, transactionType, status },
        'promotion completed',
      );
      // 새로 승격됐고 미분류면 LLM 카테고리 제안을 enqueue(가맹점 단위 dedupe).
      if (status !== 'already_promoted' && categoryId === null) {
        await this.enqueueCategorySuggestion(event, merchantNormalized);
      }
      return;
    }

    const outcome = await this.promoteCancellation(
      event,
      amount,
      link,
      merchantNormalized,
      categoryId,
    );
    this.logger.info(
      {
        cardSmsEventId,
        transactionType,
        status: outcome.skipped ? 'already_promoted' : outcome.status,
        linked: outcome.linked,
      },
      outcome.skipped ? 'promotion skipped: already promoted' : 'promotion completed',
    );
    if (!outcome.skipped && categoryId === null) {
      await this.enqueueCategorySuggestion(event, merchantNormalized);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 승인 승격                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * 승인 거래를 승격한다(스펙 §6.6). 카드 자동연결이 모호하면(뒤 4자리 중복)
   * status='pending_review'로 남겨 검토를 유도한다. 그렇지 않으면 2차 유사중복이면
   * 'duplicate_suspected', 아니면 'approved'. netAmount=amount, cancelledAmount=0,
   * approvedAt=occurredAt. onConflictDoNothing(sourceEventId)로 재승격을 흡수한다.
   *
   * @returns 실제 기록된 status. 경합으로 삽입되지 않았으면 'already_promoted'.
   */
  private async promoteApproval(
    event: schema.CardSmsEvent,
    amount: number,
    link: CardLink,
    merchantNormalized: string | null,
    categoryId: string | null,
  ): Promise<TransactionStatus | 'already_promoted'> {
    // 모호 매칭은 cardId=null이라 중복 판정 기준(카드)이 없고, '어느 카드인지 미정'
    // 자체가 검토 대상이므로 중복 검사를 건너뛰고 pending_review로 확정한다.
    let status: TransactionStatus;
    if (link.ambiguous) {
      status = 'pending_review';
    } else {
      const isDuplicate = await this.isDuplicateApproval(
        event.householdId,
        link.cardId,
        amount,
        merchantNormalized,
        event.occurredAt,
      );
      status = isDuplicate ? 'duplicate_suspected' : 'approved';
    }

    const [inserted] = await this.db
      .insert(schema.cardTransactions)
      .values({
        householdId: event.householdId,
        memberId: event.memberId,
        cardId: link.cardId,
        sourceEventId: event.id,
        transactionType: 'approval',
        status,
        amount,
        cancelledAmount: 0,
        netAmount: amount,
        currency: event.currency ?? 'KRW',
        merchantRaw: event.merchantRaw ?? null,
        merchantNormalized,
        categoryId,
        approvedAt: event.occurredAt ?? null,
        cancelledAt: null,
        // card_sms_events/파서에 승인번호가 없어 항상 null(향후 파서 확장 대비).
        authorizationCode: null,
        installmentMonths: event.installmentMonths ?? null,
        parentTransactionId: null,
        visibility: link.visibility,
        memo: null,
      })
      .onConflictDoNothing({ target: schema.cardTransactions.sourceEventId })
      .returning({ id: schema.cardTransactions.id });

    return inserted ? status : 'already_promoted';
  }

  /**
   * 2차 유사중복 판정: 같은 household/card, 동일 amount, 유사(정확) merchantNormalized,
   * 승인시각 ±DUPLICATE_TIME_WINDOW_MS 근접한 기존 승인이 있으면 true.
   * occurredAt이 없으면 시각 비교 불가로 false(과도한 오탐 방지).
   */
  private async isDuplicateApproval(
    householdId: string,
    cardId: string | null,
    amount: number,
    merchantNormalized: string | null,
    occurredAt: Date | null,
  ): Promise<boolean> {
    if (!occurredAt) {
      return false;
    }

    const lower = new Date(occurredAt.getTime() - DUPLICATE_TIME_WINDOW_MS);
    const upper = new Date(occurredAt.getTime() + DUPLICATE_TIME_WINDOW_MS);

    const conditions: SQL[] = [
      eq(schema.cardTransactions.householdId, householdId),
      eq(schema.cardTransactions.transactionType, 'approval'),
      eq(schema.cardTransactions.amount, amount),
      gte(schema.cardTransactions.approvedAt, lower),
      lte(schema.cardTransactions.approvedAt, upper),
    ];
    conditions.push(
      cardId
        ? eq(schema.cardTransactions.cardId, cardId)
        : isNull(schema.cardTransactions.cardId),
    );
    if (merchantNormalized) {
      conditions.push(eq(schema.cardTransactions.merchantNormalized, merchantNormalized));
    }

    const [row] = await this.db
      .select({ id: schema.cardTransactions.id })
      .from(schema.cardTransactions)
      .where(and(...conditions))
      .limit(1);

    return Boolean(row);
  }

  /* ---------------------------------------------------------------------- */
  /* 취소 승격                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * 취소 거래를 승격한다(스펙 §6.7). 취소 레코드를 먼저 삽입(netAmount=0,
   * cancelledAt=occurredAt, status='pending_review')하고, 대응 승인이 유일하게
   * 탐색되면 연결한다: 취소 status='approved' + parentTransactionId, 승인
   * cancelledAmount 누적 / netAmount 재계산 / status(cancelled|partially_cancelled).
   * 다중·불명확·미탐색이면 취소 거래를 pending_review로 남긴다.
   *
   * 멱등: 삽입이 실제로 일어난 경우에만 승인 잔액을 갱신한다(재승격 시 이중 반영 방지).
   */
  private async promoteCancellation(
    event: schema.CardSmsEvent,
    amount: number,
    link: CardLink,
    merchantNormalized: string | null,
    categoryId: string | null,
  ): Promise<CancellationOutcome> {
    const cancelledAt = event.occurredAt ?? null;

    return this.db.transaction(async (tx): Promise<CancellationOutcome> => {
      // 취소 레코드 삽입(멱등). 경합/재승격은 onConflictDoNothing으로 흡수한다.
      const [inserted] = await tx
        .insert(schema.cardTransactions)
        .values({
          householdId: event.householdId,
          memberId: event.memberId,
          cardId: link.cardId,
          sourceEventId: event.id,
          transactionType: 'cancellation',
          status: 'pending_review',
          amount,
          cancelledAmount: 0,
          netAmount: 0,
          currency: event.currency ?? 'KRW',
          merchantRaw: event.merchantRaw ?? null,
          merchantNormalized,
          categoryId,
          approvedAt: null,
          cancelledAt,
          authorizationCode: null,
          installmentMonths: event.installmentMonths ?? null,
          parentTransactionId: null,
          visibility: link.visibility,
          memo: null,
        })
        .onConflictDoNothing({ target: schema.cardTransactions.sourceEventId })
        .returning({ id: schema.cardTransactions.id });

      if (!inserted) {
        // 이미 승격됨 → 승인 잔액을 건드리지 않는다(멱등).
        return { status: 'pending_review', linked: false, skipped: true };
      }

      // 대응 승인 탐색: 같은 household/card, 승인, 미완료(approved|partially_cancelled),
      // (가맹점 일치 시) 동일 merchant, 승인이 취소보다 앞섬. 잔액 조건은 JS에서 판정.
      const candidateConditions: SQL[] = [
        eq(schema.cardTransactions.householdId, event.householdId),
        eq(schema.cardTransactions.transactionType, 'approval'),
        inArray(schema.cardTransactions.status, ['approved', 'partially_cancelled']),
      ];
      candidateConditions.push(
        link.cardId
          ? eq(schema.cardTransactions.cardId, link.cardId)
          : isNull(schema.cardTransactions.cardId),
      );
      if (merchantNormalized) {
        candidateConditions.push(
          eq(schema.cardTransactions.merchantNormalized, merchantNormalized),
        );
      }
      if (cancelledAt) {
        candidateConditions.push(lt(schema.cardTransactions.approvedAt, cancelledAt));
      }

      const candidates = await tx
        .select()
        .from(schema.cardTransactions)
        .where(and(...candidateConditions))
        .orderBy(desc(schema.cardTransactions.approvedAt));

      // 잔액(amount - cancelledAmount)이 취소액 이상인 승인만 후보로 남긴다.
      const matches = candidates.filter(
        (approval) => approval.amount - approval.cancelledAmount >= amount,
      );

      // 유일 매칭만 연결한다. 0개/2개 이상은 애매 → 취소 거래를 pending_review로 유지.
      if (matches.length !== 1) {
        return { status: 'pending_review', linked: false, skipped: false };
      }

      const approval = matches[0];
      const newCancelledAmount = approval.cancelledAmount + amount;
      const newNetAmount = approval.amount - newCancelledAmount;
      assertKrwInteger(newNetAmount);
      const approvalStatus: TransactionStatus =
        newCancelledAmount >= approval.amount ? 'cancelled' : 'partially_cancelled';
      const now = new Date();

      await tx
        .update(schema.cardTransactions)
        .set({
          cancelledAmount: newCancelledAmount,
          netAmount: newNetAmount,
          status: approvalStatus,
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
        .where(eq(schema.cardTransactions.id, inserted.id));

      return { status: approvalStatus, linked: true, skipped: false };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 카드 자동연결 / 카테고리                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * 파서 maskedCardNumber 뒤 4자리로 같은 household의 활성 카드를 찾아 연결한다
   * (스펙 §1.5). 저장 포맷 차이('1234' vs '****1234')를 흡수하려 양쪽에서 숫자만
   * 추출해 뒤 4자리를 비교한다.
   *
   * - 매칭 0건: cardId=null, visibility='household'.
   * - 매칭 1건: 그 카드에 연결하고 카드 visibility를 상속.
   * - 매칭 2건 이상(뒤 4자리 중복): 어느 카드인지 확정 불가. 임의 카드에 붙이면
   *   비결정적이고 private↔household 오상속(누출) 위험이 있으므로, 연결하지 않고
   *   (cardId=null) 후보 중 가장 제한적인 visibility를 상속해 프라이버시 하향을
   *   막는다. ambiguous=true로 표시해 승인 승격이 pending_review로 남긴다.
   */
  private async resolveCard(
    householdId: string,
    maskedCardNumber: string | null,
  ): Promise<CardLink> {
    const tail = lastFourDigits(maskedCardNumber);
    if (!tail) {
      return { cardId: null, visibility: 'household', ambiguous: false };
    }

    const cards = await this.db
      .select({
        id: schema.paymentCards.id,
        maskedNumber: schema.paymentCards.maskedNumber,
        visibility: schema.paymentCards.visibility,
      })
      .from(schema.paymentCards)
      .where(
        and(
          eq(schema.paymentCards.householdId, householdId),
          eq(schema.paymentCards.status, 'active'),
        ),
      );

    const matches = cards.filter(
      (card) => lastFourDigits(card.maskedNumber) === tail,
    );

    if (matches.length === 0) {
      return { cardId: null, visibility: 'household', ambiguous: false };
    }
    if (matches.length === 1) {
      return {
        cardId: matches[0].id,
        visibility: matches[0].visibility,
        ambiguous: false,
      };
    }

    // 뒤 4자리 중복 → 확정 불가. 로그는 식별자/건수만(카드번호·PII 미기록).
    this.logger.warn(
      { householdId, matchCount: matches.length },
      'card auto-link ambiguous: multiple active cards share the last 4 digits; left unlinked for review',
    );
    return {
      cardId: null,
      visibility: mostRestrictiveVisibility(matches.map((c) => c.visibility)),
      ambiguous: true,
    };
  }

  /**
   * 카테고리 우선순위(스펙 §1.3, LLM 제외):
   * 1) merchant_category_rules(household, merchantNormalized 정확매칭)
   * 2) 키워드(categorizeByKeyword → slug → 시스템 expense_categories id)
   * 3) 미분류(null).
   */
  private async resolveCategoryId(
    householdId: string,
    merchantRaw: string | null,
    merchantNormalized: string | null,
  ): Promise<string | null> {
    if (merchantNormalized) {
      const [rule] = await this.db
        .select({ categoryId: schema.merchantCategoryRules.categoryId })
        .from(schema.merchantCategoryRules)
        .where(
          and(
            eq(schema.merchantCategoryRules.householdId, householdId),
            eq(schema.merchantCategoryRules.merchantPattern, merchantNormalized),
          ),
        )
        .limit(1);
      if (rule) {
        return rule.categoryId;
      }
    }

    const keywordSource = merchantNormalized ?? merchantRaw;
    if (keywordSource) {
      const slug = categorizeByKeyword(keywordSource);
      if (slug) {
        const [category] = await this.db
          .select({ id: schema.expenseCategories.id })
          .from(schema.expenseCategories)
          .where(
            and(
              eq(schema.expenseCategories.slug, slug),
              isNull(schema.expenseCategories.householdId),
            ),
          )
          .limit(1);
        if (category) {
          return category.id;
        }
      }
    }

    return null;
  }

  /**
   * 미분류(categoryId=null)로 승격된 거래의 가맹점에 대해 LLM 카테고리 제안 잡을
   * enqueue 한다(카테고리 우선순위의 LLM tier — 가맹점 단위 1회, 비동기 자가학습).
   *
   * - jobId = `catsug_${householdId}_${md5(merchantNormalized)}` — BullMQ 커스텀
   *   jobId 에는 ':' 를 쓸 수 없어 밑줄을 사용하고, 같은 가맹점의 반복 승격이
   *   만드는 중복 enqueue 를 흡수한다(dedupe). removeOnComplete 로 완료 잡을
   *   제거해 이후 재제안(예: 규칙 삭제 후 재수집)이 가능하다.
   * - merchant 가 없으면 enqueue 하지 않는다(제안 대상 없음).
   * - enqueue 실패는 승격을 실패시키지 않는다(best-effort 부가 기능). 잡 재시도
   *   시 이미 승격된 이벤트는 조기 반환되어 재-enqueue 기회가 없으므로, 예외를
   *   전파해도 제안만 잃는다 — warn 로그 후 흡수한다.
   */
  private async enqueueCategorySuggestion(
    event: schema.CardSmsEvent,
    merchantNormalized: string | null,
  ): Promise<void> {
    if (!merchantNormalized) {
      return;
    }
    const merchantHash = createHash('md5').update(merchantNormalized).digest('hex');
    try {
      await this.categorySuggestQueue.add(
        'suggest',
        {
          householdId: event.householdId,
          merchantNormalized,
          merchantRaw: event.merchantRaw ?? merchantNormalized,
        },
        {
          jobId: `catsug_${event.householdId}_${merchantHash}`,
          removeOnComplete: true,
        },
      );
    } catch {
      // 로그는 식별자/해시 일부만(가맹점 원문·PII 미기록).
      this.logger.warn(
        { cardSmsEventId: event.id, merchantHash: merchantHash.slice(0, 12) },
        'category-suggest enqueue failed; transaction stays unclassified',
      );
    }
  }
}

/**
 * 후보 카드 visibility 중 가장 제한적인 값을 고른다(private > summary_only >
 * household). 뒤 4자리 모호 매칭 시 프라이버시 하향(예: private 지출이 household로
 * 노출)을 막기 위한 보수적 상속. `visibilities`는 비어 있지 않다고 가정한다.
 */
function mostRestrictiveVisibility(
  visibilities: readonly CardVisibility[],
): CardVisibility {
  return visibilities.reduce((acc, v) =>
    VISIBILITY_RANK[v] > VISIBILITY_RANK[acc] ? v : acc,
  );
}

/**
 * 마스킹 카드번호에서 숫자만 추출해 뒤 4자리를 반환한다. 4자리 미만이면 null
 * (신뢰할 수 없는 매칭 방지). 예: '****1234' → '1234', '1234' → '1234'.
 */
function lastFourDigits(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length < CARD_TAIL_LENGTH) {
    return null;
  }
  return digits.slice(-CARD_TAIL_LENGTH);
}
