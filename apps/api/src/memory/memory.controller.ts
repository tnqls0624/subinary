/**
 * Long-term memory HTTP surface (Phase 8 Build Spec §6.3).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as the actor `userId`; the service enforces
 * owner-only access to the target workspace (PRD §26) and returns a 403 to any
 * non-owner (family members included). Request bodies and queries are validated
 * by the global `ZodValidationPipe` against the `@family/contracts` schemas
 * wrapped as DTOs.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  candidateApproveRequestSchema,
  candidateStatusSchema,
  memoryCreateRequestSchema,
  memoryExtractRequestSchema,
  memoryStatusSchema,
  memorySupersedeRequestSchema,
  memoryTypeSchema,
  memoryUpdateRequestSchema,
  type CandidateListResponse,
  type CandidateSummary,
  type MemoryExtractResponse,
  type MemoryListResponse,
  type MemorySummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { MemoryService, type MemoryDeleteResult } from './memory.service';

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

class MemoryExtractDto extends createZodDto(memoryExtractRequestSchema) {}
class CandidateApproveDto extends createZodDto(candidateApproveRequestSchema) {}
class MemoryCreateDto extends createZodDto(memoryCreateRequestSchema) {}
class MemoryUpdateDto extends createZodDto(memoryUpdateRequestSchema) {}
class MemorySupersedeDto extends createZodDto(memorySupersedeRequestSchema) {}

/** `GET /v1/memory/candidates?workspaceId=&status=` — workspace required. */
const candidateListQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  status: candidateStatusSchema.optional(),
});
class CandidateListQueryDto extends createZodDto(candidateListQuerySchema) {}

/**
 * `GET /v1/memory/memories?workspaceId=&type=&status=&current=&asOf=` — workspace
 * required. `current` is a string flag (`'true'`); `asOf` is an ISO datetime.
 */
const memoryListQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  type: memoryTypeSchema.optional(),
  status: memoryStatusSchema.optional(),
  current: z.enum(['true', 'false']).optional(),
  asOf: z.string().datetime().optional(),
});
class MemoryListQueryDto extends createZodDto(memoryListQuerySchema) {}

@Controller('memory')
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  /* ---------------------------------------------------------------------- */
  /* Candidates                                                              */
  /* ---------------------------------------------------------------------- */

  /** POST /v1/memory/extract — enqueue rule-based extraction (owner-only). */
  @Post('extract')
  @HttpCode(HttpStatus.ACCEPTED)
  extract(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MemoryExtractDto,
  ): Promise<MemoryExtractResponse> {
    return this.memoryService.extract(user.userId, {
      workspaceId: dto.workspaceId,
    });
  }

  /** GET /v1/memory/candidates?workspaceId=&status= — list candidates (owner-only). */
  @Get('candidates')
  async listCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CandidateListQueryDto,
  ): Promise<CandidateListResponse> {
    const items = await this.memoryService.listCandidates(user.userId, {
      workspaceId: query.workspaceId,
      status: query.status,
    });
    return { items };
  }

  /** POST /v1/memory/candidates/:id/approve — promote a candidate (owner-only). */
  @Post('candidates/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveCandidate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CandidateApproveDto,
  ): Promise<MemorySummary> {
    return this.memoryService.approveCandidate(user.userId, id, dto);
  }

  /** POST /v1/memory/candidates/:id/reject — reject a candidate (owner-only). */
  @Post('candidates/:id/reject')
  @HttpCode(HttpStatus.OK)
  rejectCandidate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CandidateSummary> {
    return this.memoryService.rejectCandidate(user.userId, id);
  }

  /* ---------------------------------------------------------------------- */
  /* Memories                                                                */
  /* ---------------------------------------------------------------------- */

  /** GET /v1/memory/memories?workspaceId=&type=&status=&current=&asOf= — list (owner-only). */
  @Get('memories')
  async listMemories(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MemoryListQueryDto,
  ): Promise<MemoryListResponse> {
    const items = await this.memoryService.listMemories(user.userId, {
      workspaceId: query.workspaceId,
      type: query.type,
      status: query.status,
      current: query.current === 'true',
      asOf: query.asOf,
    });
    return { items };
  }

  /** POST /v1/memory/memories — directly create an approved memory (owner-only). */
  @Post('memories')
  @HttpCode(HttpStatus.CREATED)
  createMemory(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MemoryCreateDto,
  ): Promise<MemorySummary> {
    return this.memoryService.createMemory(user.userId, dto);
  }

  /** PATCH /v1/memory/memories/:id — edit a memory, snapshotting the prior state (owner-only). */
  @Patch('memories/:id')
  updateMemory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MemoryUpdateDto,
  ): Promise<MemorySummary> {
    return this.memoryService.updateMemory(user.userId, id, dto);
  }

  /** POST /v1/memory/memories/:id/supersede — replace a memory (owner-only). */
  @Post('memories/:id/supersede')
  @HttpCode(HttpStatus.CREATED)
  supersedeMemory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MemorySupersedeDto,
  ): Promise<MemorySummary> {
    return this.memoryService.supersedeMemory(user.userId, id, dto);
  }

  /** DELETE /v1/memory/memories/:id — soft-delete a memory (owner-only). */
  @Delete('memories/:id')
  deleteMemory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<MemoryDeleteResult> {
    return this.memoryService.deleteMemory(user.userId, id);
  }
}
