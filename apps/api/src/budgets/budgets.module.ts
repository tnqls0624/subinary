/**
 * Budgets module (Phase 5 Build Spec §5.2).
 *
 * The `DB` provider is global (`DatabaseModule`) and the global
 * `AccessTokenGuard` (from `AuthModule` in `AppModule`) governs these routes, so
 * neither is re-imported here. The service enforces household membership, the
 * owner/admin role for mutations, and the visibility scope for usage
 * aggregation in the service layer (PRD §26).
 *
 * `AppModule` imports this module (owned by the P3 partition — this partition
 * only creates the budgets files, per spec §10).
 */
import { Module } from '@nestjs/common';

import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';

@Module({
  controllers: [BudgetController],
  providers: [BudgetService],
})
export class BudgetsModule {}
