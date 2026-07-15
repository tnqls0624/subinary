/**
 * Transactions module (Phase 4 Build Spec §5.3).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs these routes, so
 * neither is re-imported here. The service enforces household membership,
 * per-row visibility, and mutation permission in the service layer (PRD §26).
 *
 * `AppModule` imports this module (owned by the P4 partition — this partition
 * only creates the transactions files, per spec §10).
 */
import { Module } from '@nestjs/common';

import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';

@Module({
  controllers: [TransactionController],
  providers: [TransactionService],
})
export class TransactionsModule {}
