/**
 * Card-SMS query HTTP surface (Phase 3 Build Spec §5.2).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as `actorUserId`; the service enforces
 * household membership and returns a 403 to non-members (PRD §26).
 */
import { Controller, Get, Param, Query } from '@nestjs/common';

import type {
  CardSmsEventDetail,
  CardSmsEventSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { CardSmsQueryService } from './card-sms-query.service';

@Controller('card-sms-events')
export class CardSmsEventsController {
  constructor(private readonly queryService: CardSmsQueryService) {}

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
}
