/**
 * 푸시 알림 발송 프로세서 (`notification-dispatch` 큐).
 *
 * 거래 승격 파이프라인이 **새로 승격된** 거래마다 1건(jobId=`notif_${transactionId}`)
 * enqueue하면, 여기서 수신자를 해석하고 선호를 적용해 FCM으로 발송한다.
 *
 * 규약(절대):
 * - **발송 시점 DB 재조회로 visibility를 존중한다**(승격 후 사용자가 즉시 private
 *   으로 바꾼 경우 최신값 반영). transaction.service의 조회 규칙과 대칭:
 *     · household  → 가족 전원, 가맹점 노출
 *     · private    → 소유자(memberId→userId)에게만
 *     · summary_only → 전원, 단 소유자 외에는 가맹점 마스킹
 *   pending_review/duplicate_suspected(불확정)는 가족 방송 대신 소유자에게만.
 * - **선호 필터**: pushEnabled·minAmount·무음시간대·notifyOwnCollected(자기
 *   기기 수집분 알림 여부). 행이 없으면 기본값(전부 켬)으로 간주.
 * - **토큰 위생**: FCM이 UNREGISTERED/INVALID면 즉시 revoke. 5xx/429는 잡 재시도.
 *   토큰별 발송을 격리(allSettled)해 한 기기 실패가 전체를 실패시키지 않는다.
 * - FCM 미설정(dev/mock)이면 조기 종료(no-op).
 * - 로그에 금액·가맹점·토큰을 남기지 않는다 — 식별자/건수만.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';
import { createLogger, DEFAULT_TIMEZONE, QUEUE_NAMES } from '@family/shared';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB } from '../database/database.module';
import { FcmService, type FcmMessage } from '../notifications/fcm.service';

/** notification-dispatch 잡 payload(promotion이 enqueue). */
interface NotificationDispatchJobData {
  transactionId: string;
  householdId: string;
  /**
   * 이미 발송에 성공한 구독 토큰 id(재시도 간 중복 발송 방지). BullMQ는 재시도
   * 사이 job.data를 보존하므로 여기에 진행 상태를 누적한다.
   */
  sentTokenIds?: string[];
}

/** 잡 결과(관측용). */
interface NotificationDispatchJobResult {
  transactionId: string;
  outcome: 'sent' | 'skipped' | 'disabled';
  recipientCount: number;
  sentCount: number;
}

/** 발송 대상 1명분(수신 사용자 + 활성 구독 토큰들). 마스킹은 발송 시점에 판정. */
interface Recipient {
  userId: string;
  tokens: { id: string; token: string }[];
}

