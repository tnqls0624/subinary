/**
 * Transaction HTTP surface (Phase 4 Build Spec §5.3).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as the actor `userId`; the service enforces
 * household membership, per-row visibility, and mutation permission (PRD
 * §8/§26). Request bodies are validated by the global `ZodValidationPipe`
 * against the `@family/contracts` schemas wrapped as DTOs.
 *
 * NOTE: static GET routes are declared *before* `GET /:id` so they win over
 * the `:id` param route (path-collision avoidance).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  linkCancellationRequestSchema,
  transactionUpdateRequestSchema,
  type MerchantLabelCandidateListResponse,
  type TransactionListResponse,
  type TransactionSummary,
  type TransactionSummaryResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { TransactionService } from './transaction.service';

class TransactionUpdateDto extends createZodDto(transactionUpdateRequestSchema) {}
class LinkCancellationDto extends createZodDto(linkCancellationRequestSchema) {}

@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  /**
   * GET /v1/transactions?householdId=&memberId=&cardId=&type=&status=&categoryId=
   *   &from=&to=&minAmount=&maxAmount=&limit=&cursor= — list transactions the
   * caller may see (visibility scope applied), newest first.
   */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('memberId') memberId?: string,
    @Query('cardId') cardId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('categoryId') categoryId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('minAmount') minAmount?: string,
    @Query('maxAmount') maxAmount?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<TransactionListResponse> {
    return this.transactionService.list(user.userId, {
      householdId,
      memberId,
      cardId,
      type,
      status,
      categoryId,
      from,
      to,
      minAmount,
      maxAmount,
      limit,
      cursor,
    });
  }

  /**
   * GET /v1/transactions/summary?householdId=&from=&to= — verification month
   * summary (net spend). Declared before `/:id` to avoid the param collision.
   */
  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<TransactionSummaryResponse> {
    return this.transactionService.summary(user.userId, {
      householdId,
      from,
      to,
    });
  }

  /** GET /v1/transactions/merchant-label-candidates — 사람 확정이 필요한 가맹점 batch. */
  @Get('merchant-label-candidates')
  listMerchantLabelCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('limit') limit?: string,
  ): Promise<MerchantLabelCandidateListResponse> {
    return this.transactionService.listMerchantLabelCandidates(
      user.userId,
      householdId,
      limit,
    );
  }

  /** GET /v1/transactions/:id — a single transaction (visibility scope applied). */
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TransactionSummary> {
    return this.transactionService.get(user.userId, id);
  }

  /** PATCH /v1/transactions/:id — update category/merchant/card/member/etc. */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransactionUpdateDto,
  ): Promise<TransactionSummary> {
    return this.transactionService.update(user.userId, id, dto);
  }

  /** POST /v1/transactions/:id/link-cancellation — link this cancellation to an approval. */
  @Post(':id/link-cancellation')
  @HttpCode(HttpStatus.OK)
  linkCancellation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: LinkCancellationDto,
  ): Promise<TransactionSummary> {
    return this.transactionService.linkCancellation(user.userId, id, dto);
  }

  /** POST /v1/transactions/:id/mark-duplicate — flag as a suspected duplicate. */
  @Post(':id/mark-duplicate')
  @HttpCode(HttpStatus.OK)
  markDuplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TransactionSummary> {
    return this.transactionService.markDuplicate(user.userId, id);
  }

  /** POST /v1/transactions/:id/mark-valid — clear a duplicate/review flag. */
  @Post(':id/mark-valid')
  @HttpCode(HttpStatus.OK)
  markValid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TransactionSummary> {
    return this.transactionService.markValid(user.userId, id);
  }

  /**
   * POST /v1/transactions/:id/exclude — 중복 확정 등으로 합계/예산에서 제외한다
   * (excludedAt=now). 거래 종류/금액은 이력용으로 남는다.
   */
  @Post(':id/exclude')
  @HttpCode(HttpStatus.OK)
  exclude(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TransactionSummary> {
    return this.transactionService.exclude(user.userId, id);
  }

  /** POST /v1/transactions/:id/include — 제외 취소(다시 합계에 포함). */
  @Post(':id/include')
  @HttpCode(HttpStatus.OK)
  include(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TransactionSummary> {
    return this.transactionService.include(user.userId, id);
  }
}
