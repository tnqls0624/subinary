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
import { schema, type Db } from '@family/database';
import {
  createLogger,
  QUEUE_NAMES,
  type NotificationDispatchJob,
} from '@family/shared';
import type { Queue } from 'bullmq';
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { DB } from '../database/database.module';

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
          // 요약은 KRW로 표기되므로 KRW 거래만 합산(외화 minor units 혼입 방지).
          eq(schema.cardTransactions.currency, 'KRW'),
          gte(schema.cardTransactions.approvedAt, weekFrom),
          lt(schema.cardTransactions.approvedAt, weekTo),
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
