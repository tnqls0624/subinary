import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@family/shared';

import { BalanceSnapshotProcessor } from './balance-snapshot.processor';
import { BalanceSnapshotSchedulerService } from './balance-snapshot-scheduler.service';
import { SnapshotBalancesService } from './snapshot-balances.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: QUEUE_NAMES.BALANCE_SNAPSHOT,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS,
    }),
  ],
  providers: [
    SnapshotBalancesService,
    BalanceSnapshotProcessor,
    BalanceSnapshotSchedulerService,
  ],
  exports: [SnapshotBalancesService, BalanceSnapshotSchedulerService],
})
export class LedgerModule {}
