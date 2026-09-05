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
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  linkCancellationRequestSchema,
  transactionUpdateRequestSchema,
  type MerchantLabelCandidateListResponse,
  type TransactionDeleteResponse,
  type TransactionListResponse,
  type TransactionSummary,
  type TransactionSummaryResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { MoneyWriteFenceGuard } from '../money/money-write-fence.guard';
import { TransactionService } from './transaction.service';

class TransactionUpdateDto extends createZodDto(transactionUpdateRequestSchema) {}
class LinkCancellationDto extends createZodDto(linkCancellationRequestSchema) {}

@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  /**
   * GET /v1/transactions?householdId=&memberId=&cardId=&type=&status=&categoryId=
   *   &from=&to=&minAmount=&maxAmount=&q=&attribution=&limit=&cursor= — list
   * transactions the caller may see (visibility scope applied), newest first.
   *
   * `attribution=shared`는 공용 표시한 카드의 결제만 남긴다. 이 집합은 `memberId`로
   * 만들 수 없어서(공용은 사람이 아니라 귀속 보류 묶음) 별도 축이 필요하다.
   *
   * `q`는 가맹점(원문·정규화)과 메모의 부분 일치 검색어다. 타인의 `summary_only`
   * 거래는 검색 대상에서 제외된다 — 가려진 값에 매칭시키면 결과의 존재만으로
   * 프라이버시가 새기 때문(service `searchScope` 참고).
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
    @Query('q') q?: string,
    @Query('excluded') excluded?: string,
    @Query('attribution') attribution?: string,
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
      q,
      excluded,
      attribution,
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

  /**
   * GET /v1/transactions/:id/cancellation-candidates — 이 **취소** 행에 연결할 수 있는
   * 승인 후보 전량.
   *
   * 서버가 통화·잔액·시간 역전·공개범위를 미리 걸러 주므로 클라이언트가 전체 목록을
   * 받아 필터할 필요가 없다. **LIMIT이 없다** — 이 엔드포인트는 "최근 100건만 보여서
   * 오래된 승인에 도달할 수 없던" 문제를 없애기 위한 것이라 상한을 두면 원점이다.
   * 반환 shape은 목록 API와 같은 `TransactionListResponse`이고 `nextCursor`는 항상
   * `null`(= 이게 전부)이다.
   */
  @Get(':id/cancellation-candidates')
  listCancellationCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TransactionListResponse> {
    return this.transactionService.listCancellationCandidates(user.userId, id);
  }

  /**
   * PATCH /v1/transactions/:id — update category/merchant/card/member/etc.
   *
   * 쓰기 펜스 대상(ADR-0027 5단계 "금액 수정"). 이 핸들러는 금액 외 필드(카테고리·
   * 가맹점·카드·구성원)도 함께 받으므로 펜스 중에는 **그것들까지 막힌다**. 금액만 골라
   * 막으려면 본문을 들여다봐야 하는데, 그러면 "어떤 본문이 금액을 건드리는가"라는 판정이
   * 가드에 복제된다 — 그 판정이 서비스와 갈리는 순간 펜스가 헛돈다. 전환은 몇 분이고
   * 이 경로들은 사용자가 다시 누르면 되므로, **넓게 막고 짧게 끝내는** 쪽을 택했다.
   */
  @Patch(':id')
  @UseGuards(MoneyWriteFenceGuard)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransactionUpdateDto,
  ): Promise<TransactionSummary> {
    return this.transactionService.update(user.userId, id, dto);
  }

  /** DELETE /v1/transactions/:id — hard-delete a transaction (irreversible). */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TransactionDeleteResponse> {
    return this.transactionService.remove(user.userId, id);
  }

  /**
   * POST /v1/transactions/:id/link-cancellation — link this cancellation to an approval.
   * 쓰기 펜스 대상(ADR-0027 5단계 "취소 연결") — `cancelledAmount`·`netAmount`·`status`를 바꾼다.
   */
  @Post(':id/link-cancellation')
  @UseGuards(MoneyWriteFenceGuard)
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
