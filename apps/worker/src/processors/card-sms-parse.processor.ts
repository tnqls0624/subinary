import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseCardSms } from '@family/card-parsers';
import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';
import { createLogger, QUEUE_NAMES } from '@family/shared';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';

import { DB } from '../database/database.module';
import { TransactionPromotionService } from '../promotion/transaction-promotion.service';

/**
 * 워커가 기록하는 card_sms_events.parseStatus(cardSmsParseStatus enum) 부분집합.
 * 수집 직후 'pending'은 API가 넣으며, 파싱 워커는 아래 셋 중 하나로 전이시킨다.
 */
type CardSmsParseStatus = 'parsed' | 'pending_review' | 'parse_failed';

/** card-sms-parse 잡 payload(스펙 §5.2: { cardSmsEventId }). */
interface CardSmsParseJobData {
  cardSmsEventId: string;
}

/** 잡 결과. 정상 파싱은 parseStatus, 레코드 미존재는 skipped 로 구분한다. */
type CardSmsParseJobResult =
  | { cardSmsEventId: string; parseStatus: CardSmsParseStatus }
  | { cardSmsEventId: string; skipped: true };

/** parsed 판정 최소 신뢰도(0~100 정수). 미만이면 사람 검토(pending_review)로 보낸다. */
const MIN_PARSED_CONFIDENCE = 70;

@Processor(QUEUE_NAMES.CARD_SMS_PARSE)
export class CardSmsParseProcessor extends WorkerHost {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly promotionService: TransactionPromotionService,
    configService: ConfigService,
  ) {
    super();
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:card-sms-parse-processor', {
      pretty: nodeEnv !== 'production',
    });
  }

  async process(job: Job<CardSmsParseJobData>): Promise<CardSmsParseJobResult> {
    const { cardSmsEventId } = job.data;

    if (!cardSmsEventId) {
      // 방어: payload 결손은 재시도해도 무의미하므로 즉시 실패시킨다(민감정보 없음).
      this.logger.warn(
        { jobId: job.id, queue: job.queueName },
        'card-sms parse job missing cardSmsEventId',
      );
      throw new Error('card-sms parse job payload is missing cardSmsEventId');
    }

    const [event] = await this.db
      .select()
      .from(schema.cardSmsEvents)
      .where(eq(schema.cardSmsEvents.id, cardSmsEventId))
      .limit(1);

    if (!event) {
      // 레코드 미존재(삭제/경합) — 재파싱 대상 없음. 로그 후 정상 종료.
      this.logger.warn(
        { jobId: job.id, cardSmsEventId, queue: job.queueName },
        'card-sms event not found; skipping parse',
      );
      return { cardSmsEventId, skipped: true };
    }

    const result = parseCardSms({
      sender: event.sender,
      content: event.rawContent,
      receivedAt: event.receivedAt,
    });

    // 금액은 KRW 정수만 허용(부동소수 금지, PRD §10). 파서 결함을 여기서 차단한다.
    const amount = result.amount ?? null;
    if (amount !== null && !Number.isInteger(amount)) {
      throw new Error(`parsed amount must be an integer (cardSmsEventId=${cardSmsEventId})`);
    }

    // 거래유형이 식별되고 금액이 있으면 신뢰도로 parsed/pending_review 분기,
    // 그 외(미식별·금액 없음)는 parse_failed 로 처리하고 warnings 를 parseError 에 남긴다.
    const isParseable = result.transactionType !== 'unknown' && amount !== null;
    let parseStatus: CardSmsParseStatus;
    let parseError: string | null;
    if (isParseable) {
      parseStatus = result.confidence >= MIN_PARSED_CONFIDENCE ? 'parsed' : 'pending_review';
      parseError = null;
    } else {
      parseStatus = 'parse_failed';
      parseError =
        result.warnings.length > 0 ? result.warnings.join('; ') : 'no parseable card transaction';
    }

    const now = new Date();

    await this.db
      .update(schema.cardSmsEvents)
      .set({
        issuer: result.issuer ?? null,
        transactionType: result.transactionType,
        amount,
        currency: result.currency ?? null,
        merchantRaw: result.merchantRaw ?? null,
        occurredAt: result.occurredAt ?? null,
        maskedCardNumber: result.maskedCardNumber ?? null,
        installmentMonths: result.installmentMonths ?? null,
        confidence: result.confidence,
        parseStatus,
        parseError,
        parsedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.cardSmsEvents.id, cardSmsEventId));

    // 로그는 식별자/상태/발급사/신뢰도만(원문·금액·가맹점 등 PII 미기록, 스펙 §1.1/§6).
    this.logger.info(
      {
        jobId: job.id,
        cardSmsEventId,
        eventId: event.eventId,
        issuer: result.issuer ?? null,
        parseStatus,
        confidence: result.confidence,
      },
      'card-sms event parsed',
    );

    // 파싱 성공(또는 사람 검토 필요) 건은 같은 잡 안에서 거래로 승격한다(스펙 §1.1/§6).
    // parse_failed는 승격 대상이 아니다. 승격 실패는 잡을 재시도하게 두되, 멱등
    // (sourceEventId UNIQUE)이라 재승격이 안전하다.
    if (parseStatus === 'parsed' || parseStatus === 'pending_review') {
      await this.promotionService.promote(cardSmsEventId);
    }

    return { cardSmsEventId, parseStatus };
  }
}
