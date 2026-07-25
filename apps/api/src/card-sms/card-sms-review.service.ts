/**
 * 격리·실패 카드 문자의 사람 검토 확정 (ADR-0023 S3).
 *
 * L2(LLM span 추출)가 만든 `quarantined` 건과 규칙 파서가 못 읽은 `parse_failed`
 * 건을 사람이 확인·교정해 확정한다. 확정은 두 가지를 동시에 한다:
 *
 * 1. **거래 승격** — 확정된 값으로 `card_transactions`를 만든다(declined 제외).
 * 2. **학습 라벨 생산** — `feedback_events(source:'human_confirmed')`에 템플릿 지문과
 *    함께 기록한다. 이것이 S4 추출 레시피의 씨앗이자 플라이휠의 입력이다.
 *
 * 승격은 워커(TransactionPromotionService)가 아니라 여기서 **동기 직접 삽입**한다 —
 * 워커를 태우면 재파싱이 사람의 교정을 덮어쓴다. 수동 입력(manual-fields)과 같은 방식이다.
 *
 * 대상 상태를 `quarantined`·`parse_failed`로 제한하는 이유: 둘 다 **승격되지 않은**
 * 상태라 거래를 새로 만들어도 중복이 없다. `pending_review`는 이름과 달리 이미 승격된
 * 상태이므로(promotion.service가 수용) 여기서 다루지 않는다 — 그건 거래 수정 경로다.
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
  deriveRecipe,
  templateFingerprint,
  templateSkeleton,
} from '@family/card-parsers';
import type { CardSmsReviewRequest, CardSmsReviewResponse } from '@family/contracts';
import { schema, type Db } from '@family/database';
import { normalizeMerchant } from '@family/shared';
import { and, eq } from 'drizzle-orm';

import { DB } from '../database/database.constants';

/** 검토 확정이 가능한 상태 — 둘 다 아직 거래로 승격되지 않았다. */
const REVIEWABLE_STATUSES = ['quarantined', 'parse_failed'] as const;

/** feedback_events.labelSchemaVersion — 라벨 해석 규칙이 바뀌면 올린다. */
const LABEL_SCHEMA_VERSION = 'card-sms-parse-v1';

const FEEDBACK_TARGET_TYPE = 'card-sms-parse';

