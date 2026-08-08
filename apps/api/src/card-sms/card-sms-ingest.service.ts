/**
 * Card-SMS ingestion service (Phase 3 Build Spec §5.2).
 *
 * Accepts an HMAC-authenticated card-SMS payload from a registered device,
 * persists the raw text twice (a generic `source_items` record + a convenience
 * copy on `card_sms_events.rawContent`), stores the original bytes in MinIO, and
 * enqueues an asynchronous parse job.
 *
 * ## 멱등성 (PRD §14 / spec §1.2 / P0-9)
 *
 * `UNIQUE(device_id, event_id)`가 정본이다. 문제는 **`event_id`를 누가 정하느냐**다.
 * 호출자가 주면 그 값이 정본이고(= 재시도와 별개 결제를 호출자가 구분해 준다), 주지
 * 않으면 서버가 파생해야 한다. 파생 규칙과 그 판단 근거는
 * `@family/database`의 `card-sms-idempotency.ts`에 있다.
 *
 * 파생 경로에서 서버는 원리적으로 "재시도"와 "우연히 같은 문자를 만든 별개 결제"를
 * 구분할 수 없다. 이 서비스가 하는 일은 딜레마를 없애는 게 아니라 **손실을 유한하게
 * 만들고 흔적을 남기는 것**이다:
 *
 * 1. 시간 축이 전혀 없던 옛 규칙(`sha256(sender+content)`)을 몇 분 창으로 좁혔다 —
 *    창이 지나면 같은 문자도 별개 이벤트가 된다(그전에는 **영구히** 하나였다).
 * 2. 중복으로 판정해 버린 시도는 원문째로 `card_sms_ingest_suppressions`에 남긴다.
 *    오판으로 밝혀졌을 때 복구할 근거다 — 지금까지는 아무것도 남지 않았다.
 * 3. 어느 경로로 처리됐는지(`key_source`)를 저장·응답·로그에 남긴다. 멱등 키를 언제
 *    필수화해도 되는지 판단할 유일한 근거다.
 *
 * ⚠️ 계약을 필수로 바꾸지 않는 이유: 이미 배포된 MacroDroid·iOS 단축어가 `eventId`를
 * 보내지 않는다. 필수화하면 모든 기존 사용자의 수집이 즉시 끊긴다 — 카드 문자는 이
 * 서비스의 유일한 데이터 유입 경로이므로 그건 이 버그보다 나쁘다.
 *
 * Secret hygiene (spec §1.1): the raw SMS text and any PII are never logged —
 * only the event id, content hash, and processing status are emitted.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';

import type { CardSmsIngestRequest, CardSmsIngestResponse } from '@family/contracts';
import {
  isUniqueViolation,
  resolveCardSmsIdempotency,
  schema,
  type CardSmsKeySource,
  type CardSmsSuppressionReason,
  type Db,
} from '@family/database';
import { OUTBOX_EVENT_TYPES } from '@family/shared';

import { DB } from '../database/database.constants';
import type { DeviceContext } from '../devices/decorators/device.decorator';
import { ObjectStorageService } from '../storage/object-storage.service';

/**
 * 내부 전용 확장 입력. **계약(DTO)에 없는 필드는 HTTP 본문으로 들어올 수 없다** —
 * 전역 ZodValidationPipe가 미지의 키를 벗겨내므로 외부에서 주입할 수 없다.
 */
export interface CardSmsIngestInput extends CardSmsIngestRequest {
  /**
   * `card-sms-text` 경로의 `X-Received-At` 헤더(자유 형식). ISO가 아닐 수 있어
   * `receivedAt`으로 파싱하지는 못하지만 **시간 축으로는 유효하다** — 같은 문자의
   * 재전송이면 같은 문자열이 온다. 해시 재료로만 쓰고 저장하지 않는다.
   */
  receivedAtTag?: string;
  /**
   * 서버 수신 순간의 주입 지점. 창 경계 동작을 실제로 몇 분 기다리지 않고 검증하기
   * 위해서만 존재한다(`scripts/verify-card-sms-ingest.mjs`). 미지정이면 `new Date()`.
   */
  ingestedAt?: Date;
}

