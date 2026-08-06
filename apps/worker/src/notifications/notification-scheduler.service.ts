/**
 * 스케줄 기반 알림 발송기(리마인더 + 주간 요약).
 *
 * @nestjs/schedule 대신 outbox-dispatcher와 동일한 `setInterval + OnApplication*`
 * 패턴을 쓴다(의존성 0, 코드베이스 관례). 매 분 깨어나 KST 벽시계를 보고
 * "발송 시각을 지났고 아직 안 보낸" 대상에게 발송한다. 다중 인스턴스·재시작
 * 중복은 `notification_dedupe`(dedupeKey UNIQUE)가 흡수하므로 정밀한 cron은
 * 불필요하다. 실제 발송/수신자·선호 필터는 notification-dispatch 소비자가 담당.
 */
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  schema,
  type Db,
  notTransferCategory,
  spendPeriodWindow,
} from '@family/database';
import {
  createLogger,
  normalizeMerchant,
  QUEUE_NAMES,
  type NotificationDispatchJob,
} from '@family/shared';
import type { Queue } from 'bullmq';
import { and, eq, gte, inArray, isNotNull, isNull, lt, notExists, or, sql, type SQL } from 'drizzle-orm';

import { DB } from '../database/database.module';
import { TransactionPromotionService } from '../promotion/transaction-promotion.service';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TICK_MS = 60_000;
/** 리마인더 발송 하한 시각(KST). 이 시각 이후 그날 첫 tick에서 1회 발송. */
const REMINDER_HOUR = 20;
/** 주간 요약: 일요일(0) 이 시각(KST) 이후 1회. */
const SUMMARY_HOUR = 20;
const SUMMARY_DOW = 0;

/**
 * 수집 공백 경보 임계(시간). 카드 문자는 **재전송이 없다** — 자동화(MacroDroid/단축어)가
 * 배터리 최적화·토큰 회전·앱 종료로 조용히 멈추면 그 사이 결제가 영구 유실되고 아무도
 * 모른다. 유입이 끊긴 것 자체가 유일한 감지 신호다.
 *
 * 36시간인 이유: 하루쯤 카드를 안 쓰는 것은 정상이므로 24시간은 오탐이 잦고, 48시간은
 * 주말을 통째로 놓친다. 하루+반나절이면 "안 쓴 것"과 "끊긴 것"이 실무적으로 갈린다.
 */
const COLLECTION_GAP_HOURS = 36;

/**
 * 승격 정체 경보 임계(분). 파싱과 승격은 **같은 잡** 안에서 연달아 실행되고
 * (`card-sms-parse.processor`), 실패해도 `QUEUE_DEFAULT_JOB_OPTIONS`(attempts 3,
 * exponential 5s)가 ~35초 안에 재시도를 끝낸다. 따라서 정상 경로에서 파싱 후
 * 1시간이 지나도록 승격되지 않은 이벤트는 **잡이 유실된 것**이다.
 *
 * 실제 사례(2026-07-30): 4건이 `parsed`인 채 승격되지 않아 119,693원이 집계에서
 * 조용히 빠졌고, 감지 장치가 없어 아무도 몰랐다. `collection_gap`은 유입이 끊긴
 * 것만 보므로 이 구멍을 덮지 못한다.
 */
const PROMOTION_STALL_MINUTES = 60;

/**
 * 정체 조회 상한(일). 이보다 오래된 것은 자동 복구 대상이 아니다 — 매일 재시도해도
 * 안 되는 건 코드/데이터 문제라 사람이 봐야 하고, 무한히 쌓이면 tick이 무거워진다.
 */
const PROMOTION_STALL_LOOKBACK_DAYS = 30;

/**
 * 반복 거절 알림 임계(횟수). 1회 거절은 흔한 일시적 오류(잔액 일시부족·통신)라 알리면
 * 노이즈가 된다. 2회부터는 스스로 해결되지 않는 구조적 문제로 본다.
 */
const DECLINE_ALERT_MIN_ATTEMPTS = 2;

/** 반복 거절 조회 창(일). 이 안의 시도만 한 사건으로 묶는다. */
const DECLINE_ALERT_WINDOW_DAYS = 7;