@Processor(QUEUE_NAMES.NOTIFICATION_DISPATCH)
export class NotificationDispatchProcessor extends WorkerHost {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fcm: FcmService,
    configService: ConfigService,
  ) {
    super();
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:notification-dispatch', {
      pretty: nodeEnv !== 'production',
    });
  }

  async process(
    job: Job<NotificationDispatchJobData>,
  ): Promise<NotificationDispatchJobResult> {
    const { transactionId } = job.data;
    const base = { jobId: job.id, transactionId };

    if (!this.fcm.enabled) {
      return { transactionId, outcome: 'disabled', recipientCount: 0, sentCount: 0 };
    }
    if (!transactionId) {
      this.logger.warn(base, 'notification skipped: missing transactionId');
      return { transactionId, outcome: 'skipped', recipientCount: 0, sentCount: 0 };
    }

    // 1. 거래 재조회(발송 시점 최신 visibility/상태).
    const [txn] = await this.db
      .select()
      .from(schema.cardTransactions)
      .where(eq(schema.cardTransactions.id, transactionId))
      .limit(1);
    if (!txn) {
      this.logger.warn(base, 'notification skipped: transaction not found');
      return { transactionId, outcome: 'skipped', recipientCount: 0, sentCount: 0 };
    }

    // 소유자 userId(거래 memberId → 활성 멤버십). status='active'로 좁혀
    // household/summary_only 브랜치와 대칭 유지(removed 소유자에게 발송하지 않음).
    const [ownerMember] = await this.db
      .select({ userId: schema.householdMembers.userId })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.id, txn.memberId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);
    if (!ownerMember) {
      return { transactionId, outcome: 'skipped', recipientCount: 0, sentCount: 0 };
    }
    const ownerUserId = ownerMember.userId;

    // 2. 수신 후보 userId 집합 결정(visibility + 불확정 상태 규칙).
    const uncertain =
      txn.status === 'pending_review' || txn.status === 'duplicate_suspected';
    const visibility = txn.visibility;

    let candidateUserIds: string[];
    let maskNonOwner = false;
    if (visibility === 'private' || uncertain) {
      candidateUserIds = [ownerUserId];
    } else {
      // household / summary_only → 가족 활성 구성원 전원.
      const members = await this.db
        .select({ userId: schema.householdMembers.userId })
        .from(schema.householdMembers)
        .where(
          and(
            eq(schema.householdMembers.householdId, txn.householdId),
            eq(schema.householdMembers.status, 'active'),
          ),
        );
      candidateUserIds = [...new Set(members.map((m) => m.userId))];
      maskNonOwner = visibility === 'summary_only';
    }

    // 3. 선호 필터 + 구독 토큰 로드 → 발송 대상 구성.
    const recipients = await this.resolveRecipients(
      candidateUserIds,
      ownerUserId,
      txn,
    );
    if (recipients.length === 0) {
      return { transactionId, outcome: 'skipped', recipientCount: 0, sentCount: 0 };
    }

    // 4. 발송(토큰별 격리). 무효 토큰은 revoke. 이미 보낸 토큰(재시도)은 건너뛴다.
    const alreadySent = new Set(job.data.sentTokenIds ?? []);
    const newlySent: string[] = [];
    let retryableFailure = false;

    for (const recipient of recipients) {
      const masked = maskNonOwner && recipient.userId !== ownerUserId;
      const { title, body } = this.composeMessage(txn, masked, uncertain);
      const pending = recipient.tokens.filter((t) => !alreadySent.has(t.id));
      await Promise.allSettled(
        pending.map(async (t) => {
          const message: FcmMessage = {
            token: t.token,
            title,
            body,
            data: { deepLink: `/transactions?txn=${transactionId}` },
          };
          const result = await this.fcm.send(message);
          if (result.ok) {
            newlySent.push(t.id);
            return;
          }
          if (result.invalidToken) {
            await this.revokeToken(t.id);
          } else {
            await this.recordFailure(t.id);
            if (result.retryable) retryableFailure = true;
          }
        }),
      );
    }

    // 진행 상태 저장 — 재시도 시 이 토큰들을 건너뛴다(중복 발송 방지). throw
    // 전에 반드시 persist 한다.
    if (newlySent.length > 0) {
      await job.updateData({
        ...job.data,
        sentTokenIds: [...alreadySent, ...newlySent],
      });
    }
    const sentCount = alreadySent.size + newlySent.length;

    this.logger.info(
      { ...base, recipientCount: recipients.length, sentCount },
      'notification dispatched',
    );

    // 일시 실패(5xx/429/네트워크/토큰교환)가 있었으면 예외를 던져 BullMQ 재시도를
    // 유발한다. 이미 성공한 토큰은 job.data에 기록돼 다음 시도에서 제외되므로
    // 재시도가 중복 발송을 만들지 않는다.
    if (retryableFailure) {
      throw new Error(
        `notification dispatch had retryable failures (transactionId=${transactionId})`,
      );
    }

    return {
      transactionId,
      outcome: sentCount > 0 ? 'sent' : 'skipped',
      recipientCount: recipients.length,
      sentCount,
    };
  }

  /**
   * 후보 userId를 선호로 필터링하고 활성 구독 토큰을 붙인다. 선호 행이 없으면
   * 기본값(켬)으로 간주. minAmount·무음시간대·pushEnabled·notifyOwnCollected 적용.
   */
  private async resolveRecipients(
    candidateUserIds: string[],
    ownerUserId: string,
    txn: schema.CardTransaction,
  ): Promise<Recipient[]> {
    if (candidateUserIds.length === 0) return [];

    // 선호·토큰 모두 후보 사용자로 스코프해 한 번씩만 조회한다(전체스캔/N+1 회피).
    const prefs = await this.db
      .select()
      .from(schema.notificationPreferences)
      .where(
        inArray(schema.notificationPreferences.userId, candidateUserIds),
      );
    const prefByUser = new Map(prefs.map((p) => [p.userId, p]));

    const subs = await this.db
      .select({
        id: schema.pushSubscriptions.id,
        userId: schema.pushSubscriptions.userId,
        token: schema.pushSubscriptions.token,
      })
      .from(schema.pushSubscriptions)
      .where(
        and(
          inArray(schema.pushSubscriptions.userId, candidateUserIds),
          isNull(schema.pushSubscriptions.revokedAt),
        ),
      );
    const tokensByUser = new Map<string, { id: string; token: string }[]>();
    for (const s of subs) {
      const list = tokensByUser.get(s.userId) ?? [];
      list.push({ id: s.id, token: s.token });
      tokensByUser.set(s.userId, list);
    }

    const nowMinute = currentSeoulMinuteOfDay();
    const recipients: Recipient[] = [];

    for (const userId of candidateUserIds) {
      const pref = prefByUser.get(userId);
      // 선호 필터(행 없으면 기본 통과).
      if (pref) {
        if (!pref.pushEnabled) continue;
        if (pref.minAmount !== null && txn.amount < pref.minAmount) continue;
        if (userId === ownerUserId && !pref.notifyOwnCollected) continue;
        if (isQuietNow(pref.quietStartMinute, pref.quietEndMinute, nowMinute)) {
          continue;
        }
      }
      const tokens = tokensByUser.get(userId);
      if (tokens && tokens.length > 0) {
        recipients.push({ userId, tokens });
      }
    }
    return recipients;
  }

  /** 거래 → 알림 제목/본문. masked면 가맹점을 숨긴다. */
  private composeMessage(
    txn: schema.CardTransaction,
    masked: boolean,
    uncertain: boolean,
  ): { title: string; body: string } {
    const amount = formatKrw(txn.amount);
    const merchant = masked
      ? null
      : (txn.merchantNormalized ?? txn.merchantRaw);
    const isCancel = txn.transactionType === 'cancellation';

    if (uncertain) {
      return {
        title: '확인이 필요한 거래',
        body: merchant
          ? `${merchant} ${amount} 거래를 확인해 주세요`
          : `새 거래 ${amount}를 확인해 주세요`,
      };
    }
    if (isCancel) {
      return {
        title: '결제 취소',
        body: merchant ? `${merchant} ${amount} 취소` : `${amount} 결제 취소`,
      };
    }
    return {
      title: '새 결제',
      body: merchant ? `${merchant} ${amount}` : `새 결제 ${amount}`,
    };
  }

  /** 무효 토큰 영구 폐기(UNREGISTERED 등). */
  private async revokeToken(id: string): Promise<void> {
    await this.db
      .update(schema.pushSubscriptions)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.pushSubscriptions.id, id));
  }

  /** 일시 실패 누적(관측용). */
  private async recordFailure(id: string): Promise<void> {
    await this.db
      .update(schema.pushSubscriptions)
      .set({
        failCount: sql`${schema.pushSubscriptions.failCount} + 1`,
        lastFailureAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.pushSubscriptions.id, id));
  }
}

/** KRW 정수 → '12,000원'. */
function formatKrw(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

/** 현재 Asia/Seoul 자정 기준 분(0~1439). 내장 Intl로 계산(의존성 불필요). */
function currentSeoulMinuteOfDay(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl은 자정을 '24'로 줄 수 있어 0으로 보정.
  return (hour % 24) * 60 + minute;
}

/**
 * 무음 시간대 판정. start/end가 null이면 무음 아님. start<=end면 [start,end),
 * start>end면 자정을 넘는 구간(예: 22:00~07:00)으로 해석한다.
 */
function isQuietNow(
  start: number | null,
  end: number | null,
  now: number,
): boolean {
  if (start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}