/** 중복 판정 결과 — 흡수된 기존 이벤트와 그 사유. */
interface DuplicateHit {
  reason: CardSmsSuppressionReason;
  /** 흡수 대상 이벤트의 UUID. 경합 패배처럼 대상을 못 읽은 경우 null. */
  matchedId: string | null;
  /** 응답에 실을 키 — 호출자가 이 값으로 상태를 조회하므로 **실재하는** 키여야 한다. */
  matchedEventId: string;
}

/**
 * Internal sentinel thrown inside the ingest transaction when the event insert
 * conflicts, so the just-inserted `source_items` row rolls back (no orphan)
 * before the caller returns an idempotent `duplicate` response.
 */
class DuplicateEventError extends Error {
  constructor() {
    super('duplicate card-sms event');
    this.name = 'DuplicateEventError';
  }
}

@Injectable()
export class CardSmsIngestService {
  private readonly logger = new Logger(CardSmsIngestService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  /**
   * Ingests a card-SMS payload for the authenticated device. Only a freshly
   * created event triggers a MinIO write and a parse enqueue; a re-transmission
   * is a no-op that still returns `accepted:true` — 다만 이제는 **원문을 남기고**
   * 돌아간다(P0-9).
   */
  async ingest(
    device: DeviceContext,
    input: CardSmsIngestInput,
  ): Promise<CardSmsIngestResponse> {
    const ingestedAt = input.ingestedAt ?? new Date();
    const { eventId, keySource, contentHash, windowLowerBound } =
      resolveCardSmsIdempotency({
        eventId: input.eventId,
        sender: input.sender,
        content: input.content,
        receivedAt: input.receivedAt,
        receivedAtTag: input.receivedAtTag,
        ingestedAt,
      });

    // receivedAt is optional (automation tools like MacroDroid can't easily
    // format UTC) — fall back to the ingest instant.
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : ingestedAt;
    const objectKey = `card-sms/${device.householdId}/${eventId}.txt`;
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');

    const hit = await this.findDuplicate(device, {
      eventId,
      contentHash,
      windowLowerBound,
    });
    if (hit) {
      return this.absorb(device, input, {
        hit,
        eventId,
        keySource,
        contentHash,
        receivedAt,
      });
    }

    // Insert the source item and event atomically. A concurrent request that
    // wins the (deviceId, eventId) race is absorbed by onConflictDoNothing
    // (empty return) or a unique violation — both roll back and read as a
    // duplicate.
    let created: schema.CardSmsEvent | null;
    try {
      created = await this.db.transaction(async (tx) => {
        const [sourceItem] = await tx
          .insert(schema.sourceItems)
          .values({
            householdId: device.householdId,
            kind: 'card_sms',
            objectKey,
            contentHash,
            sizeBytes,
            deviceId: device.deviceId,
            memberId: device.memberId,
            receivedAt,
          })
          .returning();
        if (!sourceItem) {
          throw new Error('failed to create source item');
        }

        const [revision] = await tx
          .insert(schema.sourceRevisions)
          .values({
            sourceItemId: sourceItem.id,
            revision: 1,
            objectKey,
            contentHash,
            sizeBytes,
            parserSchemaVersion: 'card-sms-raw-v1',
            consentScope: { mode: 'household-only' },
            validFrom: receivedAt,
          })
          .returning({ id: schema.sourceRevisions.id });
        if (!revision) {
          throw new Error('failed to create card-SMS source revision');
        }
        await tx
          .update(schema.sourceItems)
          .set({ currentRevisionId: revision.id })
          .where(eq(schema.sourceItems.id, sourceItem.id));

        const [event] = await tx
          .insert(schema.cardSmsEvents)
          .values({
            householdId: device.householdId,
            memberId: device.memberId,
            deviceId: device.deviceId,
            sourceItemId: sourceItem.id,
            eventId,
            keySource,
            sender: input.sender,
            rawContent: input.content,
            contentHash,
            receivedAt,
            parseStatus: 'pending',
          })
          .onConflictDoNothing({
            target: [schema.cardSmsEvents.deviceId, schema.cardSmsEvents.eventId],
          })
          .returning();

        if (!event) {
          throw new DuplicateEventError();
        }
        await tx.insert(schema.dataEvents).values({
          aggregateType: 'card_sms_event',
          aggregateId: event.id,
          eventType: OUTBOX_EVENT_TYPES.SOURCE_CARD_SMS_RECEIVED,
          revisionId: revision.id,
          householdId: device.householdId,
          payload: { cardSmsEventId: event.id },
          occurredAt: receivedAt,
        });

        // 수집 건강 지표(온보딩 완주·수집 생존). lastSeenAt은 인증만 성공해도 갱신되므로
        // "인증은 되는데 문자 트리거가 안 걸림"을 구분하려면 별도 타임스탬프가 필요하다.
        // firstEventAt은 최초 1회만 박고(coalesce), lastEventAt은 매번 갱신한다.
        await tx
          .update(schema.registeredDevices)
          .set({
            // ⚠️ sql 템플릿에 Date를 그대로 보간하면 드라이버가 직렬화하지 못한다
            // (컬럼 타입 매퍼를 안 거침) — ISO 문자열 + 명시적 캐스트로 넘긴다.
            // lastEventAt처럼 평범한 컬럼 대입은 드리즐이 매퍼를 태우므로 무관하다.
            firstEventAt: sql`coalesce(${schema.registeredDevices.firstEventAt}, ${receivedAt.toISOString()}::timestamptz)`,
            lastEventAt: receivedAt,
          })
          .where(eq(schema.registeredDevices.id, device.deviceId));

        return event;
      });
    } catch (error) {
      if (error instanceof DuplicateEventError || isUniqueViolation(error)) {
        created = null;
      } else {
        throw error;
      }
    }

    if (!created) {
      // 경합에서 진 요청. 이긴 쪽과 같은 키이므로 응답 키는 그대로 쓸 수 있지만,
      // 원문은 여기서도 남긴다 — 경합 패배가 조용한 소실이 되면 안 된다.
      return this.absorb(device, input, {
        hit: { reason: 'insert_race', matchedId: null, matchedEventId: eventId },
        eventId,
        keySource,
        contentHash,
        receivedAt,
      });
    }

    // Best-effort raw-object write. A MinIO failure must not fail ingestion —
    // the DB rawContent copy lets the worker parse regardless — so we warn and
    // still enqueue.
    try {
      await this.storage.putObject(
        objectKey,
        input.content,
        'text/plain; charset=utf-8',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `card-sms putObject failed id=${created.id} (ingest continues): ${message}`,
      );
    }

    // key_source를 로그에 싣는 이유: "키 있는 수집이 몇 %인가"를 DB 조회 없이도
    // 추세로 볼 수 있어야 한다(원문·PII는 여전히 싣지 않는다).
    this.logger.log(
      `card-sms ingest accepted id=${created.id} hash=${contentHash.slice(0, 12)} key_source=${keySource} status=outbox_pending`,
    );
    return {
      accepted: true,
      eventId,
      processingStatus: 'queued',
      duplicate: false,
      idempotencySource: keySource,
    };
  }

  /* ---------------------------------------------------------------------- */

  /**
   * 중복 판정 — 두 단계다.
   *
   * 1. **정확 키 일치**: `(device, event_id)` 행이 이미 있으면 정상 멱등이다.
   * 2. **지문 + 슬라이딩 창**: 파생 창 경로에서만 본다. 창을 키에 섞으면 같은 창 안의
   *    동시 재시도는 UNIQUE가 흡수하지만, 창 **경계**를 사이에 두고 갈라진 재시도
   *    (예: 179초/181초)는 키가 달라 제약으로 못 잡는다. 그 구멍을 지문 조회가 막는다.
   *
   * 2단계를 호출자가 시간 축을 준 경로에 적용하지 않는 이유: 호출자가 이미 "이 둘은
   * 다른 시각의 이벤트"라고 말했는데 서버가 창을 덧씌우면 그 말을 뒤집게 된다.
   *
   * 이 조회는 배포 이전 행과도 맞물린다 — `content_hash`는 키 형식과 무관하게 예전부터
   * 같은 규칙(`sha256(sender\ncontent)`)으로 채워져 왔다. 그래서 배포 직후 옛 키로
   * 저장된 이벤트의 재시도가 중복 폭증을 만들지 않는다.
   */
  private async findDuplicate(
    device: DeviceContext,
    key: { eventId: string; contentHash: string; windowLowerBound: Date | null },
  ): Promise<DuplicateHit | null> {
    const [exact] = await this.db
      .select({
        id: schema.cardSmsEvents.id,
        eventId: schema.cardSmsEvents.eventId,
      })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.deviceId, device.deviceId),
          eq(schema.cardSmsEvents.eventId, key.eventId),
        ),
      )
      .limit(1);
    if (exact) {
      return {
        reason: 'event_id_conflict',
        matchedId: exact.id,
        matchedEventId: exact.eventId,
      };
    }

    if (!key.windowLowerBound) return null;

    const [near] = await this.db
      .select({
        id: schema.cardSmsEvents.id,
        eventId: schema.cardSmsEvents.eventId,
      })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.deviceId, device.deviceId),
          eq(schema.cardSmsEvents.contentHash, key.contentHash),
          gt(schema.cardSmsEvents.receivedAt, key.windowLowerBound),
        ),
      )
      // 창 안에 여러 건이면 가장 최근 것에 붙인다 — 재시도는 직전 것의 재전송이다.
      .orderBy(desc(schema.cardSmsEvents.receivedAt))
      .limit(1);
    if (!near) return null;

    return {
      reason: 'fingerprint_window',
      matchedId: near.id,
      matchedEventId: near.eventId,
    };
  }

  /**
   * 중복으로 흡수한다 — **원문을 남긴 뒤** 멱등 응답을 돌려준다.
   *
   * 보관이 실패해도 수집 응답은 성공시킨다: 보관은 복구를 위한 보험이고, 그 보험 때문에
   * 자동화가 재시도 루프에 빠지면 원래 문제(수집 중단)가 커진다. 대신 warn을 남긴다.
   */
  private async absorb(
    device: DeviceContext,
    input: CardSmsIngestInput,
    context: {
      hit: DuplicateHit;
      eventId: string;
      keySource: CardSmsKeySource;
      contentHash: string;
      receivedAt: Date;
    },
  ): Promise<CardSmsIngestResponse> {
    const { hit, eventId, keySource, contentHash, receivedAt } = context;
    try {
      await this.db
        .insert(schema.cardSmsIngestSuppressions)
        .values({
          householdId: device.householdId,
          memberId: device.memberId,
          deviceId: device.deviceId,
          eventId,
          keySource,
          reason: hit.reason,
          matchedEventId: hit.matchedId,
          sender: input.sender,
          rawContent: input.content,
          contentHash,
          firstSeenAt: receivedAt,
          lastSeenAt: receivedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.cardSmsIngestSuppressions.deviceId,
            schema.cardSmsIngestSuppressions.eventId,
            schema.cardSmsIngestSuppressions.contentHash,
          ],
          set: {
            // 같은 시도가 여러 번 오면 행을 늘리지 않고 횟수만 센다. 목적은 "무엇이
            // 버려졌는가"이지 낱개 이력이 아니다.
            attempts: sql`${schema.cardSmsIngestSuppressions.attempts} + 1`,
            lastSeenAt: sql`greatest(${schema.cardSmsIngestSuppressions.lastSeenAt}, excluded.last_seen_at)`,
            // 처음 판정 때 대상을 못 읽었더라도(경합) 나중에 채워질 수 있다.
            matchedEventId: sql`coalesce(${schema.cardSmsIngestSuppressions.matchedEventId}, excluded.matched_event_id)`,
            reason: hit.reason,
            updatedAt: sql`now()`,
          },
        });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `card-sms suppression persist failed hash=${contentHash.slice(0, 12)} reason=${hit.reason} (ingest continues): ${message}`,
      );
    }

    this.logger.log(
      `card-sms ingest duplicate id=${hit.matchedId ?? 'unknown'} hash=${contentHash.slice(0, 12)} key_source=${keySource} reason=${hit.reason} status=duplicate`,
    );
    return {
      accepted: true,
      // 새로 파생한 키가 아니라 **흡수된 이벤트의 키**를 돌려준다 — 파생 키는 DB에
      // 없으므로 호출자가 그 값으로 상태를 조회하면 아무것도 못 찾는다.
      eventId: hit.matchedEventId,
      processingStatus: 'duplicate',
      duplicate: true,
      idempotencySource: keySource,
    };
  }
}
