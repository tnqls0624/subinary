/**
 * 수동 거래 등록 서비스 (in-app 문자 붙여넣기 / 직접 입력).
 *
 * 자동화(MacroDroid/단축어)가 카드 알림을 놓치거나 불완전하게 캡처한 거래를
 * 사용자가 앱에서 직접 등록하기 위한 사용자 인증(AccessToken) 경로. 두 모드:
 *
 * - **parse-preview**: 붙여넣은 문자를 상태 없이 파싱해 인식 결과를 돌려준다(DB 미접근).
 * - **manual-text**: 문자를 일반 수집 파이프라인({@link CardSmsIngestService.ingest})으로
 *   태운다. 워커가 파싱·승격하므로 자동 유입과 동작이 100% 동일하다(카드연결/카테고리/
 *   중복판정/예산/알림). 가구별 합성 "수동" device를 소스로 쓴다(card_sms_events는
 *   device_id NOT NULL).
 * - **manual-fields**: 파싱 없이 사용자가 입력한 필드로 event(parsed)+거래를 **동기**
 *   삽입한다. 사용자가 카드·카테고리를 명시하므로 승격의 자동 해석과 충돌하지 않게
 *   worker를 우회하고 직접 삽입한다. v1은 승인(approval)만.
 *
 * 모든 경로는 호출자가 대상 가구의 active 구성원인지 먼저 확인한다(비회원 403,
 * 가구 존재 여부 미노출 — CardSmsQueryService와 동일 정책).
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { parseCardSms } from '@family/card-parsers';
import type {
  ManualFieldsEntryRequest,
  ManualParsePreviewRequest,
  ManualParsePreviewResponse,
  ManualTextEntryRequest,
  ManualTextEntryResponse,
  TransactionSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import { normalizeMerchant } from '@family/shared';

import { DB } from '../database/database.constants';
import { buildSummary } from '../transactions/transaction.service';
import { CardSmsIngestService } from './card-sms-ingest.service';

/** 가구별 합성 "수동" device 이름(재사용 조회 키). */
const MANUAL_DEVICE_NAME = '수동 입력';
/** manual-text의 기본 발신자 표시명(사용자가 미지정 시). */
const MANUAL_SENDER = '수동입력';

