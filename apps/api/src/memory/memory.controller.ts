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
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination';

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

class MemoryExtractDto extends createZodDto(memoryExtractRequestSchema) {}
class CandidateApproveDto extends createZodDto(candidateApproveRequestSchema) {}
class MemoryCreateDto extends createZodDto(memoryCreateRequestSchema) {}
class MemoryUpdateDto extends createZodDto(memoryUpdateRequestSchema) {}
class MemorySupersedeDto extends createZodDto(memorySupersedeRequestSchema) {}

/**
 * 목록 공통 페이지 파라미터. 쿼리스트링은 항상 문자열이라 `z.coerce`로 받고,
 * **미지정 시 기본 상한이 걸린다**(무제한 아님). 상한을 넘는 요청은 400 —
 * 조용히 잘라 주면 클라이언트는 자기가 전부 받았다고 착각한다.
 *
 * 빈 문자열(`?limit=&cursor=`)은 "잘못된 값"이 아니라 "미지정"으로 본다. 쿼리를
 * 조립하는 클라이언트가 흔히 만드는 모양이고, 여기서 400을 주면 상한을 지키려다
 * 정상 요청을 막는다.
 */
const emptyAsUndefined = (value: unknown): unknown =>
  value === '' ? undefined : value;

const paginationQueryShape = {
  limit: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
  ),
  cursor: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
};

/** `GET /v1/memory/candidates?workspaceId=&status=&limit=&cursor=` — workspace required. */
const candidateListQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  status: candidateStatusSchema.optional(),
  ...paginationQueryShape,
});
class CandidateListQueryDto extends createZodDto(candidateListQuerySchema) {}

/**
 * `GET /v1/memory/memories?workspaceId=&type=&status=&current=&asOf=&limit=&cursor=`
 * — workspace required. `current` is a string flag (`'true'`); `asOf` is an ISO
 * datetime.
 */
const memoryListQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  type: memoryTypeSchema.optional(),
  status: memoryStatusSchema.optional(),
  current: z.enum(['true', 'false']).optional(),
  asOf: z.string().datetime().optional(),
  ...paginationQueryShape,
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

  /** GET /v1/memory/candidates?workspaceId=&status=&limit=&cursor= — list candidates (owner-only). */
  @Get('candidates')
  listCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CandidateListQueryDto,
  ): Promise<CandidateListResponse> {
    return this.memoryService.listCandidates(user.userId, {
      workspaceId: query.workspaceId,
      status: query.status,
      limit: query.limit,
      cursor: query.cursor,
    });
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

  /** GET /v1/memory/memories?workspaceId=&type=&status=&current=&asOf=&limit=&cursor= — list (owner-only). */
  @Get('memories')
  listMemories(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MemoryListQueryDto,
  ): Promise<MemoryListResponse> {
    return this.memoryService.listMemories(user.userId, {
      workspaceId: query.workspaceId,
      type: query.type,
      status: query.status,
      current: query.current === 'true',
      asOf: query.asOf,
      limit: query.limit,
      cursor: query.cursor,
    });
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
