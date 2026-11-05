import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import type {
  CanSpendResponse,
  RecordTransactionResponse,
  TransferBetweenAccountsResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { LedgerService } from './ledger.service';

/**
 * 가족 원장 MVP 1차.
 * OpenAccount / CreateGoal / CloseGoal / UpsertBudgetRule 는 2차.
 */
@Controller('ledger')
export class LedgerController {
  constructor(private readonly service: LedgerService) {}

  /** RecordTransaction */
  @Post('transactions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  recordTransaction(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<RecordTransactionResponse> {
    return this.service.recordTransaction(user.userId, body);
  }

  /** TransferBetweenAccounts — 선택적 goalId로 목표 적립. */
  @Post('transfers')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<TransferBetweenAccountsResponse> {
    return this.service.transferBetweenAccounts(user.userId, body);
  }

  /** '지금 써도 되나' — 잔액·최근 거래·예산 통합 판단. */
  @Get('can-spend')
  @Header('Cache-Control', 'no-store, private')
  canSpend(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
  ): Promise<CanSpendResponse> {
    return this.service.canSpend(user.userId, { householdId });
  }
}