@Injectable()
export class ManualEntryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ingestService: CardSmsIngestService,
  ) {}

  /**
   * 붙여넣은 문자를 상태 없이 파싱해 미리보기 결과를 돌려준다. DB 미접근이라
   * 가구 스코프가 없어 멤버십 검사도 하지 않는다(민감정보 없음, 순수 파싱).
   */
  parsePreview(input: ManualParsePreviewRequest): ManualParsePreviewResponse {
    const result = parseCardSms({
      sender: input.sender?.trim() || MANUAL_SENDER,
      content: input.content,
      receivedAt: new Date(),
    });
    const parseable =
      result.transactionType !== 'unknown' &&
      result.amount != null &&
      result.currency != null;
    return {
      issuer: result.issuer ?? null,
      transactionType: result.transactionType,
      amount: result.amount ?? null,
      currency: result.currency ?? null,
      merchantRaw: result.merchantRaw ?? null,
      occurredAt: result.occurredAt ? result.occurredAt.toISOString() : null,
      installmentMonths: result.installmentMonths ?? null,
      maskedCardNumber: result.maskedCardNumber ?? null,
      confidence: result.confidence,
      warnings: result.warnings,
      parseable,
    };
  }

  /**
   * 문자를 일반 수집 파이프라인으로 태운다. 합성 "수동" device로 ingest를 호출하고,
   * 폴링용으로 방금 만들어진 card_sms_events.id(UUID)를 함께 돌려준다.
   */
  async manualText(
    userId: string,
    input: ManualTextEntryRequest,
  ): Promise<ManualTextEntryResponse> {
    const { deviceId, memberId } = await this.resolveManualDevice(
      input.householdId,
      userId,
    );

    const result = await this.ingestService.ingest(
      { deviceId, householdId: input.householdId, memberId },
      {
        sender: input.sender?.trim() || MANUAL_SENDER,
        content: input.content,
        receivedAt: input.receivedAt,
      },
    );

    // ingest 응답은 멱등 키(eventId)만 준다 — 폴링에 필요한 UUID는 (device, eventId)로 조회.
    const [event] = await this.db
      .select({ id: schema.cardSmsEvents.id })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.deviceId, deviceId),
          eq(schema.cardSmsEvents.eventId, result.eventId),
        ),
      )
      .limit(1);
    if (!event) {
      // 이론상 도달 불가(방금 ingest가 upsert). 방어적으로 명확히 실패시킨다.
      throw new BadRequestException('card-sms event not found after ingest');
    }

    return {
      eventId: result.eventId,
      cardSmsEventId: event.id,
      duplicate: result.duplicate,
    };
  }

  /**
   * 사용자가 입력한 필드로 event(parsed)+거래를 직접 삽입한다(worker 우회, 동기).
   * 카드가 지정되면 그 카드의 visibility를 상속한다. 카테고리는 사용자 지정값 그대로.
   */
  async manualFields(
    userId: string,
    input: ManualFieldsEntryRequest,
  ): Promise<TransactionSummary> {
    const { deviceId, memberId } = await this.resolveManualDevice(
      input.householdId,
      userId,
    );

    const currency = input.currency.toUpperCase();
    const occurredAt = new Date(input.occurredAt);
    const merchantNormalized = normalizeMerchant(input.merchantRaw);
    const eventId = `manual-${randomUUID()}`;
    // 감사용 원문 요약(파싱된 게 아니라 사용자 입력임을 명시).
    const rawContent = `[수동 입력] ${input.merchantRaw}\n${input.amount} ${currency}`;
    const contentHash = createHash('sha256')
      .update(`${MANUAL_SENDER}\n${rawContent}`, 'utf8')
      .digest('hex');
    const objectKey = `card-sms/manual/${input.householdId}/${eventId}.txt`;
    const sizeBytes = Buffer.byteLength(rawContent, 'utf8');
    const now = new Date();

    return this.db.transaction(async (tx): Promise<TransactionSummary> => {
      // 카드가 지정되면 소유·활성 검증 후 visibility 상속(없으면 household).
      let visibility: schema.CardTransaction['visibility'] = 'household';
      if (input.cardId) {
        const [card] = await tx
          .select({ visibility: schema.paymentCards.visibility })
          .from(schema.paymentCards)
          .where(
            and(
              eq(schema.paymentCards.id, input.cardId),
              eq(schema.paymentCards.householdId, input.householdId),
              eq(schema.paymentCards.status, 'active'),
            ),
          )
          .limit(1);
        if (!card) {
          throw new BadRequestException('card not found in household');
        }
        visibility = card.visibility;
      }

      const [sourceItem] = await tx
        .insert(schema.sourceItems)
        .values({
          householdId: input.householdId,
          kind: 'card_sms',
          objectKey,
          contentHash,
          sizeBytes,
          deviceId,
          memberId,
          receivedAt: occurredAt,
        })
        .returning({ id: schema.sourceItems.id });
      if (!sourceItem) {
        throw new Error('failed to create manual source item');
      }

      const [event] = await tx
        .insert(schema.cardSmsEvents)
        .values({
          householdId: input.householdId,
          memberId,
          deviceId,
          sourceItemId: sourceItem.id,
          eventId,
          sender: MANUAL_SENDER,
          rawContent,
          contentHash,
          receivedAt: occurredAt,
          parseStatus: 'parsed',
          issuer: input.issuer ?? null,
          transactionType: 'approval',
          amount: input.amount,
          currency,
          merchantRaw: input.merchantRaw,
          occurredAt,
          installmentMonths: input.installmentMonths ?? null,
          confidence: 100,
          parsedAt: now,
        })
        .returning({ id: schema.cardSmsEvents.id });
      if (!event) {
        throw new Error('failed to create manual card-sms event');
      }

      const [txn] = await tx
        .insert(schema.cardTransactions)
        .values({
          householdId: input.householdId,
          memberId,
          cardId: input.cardId ?? null,
          sourceEventId: event.id,
          transactionType: 'approval',
          status: 'approved',
          amount: input.amount,
          cancelledAmount: 0,
          netAmount: input.amount,
          currency,
          originalAmount: null,
          originalCurrency: null,
          exchangeRate: null,
          merchantRaw: input.merchantRaw,
          merchantNormalized,
          categoryId: input.categoryId ?? null,
          approvedAt: occurredAt,
          cancelledAt: null,
          authorizationCode: null,
          installmentMonths: input.installmentMonths ?? null,
          parentTransactionId: null,
          visibility,
          memo: null,
        })
        .returning();
      if (!txn) {
        throw new Error('failed to create manual transaction');
      }

      // 카테고리 slug(응답 매핑용). 사용자 지정 categoryId만 조회(없으면 null).
      let categorySlug: string | null = null;
      if (txn.categoryId) {
        const [category] = await tx
          .select({ slug: schema.expenseCategories.slug })
          .from(schema.expenseCategories)
          .where(eq(schema.expenseCategories.id, txn.categoryId))
          .limit(1);
        categorySlug = category?.slug ?? null;
      }

      // 본인 입력이므로 masked=false. buildSummary는 transaction.service의 정본 매퍼.
      return buildSummary(txn, categorySlug, false);
    });
  }

  /* ---------------------------------------------------------------------- */

  /**
   * 호출자가 대상 가구의 active 구성원인지 확인하고(비회원 403), 가구의 합성 "수동"
   * device를 find-or-create 해 `{ deviceId, memberId }`를 돌려준다. 이 검사가
   * 각 mutation의 인가 관문 역할을 한다(가구 존재 여부 미노출).
   */
  private async resolveManualDevice(
    householdId: string,
    userId: string,
  ): Promise<{ deviceId: string; memberId: string }> {
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

    const [existing] = await this.db
      .select({ id: schema.registeredDevices.id })
      .from(schema.registeredDevices)
      .where(
        and(
          eq(schema.registeredDevices.householdId, householdId),
          eq(schema.registeredDevices.name, MANUAL_DEVICE_NAME),
          eq(schema.registeredDevices.status, 'active'),
        ),
      )
      .limit(1);
    if (existing) {
      return { deviceId: existing.id, memberId: member.id };
    }

    const [created] = await this.db
      .insert(schema.registeredDevices)
      .values({
        householdId,
        memberId: member.id,
        name: MANUAL_DEVICE_NAME,
        platform: 'other',
        createdBy: userId,
      })
      .returning({ id: schema.registeredDevices.id });
    if (!created) {
      throw new Error('failed to create manual device');
    }
    return { deviceId: created.id, memberId: member.id };
  }
}
