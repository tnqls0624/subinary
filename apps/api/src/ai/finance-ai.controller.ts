/**
 * Finance-AI HTTP surface — 자연어 가계부 질의 + 월간 인사이트.
 *
 * 두 라우트 모두 일반 사용자 access token(전역 {@link AccessTokenGuard})을 요구하며
 * `@Public()`이 아니다. 인증 principal의 `userId`가 서비스로 전달되고, 서비스가
 * household 멤버십(403, 존재 비공개)과 공개범위 스코프를 강제한다(PRD §26). 금액은
 * 전부 analytics의 SQL 집계에서 오며 LLM이 지어내지 않는다.
 *
 * - `POST /v1/ai/finance-query` : 질문 → 근거 집계 기반 해요체 답변(200).
 * - `GET  /v1/ai/monthly-insights` : householdId/month 쿼리 → 인사이트 배열.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  financeQueryRequestSchema,
  type FinanceQueryResponse,
  type MonthlyInsightsResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { FinanceAiService } from './finance-ai.service';

class FinanceQueryDto extends createZodDto(financeQueryRequestSchema) {}

@Controller('ai')
export class FinanceAiController {
  constructor(private readonly financeAi: FinanceAiService) {}

  /**
   * POST /v1/ai/finance-query — 자연어 질문에 근거(SQL 집계) 기반으로 답한다.
   * `method`로 LLM/템플릿 어느 경로였는지 노출한다.
   */
  @Post('finance-query')
  @HttpCode(HttpStatus.OK)
  financeQuery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FinanceQueryDto,
  ): Promise<FinanceQueryResponse> {
    return this.financeAi.financeQuery(user.userId, {
      householdId: dto.householdId,
      question: dto.question,
    });
  }

  /**
   * GET /v1/ai/monthly-insights?householdId=&month= — 전월 대비 추세/이상 지출/
   * 예산 소진 예측을 서버가 계산하고 LLM은 문구만 다듬는다(실패 시 서버 문구 그대로).
   */
  @Get('monthly-insights')
  monthlyInsights(
    @CurrentUser() user: AuthenticatedUser,
    @Query('householdId') householdId?: string,
    @Query('month') month?: string,
  ): Promise<MonthlyInsightsResponse> {
    // householdId 누락 시 서비스의 requireHouseholdId가 400을 던진다.
    return this.financeAi.monthlyInsights(user.userId, {
      householdId: householdId ?? '',
      month: month ?? undefined,
    });
  }
}