/** KST 벽시계 기준 'YYYY-MM-DD'. (인자는 이미 +9h 보정된 Date) */
function seoulDateStr(shifted: Date): string {
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d
    .toString()
    .padStart(2, '0')}`;
}

@Injectable()
export class NotificationSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = createLogger('worker:notification-scheduler', {
    pretty: process.env.NODE_ENV !== 'production',
  });
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @InjectQueue(QUEUE_NAMES.NOTIFICATION_DISPATCH)
    private readonly notificationQueue: Queue,
    // 정체 이벤트의 자동 복구용. promote()는 sourceEventId UNIQUE로 멱등하므로
    // 재호출이 안전하다(파싱 프로세서와 같은 진입점을 쓴다).
    private readonly promotionService: TransactionPromotionService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 매 분 tick — 발송 시각 판정 후 대상별 dedupe 발송. 재진입 방지. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const seoul = new Date(Date.now() + KST_OFFSET_MS);
      const hour = seoul.getUTCHours();
      const dow = seoul.getUTCDay();
      if (hour >= REMINDER_HOUR) {
        await this.runReminders(seoulDateStr(seoul));
      }
      if (dow === SUMMARY_DOW && hour >= SUMMARY_HOUR) {
        await this.runWeeklySummary(seoul);
      }
      await this.runCollectionGapCheck();
      await this.runPromotionStallCheck();
      await this.runDeclineAlertCheck();
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : 'unknown' },
        'notification scheduler tick failed',
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * 확인 필요(pending_review + duplicate_suspected, 미제외) 거래를 소유자별로
   * 집계해 각 소유자에게 "N건" 리마인더를 발송한다. dedupeKey는 user·날짜 기준.
   * (public — Phase 검증에서 수동 트리거 가능)
   */
  async runReminders(dateStr: string): Promise<number> {
    const rows = await this.db
      .select({
        userId: schema.householdMembers.userId,
        householdId: schema.householdMembers.householdId,
        cnt: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .innerJoin(
        schema.householdMembers,
        eq(schema.householdMembers.id, schema.cardTransactions.memberId),
      )
      .where(
        and(
          inArray(schema.cardTransactions.status, [
            'pending_review',
            'duplicate_suspected',
          ]),
          isNull(schema.cardTransactions.excludedAt),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .groupBy(
        schema.householdMembers.userId,
        schema.householdMembers.householdId,
      );

    let enqueued = 0;
    for (const row of rows) {
      const count = Number(row.cnt) || 0;
      if (count <= 0) continue;
      const key = `reminder:${row.userId}:${dateStr}`;
      if (!(await this.claimDedupe(key))) continue;
      await this.enqueue(
        {
          kind: 'reminder',
          householdId: row.householdId,
          userId: row.userId,
          count,
        },
        key,
      );
      enqueued += 1;
    }
    return enqueued;
  }

  /**
   * 지난 7일(KST) approval 순지출/건수를 household별로 집계해 활성 구성원 전원에게
   * 주간 요약을 발송한다. dedupeKey는 user·주시작 기준.
   * (public — Phase 검증에서 수동 트리거 가능)
   */
  async runWeeklySummary(seoul: Date): Promise<number> {
    const y = seoul.getUTCFullYear();
    const mi = seoul.getUTCMonth();
    const d = seoul.getUTCDate();
    // 오늘 KST 00:00을 UTC instant로.
    const todayStartUtc = new Date(Date.UTC(y, mi, d) - KST_OFFSET_MS);
    const weekTo = todayStartUtc;
    const weekFrom = new Date(todayStartUtc.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStart = seoulDateStr(new Date(weekFrom.getTime() + KST_OFFSET_MS));

    const aggs = await this.db
      .select({
        householdId: schema.cardTransactions.householdId,
        totalNet: sql<string>`coalesce(sum(${schema.cardTransactions.netAmount}), 0)`,
        cnt: sql<string>`count(*)`,
      })
      .from(schema.cardTransactions)
      .where(
        and(
          eq(schema.cardTransactions.transactionType, 'approval'),
          isNull(schema.cardTransactions.excludedAt),
          // 자산 이동은 소비가 아니므로 주간 요약 지출에서 뺀다(analytics와 동일 규칙).
          notTransferCategory(),
          // 요약은 KRW로 표기되므로 KRW 거래만 합산(외화 minor units 혼입 방지).
          eq(schema.cardTransactions.currency, 'KRW'),
          // 기간 창은 analytics·예산과 같은 공통 헬퍼(ADR-0026). 요약 문장의 금액이
          // 사용자가 홈에서 보는 총액과 어긋나지 않게 한다.
          spendPeriodWindow(weekFrom, weekTo),
        ),
      )
      .groupBy(schema.cardTransactions.householdId);
    if (aggs.length === 0) return 0;

    const householdIds = aggs.map((a) => a.householdId);
    const members = await this.db
      .select({
        userId: schema.householdMembers.userId,
        householdId: schema.householdMembers.householdId,
      })
      .from(schema.householdMembers)
      .where(
        and(
          inArray(schema.householdMembers.householdId, householdIds),
          eq(schema.householdMembers.status, 'active'),
        ),
      );
    const usersByHousehold = new Map<string, Set<string>>();
    for (const m of members) {
      const set = usersByHousehold.get(m.householdId) ?? new Set<string>();
      set.add(m.userId);
      usersByHousehold.set(m.householdId, set);
    }

    let enqueued = 0;
    for (const agg of aggs) {
      const totalNet = Number(agg.totalNet) || 0;
      const txnCount = Number(agg.cnt) || 0;
      const users = usersByHousehold.get(agg.householdId);
      if (!users) continue;
      for (const userId of users) {
        const key = `summary:${userId}:${weekStart}`;
        if (!(await this.claimDedupe(key))) continue;
        await this.enqueue(
          {
            kind: 'summary',
            householdId: agg.householdId,
            userId,
            totalNet,
            txnCount,
            periodLabel: '지난주',
            // 요약 기간이 **시작된** 달로 딥링크한다. 월초(1~7일)에 오는 '지난주'
            // 요약은 대부분 전월 지출이므로, 이번 달 홈을 열면 방금 읽은 금액이
            // 화면에 없다.
            month: weekStart.slice(0, 7),
          },
          key,
        );
        enqueued += 1;
      }
    }
    return enqueued;
  }

  /** dedupe 선점 — 삽입 성공(=이 기간 첫 발송)이면 true. */
  /**
   * 한 번이라도 문자를 받은 적 있는 활성 장치 중, 마지막 수신이
   * {@link COLLECTION_GAP_HOURS}를 넘긴 것을 운영 경보로 올린다.
   *
   * 아직 한 건도 못 받은 장치(`firstEventAt IS NULL`)는 제외한다 — 그건 "끊긴 것"이
   * 아니라 "온보딩 미완주"이고 성격이 다른 문제다(장치 화면이 이미 표시한다).
   *
   * 사용자 알림(FCM)이 아니라 `operational_alerts`로 보내는 이유: 지금 수신자는
   * 운영자 한 명이고, 새 알림 kind를 추가하면 shared 타입·dispatch·웹 렌더링까지
   * 표면이 넓어진다. 사용자가 늘면 사용자향 알림으로 승격한다.
   * (public — 검증에서 수동 트리거 가능)
   */
  async runCollectionGapCheck(): Promise<number> {
    const threshold = new Date(Date.now() - COLLECTION_GAP_HOURS * 60 * 60 * 1000);
    const stale = await this.db
      .select({
        id: schema.registeredDevices.id,
        householdId: schema.registeredDevices.householdId,
        lastSeenAt: schema.registeredDevices.lastSeenAt,
        lastEventAt: schema.registeredDevices.lastEventAt,
      })
      .from(schema.registeredDevices)
      .where(
        and(
          eq(schema.registeredDevices.status, 'active'),
          isNotNull(schema.registeredDevices.firstEventAt),
          // **lastSeenAt** 기준인 이유: lastEventAt만 보면 "자동화가 죽음"과
          // "그동안 카드를 안 씀"을 구분할 수 없다(첫 실전 사례에서 확인됨 —
          // 41시간 무유입이 둘 중 무엇인지 서버 데이터만으로 판별 불가였다).
          // 자동화가 주기적으로 `POST /v1/mobile-events/ping-token`을 치면
          // lastSeenAt이 갱신되므로, 이 값이 멈춘 것 = 자동화가 죽은 것이다.
          // 하트비트를 설정하지 않은 장치는 lastSeenAt == lastEventAt이라 종전과 동일하게 동작한다.
          lt(schema.registeredDevices.lastSeenAt, threshold),
        ),
      );

    let raised = 0;
    for (const device of stale) {
      // 같은 장치의 같은 공백을 하루 한 번만 올린다(계속 끊겨 있으면 매일 재알림).
      const day = new Date().toISOString().slice(0, 10);
      const dedupeKey = `card-sms-gap:${device.id}:${day}`;
      const [inserted] = await this.db
        .insert(schema.operationalAlerts)
        .values({
          dedupeKey,
          kind: 'card_sms_collection_gap',
          severity: 'warning',
          sourceType: 'device',
          sourceId: device.id,
          summary: `card-sms collection stalled for ${COLLECTION_GAP_HOURS}h+`,
          occurredAt: new Date(),
          details: {
            deviceId: device.id,
            householdId: device.householdId,
            // 둘을 함께 실어야 수신자가 "하트비트도 끊김"(자동화 사망)과
            // "하트비트는 오는데 결제만 없음"을 구분할 수 있다.
            lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
            lastEventAt: device.lastEventAt?.toISOString() ?? null,
            thresholdHours: COLLECTION_GAP_HOURS,
          },
        })
        .onConflictDoNothing({ target: schema.operationalAlerts.dedupeKey })
        .returning({ id: schema.operationalAlerts.id });
      if (inserted) raised += 1;
    }
    if (raised > 0) {
      this.logger.warn({ raised }, 'card-sms collection gap alerts raised');
    }
    return raised;
  }

  /**
   * 파싱은 끝났는데 거래로 승격되지 않고 {@link PROMOTION_STALL_MINUTES} 이상 멈춘
   * 이벤트를 경보로 올리고, 같은 tick에서 자동 복구를 1회 시도한다.
   *
   * 경보를 **먼저** 선점하는 이유: dedupeKey 삽입이 성공한 tick만 복구를 시도하므로
   * 매 분 재시도가 폭주하지 않는다(이벤트·일자당 1회). 복구가 성공하면 다음 tick
   * 조회에서 자연히 빠지고, 실패하면 다음 날 다시 경보가 올라간다 — 반복 자체가
   * "자동 복구로는 안 되는 문제"라는 신호다.
   *
   * `declined`는 제외한다(체결이 아니라 승격 대상이 아님 — 파싱 프로세서와 동일 판정).
   * `parse_failed`/`quarantined`는 parseStatus 필터에서 자연히 빠진다.
   * (public — 검증에서 수동 트리거 가능)
   */
  async runPromotionStallCheck(): Promise<number> {
    const now = Date.now();
    const threshold = new Date(now - PROMOTION_STALL_MINUTES * 60 * 1000);
    const lookbackFrom = new Date(
      now - PROMOTION_STALL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    const day = new Date(now).toISOString().slice(0, 10);

    const stalled = await this.db
      .select({
        id: schema.cardSmsEvents.id,
        householdId: schema.cardSmsEvents.householdId,
        parseStatus: schema.cardSmsEvents.parseStatus,
        transactionType: schema.cardSmsEvents.transactionType,
        parsedAt: schema.cardSmsEvents.parsedAt,
      })
      .from(schema.cardSmsEvents)
      .where(
        and(
          inArray(schema.cardSmsEvents.parseStatus, ['parsed', 'pending_review']),
          inArray(schema.cardSmsEvents.transactionType, [
            'approval',
            'cancellation',
          ]),
          isNotNull(schema.cardSmsEvents.parsedAt),
          lt(schema.cardSmsEvents.parsedAt, threshold),
          gte(schema.cardSmsEvents.parsedAt, lookbackFrom),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(schema.cardTransactions)
              .where(
                eq(
                  schema.cardTransactions.sourceEventId,
                  schema.cardSmsEvents.id,
                ),
              ),
          ),
        ),
      );

    let raised = 0;
    for (const event of stalled) {
      const dedupeKey = `card-sms-promo-stall:${event.id}:${day}`;
      const parsedAtMs = event.parsedAt?.getTime() ?? now;
      const [inserted] = await this.db
        .insert(schema.operationalAlerts)
        .values({
          dedupeKey,
          kind: 'card_sms_promotion_stalled',
          severity: 'warning',
          sourceType: 'card_sms_event',
          sourceId: event.id,
          summary: `card-sms parsed but not promoted for ${PROMOTION_STALL_MINUTES}m+`,
          occurredAt: new Date(now),
          details: {
            cardSmsEventId: event.id,
            householdId: event.householdId,
            parseStatus: event.parseStatus,
            transactionType: event.transactionType,
            parsedAt: event.parsedAt?.toISOString() ?? null,
            stalledMinutes: Math.round((now - parsedAtMs) / 60_000),
            thresholdMinutes: PROMOTION_STALL_MINUTES,
            autoRecoveryAttempted: true,
          },
        })
        .onConflictDoNothing({ target: schema.operationalAlerts.dedupeKey })
        .returning({ id: schema.operationalAlerts.id });
      if (!inserted) continue;
      raised += 1;

      // 자동 복구 — 실패해도 tick을 멈추지 않는다(경보는 이미 올라갔다).
      try {
        await this.promotionService.promote(event.id);
        this.logger.warn(
          { cardSmsEventId: event.id },
          'stalled card-sms promotion re-driven',
        );
      } catch (error) {
        this.logger.error(
          {
            cardSmsEventId: event.id,
            err: error instanceof Error ? error.message : 'unknown',
          },
          'stalled card-sms promotion recovery failed',
        );
      }
    }
    if (raised > 0) {
      this.logger.warn({ raised }, 'card-sms promotion stall alerts raised');
    }
    return raised;
  }

  /**
   * 최근 {@link DECLINE_ALERT_WINDOW_DAYS}일 안에 같은 `(가맹점, 금액)`으로
   * {@link DECLINE_ALERT_MIN_ATTEMPTS}회 이상 거절됐고 **아직 승인되지 않은** 결제를
   * 사용자 알림으로 올린다.
   *
   * 왜 스케줄러인가: 파싱 프로세서에 넣으면 문자 도착마다 집계·중복판정이 붙어 수집
   * 경로가 무거워지고, "그 뒤 승인됐는지"를 알 수 없다(승인은 나중에 온다). 최대 1분
   * 지연은 이 사건의 성격상 무해하다.
   *
   * 묶음 키에 `merchant_raw`를 쓰는 이유: 거절 문자는 같은 정기결제가 같은 문구로
   * 반복되므로 원문이 동일하다(실측 확인). 정규화·별칭까지 끌어오면 worker가 api의
   * 조회 로직을 복제해야 하고 이득이 없다.
   *
   * dedupe는 주 단위다 — 카드사가 **매일** 재시도하므로 일 단위면 7일 연속 거절에 알림이
   * 7번 간다. 지속 노출은 앱 내 실패 화면이 담당하고, 푸시는 주 1회로 족하다.
   * (public — 검증에서 수동 트리거 가능)
   */
  async runDeclineAlertCheck(): Promise<number> {
    const since = new Date(
      Date.now() - DECLINE_ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const lastAtExpr = sql<Date>`max(coalesce(${schema.cardSmsEvents.occurredAt}, ${schema.cardSmsEvents.createdAt}))`;
    const groups = await this.db
      .select({
        householdId: schema.cardSmsEvents.householdId,
        merchantRaw: schema.cardSmsEvents.merchantRaw,
        amount: schema.cardSmsEvents.amount,
        attempts: sql<string>`count(*)`,
        lastAt: lastAtExpr,
        // 최신 시도의 사유. `max()`는 알파벳 순 최댓값이라 사유가 바뀐 경우
        // (한도초과 → 분실신고) 옛 사유를 보여준다.
        reason: sql<
          string | null
        >`(array_agg(${schema.cardSmsEvents.declineReason}::text order by coalesce(${schema.cardSmsEvents.occurredAt}, ${schema.cardSmsEvents.createdAt}) desc))[1]`,
      })
      .from(schema.cardSmsEvents)
      .where(
        and(
          eq(schema.cardSmsEvents.transactionType, 'declined'),
          gte(schema.cardSmsEvents.createdAt, since),
        ),
      )
      .groupBy(
        schema.cardSmsEvents.householdId,
        schema.cardSmsEvents.merchantRaw,
        schema.cardSmsEvents.amount,
      )
      .having(sql`count(*) >= ${DECLINE_ALERT_MIN_ATTEMPTS}`);

    // 별칭 맵을 한 번만 로드한다(가구 수가 적고 그룹마다 조회하면 N+1이 된다).
    const aliasRows = await this.db
      .select({
        alias: schema.merchantAliases.alias,
        canonical: schema.merchantAliases.canonical,
      })
      .from(schema.merchantAliases);
    const aliasMap = new Map(aliasRows.map((a) => [a.alias, a.canonical]));

    let enqueued = 0;
    for (const g of groups) {
      const attempts = Number(g.attempts) || 0;
      if (attempts < DECLINE_ALERT_MIN_ATTEMPTS) continue;
      const lastAt = g.lastAt ? new Date(g.lastAt) : null;
      if (!lastAt) continue;

      // 마지막 거절 이후 **같은 가맹점** 승인이 있으면 스스로 해결된 것이다(재승인 케이스).
      // 가맹점 조건을 빼면 다른 데서 커피 한 잔 사도 해결로 오판한다.
      //
      // 거래에 저장된 `merchantNormalized`는 정규화 + 사용자 별칭까지 적용된 값이므로,
      // 거절 원문도 같은 변환을 거쳐야 비교가 성립한다.
      const declinedMerchant = g.merchantRaw
        ? (aliasMap.get(normalizeMerchant(g.merchantRaw)) ??
          normalizeMerchant(g.merchantRaw))
        : null;
      if (declinedMerchant) {
        const [approved] = await this.db
          .select({ id: schema.cardTransactions.id })
          .from(schema.cardTransactions)
          .where(
            and(
              eq(schema.cardTransactions.householdId, g.householdId),
              eq(schema.cardTransactions.transactionType, 'approval'),
              // 카드사가 거절/승인에서 가맹점명을 다르게 쓴다(거절엔 가맹점 코드가 붙는다):
              // 실측 `STEAMGAMES.COM425952`(거절) vs `STEAMGAMES`(승인). 완전 일치로
              // 비교하면 해결된 실패에 계속 알림이 간다. 4자 이상이면 접두 매칭 허용.
              declinedMerchant.length >= 4
                ? (or(
                    eq(
                      schema.cardTransactions.merchantNormalized,
                      declinedMerchant,
                    ),
                    sql`${schema.cardTransactions.merchantNormalized} like ${declinedMerchant.replace(/([\\%_])/g, '\\$1') + '%'}`,
                    sql`${declinedMerchant} like ${schema.cardTransactions.merchantNormalized} || '%'`,
                  ) as SQL)
                : eq(
                    schema.cardTransactions.merchantNormalized,
                    declinedMerchant,
                  ),
              isNotNull(schema.cardTransactions.approvedAt),
              gte(schema.cardTransactions.approvedAt, lastAt),
            ),
          )
          .limit(1);
        if (approved) continue;
      }

      const weekBucket = Math.floor(
        lastAt.getTime() / (7 * 24 * 60 * 60 * 1000),
      );
      const key = `decline:${g.householdId}:${g.merchantRaw ?? ''}:${g.amount ?? ''}:${weekBucket}`;
      if (!(await this.claimDedupe(key))) continue;
      await this.enqueue(
        {
          kind: 'decline',
          householdId: g.householdId,
          merchant: g.merchantRaw,
          amount: g.amount,
          attempts,
          reason: g.reason ?? null,
        },
        key,
      );
      enqueued += 1;
    }
    if (enqueued > 0) {
      this.logger.warn({ enqueued }, 'repeated card decline alerts enqueued');
    }
    return enqueued;
  }

  private async claimDedupe(dedupeKey: string): Promise<boolean> {
    const [inserted] = await this.db
      .insert(schema.notificationDedupe)
      .values({ dedupeKey })
      .onConflictDoNothing()
      .returning({ key: schema.notificationDedupe.dedupeKey });
    return Boolean(inserted);
  }

  private async enqueue(
    job: NotificationDispatchJob,
    dedupeKey: string,
  ): Promise<void> {
    await this.notificationQueue.add('dispatch', job, {
      jobId: `notif_${dedupeKey}`,
      removeOnComplete: true,
    });
  }
}
