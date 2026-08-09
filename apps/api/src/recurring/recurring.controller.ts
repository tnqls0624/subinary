/**
 * 정기 지출 Radar HTTP 표면 (C-5 최소 제품).
 *
 * 라우트는 셋뿐이다: 목록 · 확정 · 재계산. **다음 결제일·월 총액·알림 라우트는 없다** —
 * 계약에 자리를 만들어 두면 "곧 채워질 것"으로 읽혀 ADR-0027 enforce 전에 켜질 압력이
 * 생긴다(`recurring.constants.ts`의 `RECURRING_DEFERRED_SURFACES`).
 *
 * 전 라우트가 access token(전역 `AccessTokenGuard`)을 요구하고, 가구 멤버십과 거래
 * 공개범위는 서비스 계층이 강제한다.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  recurringDecisionRequestSchema,
  recurringRecomputeRequestSchema,
  type RecurringDecisionResponse,
  type RecurringRecomputeResponse,
  type RecurringSeriesListResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { RecurringService } from './recurring.service';

const recurringListQuerySchema = z.object({ householdId: z.string().uuid() });
class RecurringListQueryDto extends createZodDto(recurringListQuerySchema) {}
class RecurringDecisionDto extends createZodDto(
  recurringDecisionRequestSchema,
) {}
class RecurringRecomputeDto extends createZodDto(
  recurringRecomputeRequestSchema,
) {}

@Controller('recurring')
export class RecurringController {
  constructor(private readonly recurringService: RecurringService) {}

  /** GET /v1/recurring/series?householdId=... — 후보·확정 목록(공개범위 적용). */
  @Get('series')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RecurringListQueryDto,
  ): Promise<RecurringSeriesListResponse> {
    return this.recurringService.list(user.userId, query.householdId);
  }

  /** POST /v1/recurring/series/:id/decision — "정기 결제 맞음 / 아님". */
  @Post('series/:id/decision')
  @HttpCode(HttpStatus.OK)
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RecurringDecisionDto,
  ): Promise<RecurringDecisionResponse> {
    return this.recurringService.decide(user.userId, id, dto.decision);
  }

  /**
   * POST /v1/recurring/recompute — 후보 전량 재계산.
   *
   * 별칭 등록·해제가 과거 거래의 canonical 신원을 바꾸므로 그 뒤에 한 번 돌려야 한다.
   * 사용자가 확정한 series는 근거 교집합으로 이어 붙고 사라지지 않는다.
   */
  @Post('recompute')
  @HttpCode(HttpStatus.OK)
  recompute(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RecurringRecomputeDto,
  ): Promise<RecurringRecomputeResponse> {
    return this.recurringService.recompute(user.userId, dto.householdId);
  }
}
