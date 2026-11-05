import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { createLogger, QUEUE_NAMES } from '@family/shared';

import { SnapshotBalancesService } from './snapshot-balances.service';

export interface BalanceSnapshotJob {
  readonly batchId: string;
  readonly hourKey?: string;
  readonly triggeredAt: string;
}

@Processor(QUEUE_NAMES.BALANCE_SNAPSHOT)
export class BalanceSnapshotProcessor extends WorkerHost {
  private readonly logger = createLogger('worker:balance-snapshot-processor', {
    pretty: process.env.NODE_ENV !== 'production',
  });

  constructor(private readonly snapshots: SnapshotBalancesService) {
    super();
  }

  async process(job: Job<BalanceSnapshotJob>): Promise<{ accountCount: number }> {
    this.logger.info(
      {
        jobId: job.id,
        batchId: job.data.batchId,
        hourKey: job.data.hourKey,
        triggeredAt: job.data.triggeredAt,
      },
      'balance snapshot job start',
    );
    const result = await this.snapshots.run(job.data.batchId);
    return { accountCount: result.accountCount };
  }
}
