/**
 * Analytics HTTP surface (Phase 5 Build Spec §5.1).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as the actor `userId`; the service enforces
 * household membership and per-row visibility scope (PRD §8/§26). These are
 * read-only GET routes with query parameters only, so no request-body DTO is
 * involved.
 *
 * Period selection: `month=YYYY-MM` (default: current Asia/Seoul month) or an
 * explicit `from`/`to` ISO datetime range.
 */
import { Controller, Get, Query } from '@nestjs/common';

import type {
  CardBreakdown,
  CategoryBreakdown,
  MemberBreakdown,
  MerchantBreakdown,
  MonthlyAnalytics,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * GET /v1/analytics/monthly?householdId=&month=|from=&to= — net spend for the
   * window with a previous-period delta.
   */
  @Get('monthly')
  monthly(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<MonthlyAnalytics> {
    return this.analyticsService.monthly(user.userId, householdId, {
      month,
      from,
      to,
    });
  }

  /** GET /v1/analytics/categories — net spend grouped by expense category. */
  @Get('categories')
  categories(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<CategoryBreakdown> {
    return this.analyticsService.categories(user.userId, householdId, {
      month,
      from,
      to,
    });
  }

  /** GET /v1/analytics/members — net spend grouped by household member. */
  @Get('members')
  members(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<MemberBreakdown> {
    return this.analyticsService.members(user.userId, householdId, {
      month,
      from,
      to,
    });
  }

  /** GET /v1/analytics/cards — net spend grouped by payment card. */
  @Get('cards')
  cards(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<CardBreakdown> {
    return this.analyticsService.cards(user.userId, householdId, {
      month,
      from,
      to,
    });
  }

  /** GET /v1/analytics/merchants — net spend grouped by normalized merchant. */
  @Get('merchants')
  merchants(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<MerchantBreakdown> {
    return this.analyticsService.merchants(user.userId, householdId, {
      month,
      from,
      to,
    });
  }
}
