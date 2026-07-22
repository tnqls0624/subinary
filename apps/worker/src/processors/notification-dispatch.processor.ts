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
import {
  createLogger,
  DEFAULT_TIMEZONE,
  formatMoney,
  NOTIFICATION_CHANNELS,
  notificationDeepLink,
  QUEUE_NAMES,
  type NotificationDispatchJob,
  type NotificationKind,
} from '@family/shared';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB } from '../database/database.module';
import { FcmService, type FcmMessage } from '../notifications/fcm.service';

/** 잡 결과(관측용). */
interface NotificationDispatchJobResult {
  kind: NotificationKind;
  outcome: 'sent' | 'skipped' | 'disabled';
  recipientCount: number;
  sentCount: number;
}

/** 발송 대상 1명분(수신 사용자 + 활성 구독 토큰들). 마스킹은 발송 시점에 판정. */
interface Recipient {
  userId: string;
  tokens: { id: string; token: string }[];
}

/**
 * kind별로 해석된 발송 컨텍스트. 수신 후보·채널·딥링크는 유형이 결정하고,
 * 메시지는 수신자별로 다를 수 있어(가맹점 마스킹) 함수로 둔다.
 */
interface DispatchContext {
  candidateUserIds: string[];
  channelId: string;
  deepLink: string;
  /** minAmount 필터 적용 대상(거래 금액, minor units). 없으면 금액 필터 미적용. */
  amount?: number;
  /** 거래 금액의 통화. minAmount(KRW 임계)는 KRW 거래에만 적용한다. */
  currency?: string;
  /** notifyOwnCollected 판정 기준 소유자. 없으면 미적용. */
  ownerUserId?: string;
  composeFor: (userId: string) => { title: string; body: string };
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
    job: Job<NotificationDispatchJob>,
  ): Promise<NotificationDispatchJobResult> {
    // kind 없는 옛 잡(큐 잔류분)은 거래 알림으로 간주(하위호환).
    const raw = job.data as Record<string, unknown>;
    const data: NotificationDispatchJob = (
      'kind' in raw ? raw : { ...raw, kind: 'transaction' }
    ) as NotificationDispatchJob;
    const kind = data.kind;
    const base = { jobId: job.id, kind, householdId: data.householdId };

    // 1. kind별 발송 컨텍스트 해석(수신 후보·채널·딥링크·메시지 생성기).
    const ctx = await this.buildContext(data);
    if (!ctx) {
      this.logger.warn(base, 'notification skipped: no dispatch context');
      return { kind, outcome: 'skipped', recipientCount: 0, sentCount: 0 };
    }

    // 2. 인앱 알림함 이력 저장 — FCM 활성 여부·푸시 선호와 무관하게 수신 대상 전원.
    //    (푸시를 못/안 받아도 앱 안에서 지난 알림을 볼 수 있어야 하므로.)
    await this.saveHistory(data, ctx, String(job.id ?? ''));

    // 3. FCM 발송(서비스계정 미설정이면 이력만 남기고 종료).
    if (!this.fcm.enabled) {
      return { kind, outcome: 'disabled', recipientCount: 0, sentCount: 0 };
    }

    // 4. 선호 필터 + 구독 토큰 로드 → 발송 대상 구성(모든 kind 공통).
    const recipients = await this.resolveRecipients(ctx.candidateUserIds, {
      ownerUserId: ctx.ownerUserId,
      amount: ctx.amount,
      currency: ctx.currency,
    });
    if (recipients.length === 0) {
      return { kind, outcome: 'skipped', recipientCount: 0, sentCount: 0 };
    }

    // 3. 발송(토큰별 격리). 무효 토큰은 revoke. 이미 보낸 토큰(재시도)은 건너뛴다.
    const alreadySent = new Set(data.sentTokenIds ?? []);
    const newlySent: string[] = [];
    let retryableFailure = false;

    for (const recipient of recipients) {
      const { title, body } = ctx.composeFor(recipient.userId);
      const pending = recipient.tokens.filter((t) => !alreadySent.has(t.id));
      await Promise.allSettled(
        pending.map(async (t) => {
          const message: FcmMessage = {
            token: t.token,
            title,
            body,
            // kind·channelId도 실어 네이티브가 포그라운드 로컬 재표시 시 채널/액션을
            // 고른다(포그라운드 원격 푸시는 트레이에 안 뜨므로 앱이 배너를 재구성).
            data: { deepLink: ctx.deepLink, kind, channelId: ctx.channelId },
            channelId: ctx.channelId,
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
        ...data,
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
      throw new Error(`notification dispatch had retryable failures (kind=${kind})`);
    }

    return {
      kind,
      outcome: sentCount > 0 ? 'sent' : 'skipped',
      recipientCount: recipients.length,
      sentCount,
    };
  }

  /**
   * kind별 발송 컨텍스트를 만든다. 거래는 발송 시점 재조회로 visibility/상태를
   * 존중하고, 그 외 유형은 payload에 실린 값으로 수신자·메시지를 구성한다.
   * 발송 불가(대상 없음/거래 소멸)면 null.
   */
  private async buildContext(
    data: NotificationDispatchJob,
  ): Promise<DispatchContext | null> {
    const deepLink = notificationDeepLink(data);

    if (data.kind === 'transaction') {
      const [txn] = await this.db
        .select()
        .from(schema.cardTransactions)
        .where(eq(schema.cardTransactions.id, data.transactionId))
        .limit(1);
      if (!txn) return null;

      // 소유자 userId(거래 memberId → 활성 멤버십). status='active'로 좁혀
      // removed 소유자에게 발송하지 않는다.
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
      if (!ownerMember) return null;
      const ownerUserId = ownerMember.userId;

      const uncertain =
        txn.status === 'pending_review' || txn.status === 'duplicate_suspected';

      let candidateUserIds: string[];
      let maskNonOwner = false;
      if (txn.visibility === 'private' || uncertain) {
        candidateUserIds = [ownerUserId];
      } else {
        const members = await this.householdMemberUserIds(txn.householdId);
        candidateUserIds = members;
        maskNonOwner = txn.visibility === 'summary_only';
      }

      return {
        candidateUserIds,
        channelId: NOTIFICATION_CHANNELS.transaction,
        deepLink,
        amount: txn.amount,
        currency: txn.currency,
        ownerUserId,
        composeFor: (userId) =>
          this.composeMessage(txn, maskNonOwner && userId !== ownerUserId, uncertain),
      };
    }

    if (data.kind === 'budget') {
      // 예산 알림은 가족 활성 구성원 전원 대상(minAmount·notifyOwnCollected 미적용).
      const candidateUserIds = await this.householdMemberUserIds(data.householdId);
      const message = composeBudget(data.budgetName, data.threshold);
      return {
        candidateUserIds,
        channelId: NOTIFICATION_CHANNELS.budget,
        deepLink,
        composeFor: () => message,
      };
    }

    // reminder / summary — 지정 사용자 1인 대상.
    if (data.kind === 'reminder') {
      return {
        candidateUserIds: [data.userId],
        channelId: NOTIFICATION_CHANNELS.reminder,
        deepLink,
        composeFor: () => composeReminder(data.count),
      };
    }
    return {
      candidateUserIds: [data.userId],
      channelId: NOTIFICATION_CHANNELS.summary,
      deepLink,
      composeFor: () => composeSummary(data.totalNet, data.txnCount, data.periodLabel),
    };
  }

  /** household 활성 구성원의 고유 userId 목록. */
  private async householdMemberUserIds(householdId: string): Promise<string[]> {
    const members = await this.db
      .select({ userId: schema.householdMembers.userId })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.status, 'active'),
        ),
      );
    return [...new Set(members.map((m) => m.userId))];
  }

  /**
   * 인앱 알림함 이력 저장 — 수신 대상(candidateUserIds) 전원. title/body는 수신자별
   * 마스킹을 반영(composeFor). (userId, sourceKey) UNIQUE로 재시도/재승격 중복 흡수.
   * sourceKey는 생산자가 부여한 유니크 jobId(예: notif_<txnId>, notif_budget_..._<threshold>).
   * best-effort: 저장 실패가 발송을 막지 않는다.
   */
  private async saveHistory(
    data: NotificationDispatchJob,
    ctx: DispatchContext,
    sourceKey: string,
  ): Promise<void> {
    if (!sourceKey || ctx.candidateUserIds.length === 0) return;
    try {
      const rows = ctx.candidateUserIds.map((userId) => {
        const { title, body } = ctx.composeFor(userId);
        return {
          userId,
          householdId: data.householdId,
          kind: data.kind,
          title,
          body,
          deepLink: ctx.deepLink,
          sourceKey,
        };
      });
      await this.db
        .insert(schema.notifications)
        .values(rows)
        .onConflictDoNothing({
          target: [schema.notifications.userId, schema.notifications.sourceKey],
        });
    } catch (error) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : 'unknown',
          kind: data.kind,
        },
        'notification history save failed (best-effort)',
      );
    }
  }

  /**
   * 후보 userId를 선호로 필터링하고 활성 구독 토큰을 붙인다. 선호 행이 없으면
   * 기본값(켬)으로 간주. minAmount·무음시간대·pushEnabled 적용.
   */
  private async resolveRecipients(
    candidateUserIds: string[],
    opts: { ownerUserId?: string; amount?: number; currency?: string },
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
        // minAmount는 금액이 있는 알림(거래)에만 적용. 예산/리마인더/요약은 미적용.
        // minAmount는 KRW(원) 임계이고 amount는 minor units라, 외화 거래는 통화가
        // 달라 KRW 임계와 직접 비교할 수 없으므로 필터를 건너뛴다(외화는 항상 발송).
        if (
          opts.amount != null &&
          (opts.currency ?? 'KRW') === 'KRW' &&
          pref.minAmount !== null &&
          opts.amount < pref.minAmount
        ) {
          continue;
        }
        // 본인 수집(자기 카드) 거래도 항상 발송한다 — 정책상 알림을 끄지 않는다.
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
    // 외화 거래는 KRW 환산액 + 원통화 병기(`30,250원 ($22.00)`). KRW는 그대로.
    const amount =
      txn.originalCurrency && txn.originalAmount != null
        ? `${formatMoney(txn.amount, txn.currency)} (${formatMoney(txn.originalAmount, txn.originalCurrency)})`
        : formatMoney(txn.amount, txn.currency);
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

/** 예산 알림 문구. 100%↑=초과, 그 외(80%)=주의. */
function composeBudget(
  name: string,
  threshold: number,
): { title: string; body: string } {
  const over = threshold >= 100;
  return {
    title: over ? '예산 초과' : '예산 주의',
    body: `${name} 예산을 ${threshold}% ${over ? '초과했어요' : '썼어요'}`,
  };
}

/** 확인 필요 리마인더 문구. */
function composeReminder(count: number): { title: string; body: string } {
  return {
    title: '확인이 필요한 거래',
    body: `확인이 필요한 거래가 ${count}건 있어요`,
  };
}

/** 주간 소비 요약 문구. totalNet은 KRW 전용 집계(scheduler에서 통화 필터). */
function composeSummary(
  totalNet: number,
  txnCount: number,
  periodLabel: string,
): { title: string; body: string } {
  return {
    title: `${periodLabel} 소비 요약`,
    body: `${formatMoney(totalNet, 'KRW')} · ${txnCount}건`,
  };
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
