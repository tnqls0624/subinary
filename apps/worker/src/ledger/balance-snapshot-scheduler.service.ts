/**
 * SnapshotBalances 스케줄러.
 * jobId를 KST hourKey로 고정해 다중 워커가 같은 시간에 tick해도 BullMQ가 한 잡만 받는다.
 */
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { createLogger, QUEUE_NAMES } from '@family/shared';

import type { BalanceSnapshotJob } from './balance-snapshot.processor';

const TICK_MS = 60_000;
/** 매시 정각(KST) 이후 첫 N분 창에서 enqueue. */
const SNAPSHOT_MINUTE_WINDOW = 5;

/** KST 벽시계 기준 `YYYYMMDDHH` (BullMQ jobId에 `:` 금지). */
export function kstHourKey(now = new Date()): string {
  const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = seoul.getUTCFullYear().toString().padStart(4, '0');
  const m = (seoul.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = seoul.getUTCDate().toString().padStart(2, '0');
  const h = seoul.getUTCHours().toString().padStart(2, '0');
  return `${y}${m}${d}${h}`;
}

export function balanceSnapshotJobId(hourKey: string): string {
  return `balance-snapshot_${hourKey}`;
}

/** 같은 hourKey면 항상 같은 batch UUID — 재시도 ON CONFLICT와 맞춘다. */
export function batchIdFromHourKey(hourKey: string): string {
  const hex = createHash('sha256')
    .update(`moa-balance-snapshot:${hourKey}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

@Injectable()
export class BalanceSnapshotSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = createLogger('worker:balance-snapshot-scheduler', {
    pretty: process.env.NODE_ENV !== 'production',
  });
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectQueue(QUEUE_NAMES.BALANCE_SNAPSHOT)
    private readonly queue: Queue<BalanceSnapshotJob>,
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

  /**
   * hourKey 기준 멱등 enqueue.
   * 이미 같은 jobId가 있으면 BullMQ가 거부 → 성공으로 본다(다중 워커 중복 방지).
   */
  async enqueueHour(hourKey: string, now = new Date()): Promise<{
    jobId: string;
    enqueued: boolean;
  }> {
    const jobId = balanceSnapshotJobId(hourKey);
    const batchId = batchIdFromHourKey(hourKey);
    try {
      await this.queue.add(
        'snapshot',
        { batchId, hourKey, triggeredAt: now.toISOString() },
        { jobId, removeOnComplete: 20, removeOnFail: 50 },
      );
      return { jobId, enqueued: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // BullMQ: Job with this id already exists
      if (/already exists|Job.*?exist/i.test(message)) {
        return { jobId, enqueued: false };
      }
      throw error;
    }
  }

  /** 테스트·수동 트리거 — 현재 KST 시각의 hourKey로 enqueue. */
  async enqueueNow(now = new Date()): Promise<string> {
    const result = await this.enqueueHour(kstHourKey(now), now);
    return result.jobId;
  }

  /** @internal 테스트에서 tick 창을 직접 검증할 때 사용. */
  async tickAt(now: Date): Promise<{ jobId: string; enqueued: boolean } | null> {
    const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    if (seoul.getUTCMinutes() > SNAPSHOT_MINUTE_WINDOW) return null;
    return this.enqueueHour(kstHourKey(now), now);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.tickAt(new Date());
      if (result?.enqueued) {
        this.logger.info({ jobId: result.jobId }, 'balance snapshot job enqueued');
      }
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : 'unknown' },
        'balance snapshot schedule tick failed',
      );
    } finally {
      this.running = false;
    }
  }
}
