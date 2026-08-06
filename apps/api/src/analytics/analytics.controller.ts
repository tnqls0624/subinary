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
import { Controller, Get, Logger, Query } from '@nestjs/common';

import type {
  AnalyticsMonths,
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

/** Asia/Seoul 고정 오프셋(+09:00, DST 없음) — 현재월 판정용. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

@Controller('analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * 과거월 조회를 1건씩 기록한다(ADR-0026 성공지표 4).
   *
   * 월 스위처를 만든 근거는 "지출의 2/3가 화면 밖에 있다"였지만, 화면이 있으면
   * 실제로 회고를 한다는 증거는 없었다. 4주간 이 로그가 0이면 월 스위처 위에
   * 아무것도 더 쌓지 않는다(다월 차트·비교 화면은 그 관찰 뒤에 판단).
   *
   * 홈이 과거월을 열 때 analytics 5종 + budgets가 함께 호출되므로 `monthly`
   * 한 곳에서만 남긴다 — 나머지에도 넣으면 한 번의 조회가 6줄이 된다.
   * 집계는 `docker logs family-memory-ai-api-1 | grep past-month-view` 또는 Dozzle.
   */
  private logPastMonthView(month: string | undefined): void {
    if (!month) return;
    const currentMonth = new Date(Date.now() + KST_OFFSET_MS)
      .toISOString()
      .slice(0, 7);
    if (month === currentMonth) return;
    // debug가 아니라 log(info)인 이유: 이 지표가 0이면 "이 방향 추가 개발 중단"이
    // 판단 근거가 된다. 레벨 필터에 걸려 0으로 보이면 잘못된 결론을 내린다.
    // 과거월 조회는 드문 이벤트라 info여도 로그가 넘치지 않는다.
    this.logger.log(`past-month-view month=${month}`);
  }

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
    this.logPastMonthView(month);
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

  /**
   * GET /v1/analytics/months?householdId= — 거래가 있는 달의 목록(오름차순).
   * 월 스위처가 빈 달을 건너뛰는 데 쓴다. 기간 파라미터를 받지 않는다(전 기간).
   */
  @Get('months')
  months(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
  ): Promise<AnalyticsMonths> {
    return this.analyticsService.months(user.userId, householdId);
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
