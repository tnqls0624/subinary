/**
 * SnapshotBalances 스케줄러.
 * 알림 스케줄러와 같이 setInterval로 tick하고 BullMQ에 멱등 job을 넣는다.
 * 실제 스냅샷 쓰기는 BalanceSnapshotProcessor가 소유한다.
 */
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { createLogger, QUEUE_NAMES } from '@family/shared';

import type { BalanceSnapshotJob } from './balance-snapshot.processor';

const TICK_MS = 60_000;
/** 매시 정각(KST) 이후 첫 tick에서 1회. */
const SNAPSHOT_MINUTE_WINDOW = 5;

@Injectable()
export class BalanceSnapshotSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = createLogger('worker:balance-snapshot-scheduler', {
    pretty: process.env.NODE_ENV !== 'production',
  });
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastEnqueuedHourKey: string | null = null;

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

  /** 테스트·수동 트리거용. */
  async enqueueNow(batchId = randomUUID()): Promise<string> {
    const triggeredAt = new Date().toISOString();
    const jobId = `balance-snapshot_${batchId.replace(/-/g, '')}`;
    await this.queue.add(
      'snapshot',
      { batchId, triggeredAt },
      { jobId, removeOnComplete: 20, removeOnFail: 50 },
    );
    return jobId;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const seoul = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const minute = seoul.getUTCMinutes();
      if (minute > SNAPSHOT_MINUTE_WINDOW) return;

      const hourKey = [
        seoul.getUTCFullYear(),
        seoul.getUTCMonth() + 1,
        seoul.getUTCDate(),
        seoul.getUTCHours(),
      ].join('-');
      if (this.lastEnqueuedHourKey === hourKey) return;

      await this.enqueueNow();
      this.lastEnqueuedHourKey = hourKey;
      this.logger.info({ hourKey }, 'balance snapshot job enqueued');
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
