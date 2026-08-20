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
import { RecategorizeController } from './recategorize.controller';
import { RecategorizeService } from './recategorize.service';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';

@Module({
  // ADR-0027 3단계: 금액 수정·취소 연결 결과를 새 계약과 대조해 기록만 한다.
  imports: [MoneyModule],
  // 소급 재분류는 별도 컨트롤러다 — `/transactions/recategorize`가 `:id` 라우트에
  // 잡히지 않게 경로를 분리했다(선언 순서에 의존하지 않는다).
  controllers: [TransactionController, RecategorizeController],
  providers: [TransactionService, RecategorizeService],
})
export class TransactionsModule {}
