/**
 * Card-SMS query HTTP surface (Phase 3 Build Spec §5.2).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as `actorUserId`; the service enforces
 * household membership and returns a 403 to non-members (PRD §26).
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  cardSmsReviewRequestSchema,
  type CardSmsEventDetail,
  type CardSmsEventSummary,
  type CardSmsReviewResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { CardSmsQueryService } from './card-sms-query.service';
import { CardSmsReviewService } from './card-sms-review.service';

class CardSmsReviewDto extends createZodDto(cardSmsReviewRequestSchema) {}

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
   */
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CardSmsReviewDto,
  ): Promise<CardSmsReviewResponse> {
    return this.reviewService.review(user.userId, id, dto);
  }
}
