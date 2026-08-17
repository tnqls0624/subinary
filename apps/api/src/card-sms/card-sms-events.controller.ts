/**
 * Card-SMS query HTTP surface (Phase 3 Build Spec §5.2).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as `actorUserId`; the service enforces
 * household membership and returns a 403 to non-members (PRD §26).
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
  UseGuards,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  cardSmsDeclineDismissRequestSchema,
  cardSmsReviewRequestSchema,
  type CardSmsDeclineDismissResponse,
  type CardSmsDeclineListResponse,
  type CardSmsEventDetail,
  type CardSmsEventSummary,
  type CardSmsReviewResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { MoneyWriteFenceGuard } from '../money/money-write-fence.guard';
import { CardSmsQueryService } from './card-sms-query.service';
import { CardSmsReviewService } from './card-sms-review.service';

class CardSmsReviewDto extends createZodDto(cardSmsReviewRequestSchema) {}
class CardSmsDeclineDismissDto extends createZodDto(
  cardSmsDeclineDismissRequestSchema,
) {}

@Controller('card-sms-events')
export class CardSmsEventsController {
  constructor(
    private readonly queryService: CardSmsQueryService,
    private readonly reviewService: CardSmsReviewService,
  ) {}

  /**
   * GET /v1/card-sms-events?householdId=&status=&limit=&cursor= — list event
   * summaries for a household the caller belongs to (newest first).
   */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<CardSmsEventSummary[]> {
    return this.queryService.list(
      user.userId,
      householdId,
      status,
      limit,
      cursor,
    );
  }

  /**
   * GET /v1/card-sms-events/declines?householdId=&days= — 실패한 결제 묶음 목록.
   *
   * **`@Get(':id')`보다 반드시 위에 선언해야 한다** — NestJS는 선언 순서로 매칭하므로
   * 아래에 두면 `declines`가 `:id`로 먹혀 uuid 파싱 실패가 된다.
   */
  @Get('declines')
  listDeclines(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId: string,
    @Query('days') days?: string,
  ): Promise<CardSmsDeclineListResponse> {
    const parsed = days === undefined ? undefined : Number(days);
    return this.queryService.listDeclines(
      user.userId,
      householdId,
      Number.isFinite(parsed) && parsed !== undefined && parsed > 0
        ? Math.min(Math.trunc(parsed), 365)
        : undefined,
    );
  }

  /**
   * POST /v1/card-sms-events/declines/dismiss — 실패 묶음을 "확인했다"로 표시.
   *
   * 자동 해결 판정(`resolvedAt`)은 후속 승인이 있을 때만 채워지므로, 정기결제를
   * 해지한 경우처럼 승인이 영구히 오지 않는 실패는 배너가 사라지지 않는다. 이 경로가
   * 그 출구다. 표시 이후 새 거절이 오면 서버가 다시 노출한다(영구 무시가 아니다).
   */
  @Post('declines/dismiss')
  @HttpCode(HttpStatus.OK)
  dismissDecline(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CardSmsDeclineDismissDto,
  ): Promise<CardSmsDeclineDismissResponse> {
    return this.queryService.setDeclineDismissed(user.userId, body, true);
  }

  /** POST /v1/card-sms-events/declines/undismiss — 확인 표시 해제(가역적). */
  @Post('declines/undismiss')
  @HttpCode(HttpStatus.OK)
  undismissDecline(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CardSmsDeclineDismissDto,
  ): Promise<CardSmsDeclineDismissResponse> {
    return this.queryService.setDeclineDismissed(user.userId, body, false);
  }

  /** GET /v1/card-sms-events/:id — full event detail (includes raw content). */
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CardSmsEventDetail> {
    return this.queryService.get(user.userId, id);
  }

  /**
   * POST /v1/card-sms-events/:id/review — 격리·실패 건을 사람이 확인·교정해 확정한다
   * (ADR-0023 S3). 거래를 만들고 동시에 학습 라벨(`human_confirmed`)을 남긴다.
   *
   * 쓰기 펜스 대상(ADR-0027 5단계 "사람 검토 확정") — `card_transactions`를 직접 만든다.
   * 막혀도 원문은 `card_sms_events`에 그대로 남아 있어 펜스가 풀린 뒤 다시 확정하면 된다.
   */
  @Post(':id/review')
  @UseGuards(MoneyWriteFenceGuard)
  @HttpCode(HttpStatus.OK)
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CardSmsReviewDto,
  ): Promise<CardSmsReviewResponse> {
    return this.reviewService.review(user.userId, id, dto);
  }
}
