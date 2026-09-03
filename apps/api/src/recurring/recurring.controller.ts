/**
 * 정기 지출 Radar HTTP 표면 (C-5 최소 제품).
 *
 * 라우트는 넷이다: 목록 · 확정 · 재계산 · **예정(`/upcoming`)**.
 *
 * `/upcoming`은 금액 레이어 S1이며 2026-09-03에 열었다 — ADR-0027이 8단계까지 끝나
 * (전량 v2 + 제약 VALIDATE) `net_amount`가 확정됐기 때문이다. 그전까지 이 라우트를
 * 만들지 않은 이유는 "계약에 자리를 만들어 두면 곧 채워질 것으로 읽혀 enforce 전에
 * 켜질 압력이 생긴다"였고, 그 압력이 실제로 조건을 앞지르지 않았다.
 *
 * **여전히 없는 것**: 예정 알림 발송(S3) · 해지 감지(S4). 전자는 오탐이 확정 사실처럼
 * 전달되고 후자는 사용자 모르게 상태가 바뀌므로 각각 별도 슬라이스다
 * (`recurring.constants.ts`의 `RECURRING_DEFERRED_SURFACES`).
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
  type RecurringUpcomingResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { RecurringService } from './recurring.service';

const recurringListQuerySchema = z.object({ householdId: z.string().uuid() });
class RecurringListQueryDto extends createZodDto(recurringListQuerySchema) {}

/**
 * `until`은 **필수**다. 기본값을 두면 호출부마다 다른 창을 보게 되고("이번 달"인지
 * "앞으로 7일"인지), 홈과 목록이 다른 합계를 말한다. 창은 화면이 정하고 서버는
 * 받은 값을 그대로 되돌려준다.
 */
const recurringUpcomingQuerySchema = z.object({
  householdId: z.string().uuid(),
  until: z.string().datetime(),
});
class RecurringUpcomingQueryDto extends createZodDto(
  recurringUpcomingQuerySchema,
) {}
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

  /**
   * GET /v1/recurring/upcoming?householdId=&until= — 확정 series의 예정 목록 + 합계.
   *
   * 합계는 **금액을 예고할 수 있는 것만** 담는다. 빠진 건수(`excludedCount` ·
   * `otherCurrencyCount`)를 함께 주므로 화면이 "이만큼만 나간다"고 말하지 않을 수 있다.
   */
  @Get('upcoming')
  upcoming(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RecurringUpcomingQueryDto,
  ): Promise<RecurringUpcomingResponse> {
    return this.recurringService.upcoming(
      user.userId,
      query.householdId,
      new Date(query.until),
    );
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
