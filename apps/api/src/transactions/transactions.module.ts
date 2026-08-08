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

import { MoneyModule } from '../money/money.module';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';

@Module({
  // ADR-0027 3단계: 금액 수정·취소 연결 결과를 새 계약과 대조해 기록만 한다.
  imports: [MoneyModule],
  controllers: [TransactionController],
  providers: [TransactionService],
})
export class TransactionsModule {}