@Injectable()
export class CardSmsReviewService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 사람이 확인한 값으로 이벤트를 확정하고 거래를 만든다. */
  async review(
    userId: string,
    cardSmsEventId: string,
    input: CardSmsReviewRequest,
  ): Promise<CardSmsReviewResponse> {
    const [event] = await this.db
      .select()
      .from(schema.cardSmsEvents)
      .where(eq(schema.cardSmsEvents.id, cardSmsEventId))
      .limit(1);
    if (!event) {
      throw new NotFoundException('card-sms event not found');
    }
    await this.requireMembership(event.householdId, userId);

    if (!REVIEWABLE_STATUSES.includes(event.parseStatus as (typeof REVIEWABLE_STATUSES)[number])) {
      throw new ConflictException(
        `card-sms event is not reviewable (parseStatus=${event.parseStatus})`,
      );
    }

    const declined = input.transactionType === 'declined';
    const currency = input.currency.toUpperCase();
    // 거래를 만들 건이면 금액·시각·가맹점이 모두 있어야 한다. declined는 기록만 남긴다.
    if (!declined) {
      if (input.amount === undefined || input.amount <= 0) {
        throw new BadRequestException('amount is required for a non-declined review');
      }
      if (input.occurredAt === undefined) {
        throw new BadRequestException('occurredAt is required for a non-declined review');
      }
      if (input.merchantRaw === undefined) {
        throw new BadRequestException('merchantRaw is required for a non-declined review');
      }
    }

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : null;
    const now = new Date();
    // 지문은 라벨의 핵심 키다 — 같은 레이아웃의 다음 문자가 이 확정을 재사용한다(S4).
    const fingerprint = templateFingerprint(event.sender, event.rawContent);

    return this.db.transaction(async (tx): Promise<CardSmsReviewResponse> => {
      // 카드가 지정되면 소유·활성 검증 후 visibility 상속(없으면 household).
      let visibility: schema.CardTransaction['visibility'] = 'household';
      if (input.cardId) {
        const [card] = await tx
          .select({ visibility: schema.paymentCards.visibility })
          .from(schema.paymentCards)
          .where(
            and(
              eq(schema.paymentCards.id, input.cardId),
              eq(schema.paymentCards.householdId, event.householdId),
              eq(schema.paymentCards.status, 'active'),
            ),
          )
          .limit(1);
        if (!card) {
          throw new BadRequestException('card not found in household');
        }
        visibility = card.visibility;
      }

      // ① 이벤트를 사람 확정 값으로 갱신. declined는 승격 대상이 아니므로 parsed로 두어도
      //    거래가 생기지 않는다(promotion은 이 경로를 타지 않는다).
      await tx
        .update(schema.cardSmsEvents)
        .set({
          parseStatus: 'parsed',
          parseError: null,
          transactionType: input.transactionType,
          amount: input.amount ?? null,
          currency: input.amount !== undefined ? currency : null,
          merchantRaw: input.merchantRaw ?? null,
          occurredAt,
          issuer: input.issuer ?? event.issuer,
          installmentMonths: input.installmentMonths ?? null,
          // 사람이 확인했으므로 최대 신뢰도.
          confidence: 100,
          parsedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.cardSmsEvents.id, cardSmsEventId));

      // ② 학습 라벨. 값과 함께 **지문**을 남겨야 S4가 레이아웃 단위로 재사용할 수 있다.
      await tx.insert(schema.feedbackEvents).values({
        householdId: event.householdId,
        targetType: FEEDBACK_TARGET_TYPE,
        targetId: cardSmsEventId,
        predictionTraceId: null,
        labelSchemaVersion: LABEL_SCHEMA_VERSION,
        label: {
          fingerprint,
          sender: event.sender,
          transactionType: input.transactionType,
          amount: input.amount ?? null,
          currency: input.amount !== undefined ? currency : null,
          merchantRaw: input.merchantRaw ?? null,
          occurredAt: occurredAt?.toISOString() ?? null,
          installmentMonths: input.installmentMonths ?? null,
          /** 교정 전 파서 결과 — 무엇이 틀렸는지 학습·관측에 필요하다. */
          previous: {
            parseStatus: event.parseStatus,
            transactionType: event.transactionType,
            amount: event.amount,
            currency: event.currency,
            merchantRaw: event.merchantRaw,
            occurredAt: event.occurredAt?.toISOString() ?? null,
          },
        },
        source: 'human_confirmed',
        actorUserId: userId,
        occurredAt: now,
      });

      // ②-b 추출 레시피 유도(ADR-0023 S4). 이 확정 한 건으로 같은 레이아웃의 다음
      //     문자는 LLM 없이 결정적으로 추출된다. 실패(필드 0개)면 저장하지 않는다.
      const recipe = deriveRecipe(
        {
          sender: event.sender,
          content: event.rawContent,
          receivedAt: event.receivedAt,
        },
        {
          transactionType: input.transactionType,
          issuer: input.issuer ?? event.issuer,
          ...(input.amount !== undefined ? { amount: input.amount, currency } : {}),
          ...(input.merchantRaw !== undefined ? { merchantRaw: input.merchantRaw } : {}),
          ...(occurredAt !== null ? { occurredAt } : {}),
          ...(input.installmentMonths !== undefined
            ? { installmentMonths: input.installmentMonths }
            : {}),
        },
        fingerprint,
      );
      if (Object.keys(recipe.fields).length > 0) {
        // 최신 확정이 이긴다 — 카드사가 문구를 바꾸면 지문도 바뀌므로 같은 지문의
        // 재확정은 "더 정확한 라벨"로 보는 것이 맞다.
        await tx
          .insert(schema.cardSmsTemplates)
          .values({
            fingerprint,
            sender: event.sender,
            skeleton: templateSkeleton(event.rawContent),
            recipe: recipe as unknown as Record<string, unknown>,
            sourceEventId: cardSmsEventId,
            confirmedBy: userId,
          })
          .onConflictDoUpdate({
            target: schema.cardSmsTemplates.fingerprint,
            set: {
              recipe: recipe as unknown as Record<string, unknown>,
              sourceEventId: cardSmsEventId,
              confirmedBy: userId,
              updatedAt: now,
            },
          });
      }

      // 거절은 실제 체결이 아니므로 거래를 만들지 않는다. (스키마도
      // card_transactions.transactionType에 'declined'를 허용하지 않는다.)
      if (input.transactionType === 'declined') {
        return { cardSmsEventId, parseStatus: 'parsed', transactionId: null };
      }
      const transactionType = input.transactionType;

      // ③ 거래 승격(동기). sourceEventId UNIQUE라 재확정은 충돌로 막힌다.
      const amount = input.amount as number;
      const merchantRaw = input.merchantRaw as string;
      const cancellation = transactionType === 'cancellation';
      const [txn] = await tx
        .insert(schema.cardTransactions)
        .values({
          householdId: event.householdId,
          memberId: event.memberId,
          cardId: input.cardId ?? null,
          sourceEventId: cardSmsEventId,
          transactionType,
          status: cancellation ? 'cancelled' : 'approved',
          amount,
          cancelledAmount: 0,
          // 취소 레코드의 netAmount는 0 규약(승인 쪽 cancelledAmount로 상계).
          netAmount: cancellation ? 0 : amount,
          currency,
          originalAmount: null,
          originalCurrency: null,
          exchangeRate: null,
          merchantRaw,
          merchantNormalized: normalizeMerchant(merchantRaw),
          categoryId: input.categoryId ?? null,
          approvedAt: cancellation ? null : occurredAt,
          cancelledAt: cancellation ? occurredAt : null,
          authorizationCode: null,
          installmentMonths: input.installmentMonths ?? null,
          parentTransactionId: null,
          visibility,
          memo: null,
        })
        .onConflictDoNothing({ target: schema.cardTransactions.sourceEventId })
        .returning({ id: schema.cardTransactions.id });

      if (!txn) {
        // 경합/재확정 — 이미 이 이벤트로 만들어진 거래가 있다.
        throw new ConflictException('a transaction already exists for this card-sms event');
      }
      return { cardSmsEventId, parseStatus: 'parsed', transactionId: txn.id };
    });
  }

  /** 비회원에게는 가구 존재 여부를 드러내지 않는 403을 준다(PRD §26). */
  private async requireMembership(householdId: string, userId: string): Promise<void> {
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
  }
}
