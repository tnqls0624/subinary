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
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { DB } from '../database/database.module';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TICK_MS = 60_000;
/** 리마인더 발송 하한 시각(KST). 이 시각 이후 그날 첫 tick에서 1회 발송. */
const REMINDER_HOUR = 20;
/** 주간 요약: 일요일(0) 이 시각(KST) 이후 1회. */
const SUMMARY_HOUR = 20;
const SUMMARY_DOW = 0;

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
