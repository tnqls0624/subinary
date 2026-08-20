/**
 * 카테고리 소급 재분류 HTTP 표면.
 *
 * 정적 경로가 `GET /transactions/:id`와 충돌하지 않도록 **별도 컨트롤러**로 분리한다
 * (`/v1/transactions/recategorize/...`). 같은 컨트롤러에 넣으면 선언 순서에 의존하게
 * 되고, 순서를 흐트리는 다음 사람이 `recategorize`를 거래 id로 해석하게 만든다.
 *
 * ⛔ 쓰기 펜스(MoneyWriteFenceGuard)를 붙이지 않는다. 이 경로는 금액 컬럼을 쓰지 않으므로
 * ADR-0027 전환이 막아야 하는 대상이 아니다. 펜스 범위는 아키텍처 테스트가 소스에서
 * 직접 읽어 고정하므로(`money-fence-scope.test.ts`), 여기에 가드를 얹으면 그 단언도
 * 함께 갱신해야 한다 — 금액을 쓰지 않는 경로를 펜스에 넣는 것은 범위를 흐리는 일이다.
 */
import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  recategorizeRequestSchema,
  type CategoryRuleList,
  type RecategorizeBatchList,
  type RecategorizePreview,
  type RecategorizeResponse,
  type RecategorizeRevertResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { RecategorizeService } from './recategorize.service';

class RecategorizeDto extends createZodDto(recategorizeRequestSchema) {}

@Controller('v1/transactions/recategorize')
export class RecategorizeController {
  constructor(private readonly service: RecategorizeService) {}

  /**
   * GET /v1/transactions/recategorize/preview — 무엇이 바뀌는지 먼저 본다.
   *
   * 되돌릴 수 있는 액션이지만 그것과 무관하게 미리보기를 필수로 둔다. 사용자가 동의한
   * 숫자를 `expectedCount`로 되돌려 받아 적용 시점에 대조하기 때문이다.
   */
  @Get('preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
    @Query('merchant') merchant: string,
    @Query('categoryId') categoryId: string,
  ): Promise<RecategorizePreview> {
    return this.service.preview(user.userId, householdId, merchant, categoryId);
  }

  /** GET /v1/transactions/recategorize/batches — 최근 적용 이력(되돌리기 목록). */
  @Get('batches')
  listBatches(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
  ): Promise<RecategorizeBatchList> {
    return this.service.listBatches(user.userId, householdId);
  }

  /** GET /v1/transactions/recategorize/rules — 규칙 목록 + 소급 대상 건수. */
  @Get('rules')
  listRules(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
  ): Promise<CategoryRuleList> {
    return this.service.listRules(user.userId, householdId);
  }

  /** DELETE /v1/transactions/recategorize/rules/:id — 규칙만 지운다(거래는 그대로). */
  @Delete('rules/:id')
  deleteRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    return this.service.deleteRule(user.userId, id);
  }

  /** POST /v1/transactions/recategorize — 일괄 적용. */
  @Post()
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RecategorizeDto,
  ): Promise<RecategorizeResponse> {
    return this.service.apply(user.userId, dto);
  }

  /** POST /v1/transactions/recategorize/:batchId/revert — 되돌린다. */
  @Post(':batchId/revert')
  revert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('batchId') batchId: string,
  ): Promise<RecategorizeRevertResponse> {
    return this.service.revert(user.userId, batchId);
  }
}
