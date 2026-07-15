/**
 * AI query HTTP surface (Phase 7 Build Spec §6.4).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as the actor `userId`; the service (via
 * `RetrievalService`) enforces owner-only workspace access (PRD §26) and
 * returns a 403 to any non-owner. Request bodies are validated by the global
 * `ZodValidationPipe` against the `@family/contracts` schemas wrapped as DTOs.
 *
 * Both routes are POST returning 200 (query operations, not resource creation).
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  retrievalRequestSchema,
  workQueryRequestSchema,
  type RetrievalResponse,
  type WorkQueryResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { AiQueryService } from './ai-query.service';

class WorkQueryDto extends createZodDto(workQueryRequestSchema) {}
class RetrievalDto extends createZodDto(retrievalRequestSchema) {}

@Controller('ai')
export class AiQueryController {
  constructor(private readonly aiQueryService: AiQueryService) {}

  /**
   * POST /v1/ai/work-query — answer a question grounded in the owner's Slack
   * workspace, or refuse (`refused: true`) when no evidence is found.
   */
  @Post('work-query')
  @HttpCode(HttpStatus.OK)
  workQuery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WorkQueryDto,
  ): Promise<WorkQueryResponse> {
    return this.aiQueryService.workQuery(user.userId, {
      workspaceId: dto.workspaceId,
      question: dto.question,
    });
  }

  /**
   * POST /v1/ai/retrieval — hybrid search debug/verification endpoint. Returns
   * the ranked chunks (RRF score descending) without generating an answer.
   */
  @Post('retrieval')
  @HttpCode(HttpStatus.OK)
  retrieval(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RetrievalDto,
  ): Promise<RetrievalResponse> {
    return this.aiQueryService.retrieve(user.userId, {
      workspaceId: dto.workspaceId,
      query: dto.query,
      topK: dto.topK,
    });
  }
}
