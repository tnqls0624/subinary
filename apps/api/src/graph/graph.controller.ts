/**
 * Temporal GraphRAG HTTP surface (Phase 9 Build Spec §6.3).
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
  entityTypeSchema,
  graphExtractRequestSchema,
  relationshipSupersedeRequestSchema,
  relationshipTypeSchema,
  type EntityDetail,
  type EntityListResponse,
  type GraphExtractResponse,
  type RelationshipListResponse,
  type RelationshipSummary,
  type TimelineResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { GraphService } from './graph.service';

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

class GraphExtractDto extends createZodDto(graphExtractRequestSchema) {}
class RelationshipSupersedeDto extends createZodDto(
  relationshipSupersedeRequestSchema,
) {}

/** `GET /v1/graph/entities?workspaceId=&type=&q=` — workspace required. */
const entityListQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  type: entityTypeSchema.optional(),
  q: z.string().optional(),
});
class EntityListQueryDto extends createZodDto(entityListQuerySchema) {}

/**
 * `GET /v1/graph/entities/:id?current=&asOf=` — local graph temporal filter.
 * `current` is a string flag (`'true'`); `asOf` is an ISO datetime.
 */
const entityDetailQuerySchema = z.object({
  current: z.enum(['true', 'false']).optional(),
  asOf: z.string().datetime().optional(),
});
class EntityDetailQueryDto extends createZodDto(entityDetailQuerySchema) {}

/**
 * `GET /v1/graph/relationships?workspaceId=&entityId=&type=&current=&asOf=` —
 * workspace required. `current` is a string flag; `asOf` is an ISO datetime.
 */
const relationshipListQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  entityId: z.string().uuid().optional(),
  type: relationshipTypeSchema.optional(),
  current: z.enum(['true', 'false']).optional(),
  asOf: z.string().datetime().optional(),
});
class RelationshipListQueryDto extends createZodDto(
  relationshipListQuerySchema,
) {}

/** `GET /v1/graph/timeline?workspaceId=&entityId=` — both required. */
const timelineQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  entityId: z.string().uuid(),
});
class TimelineQueryDto extends createZodDto(timelineQuerySchema) {}

@Controller('graph')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  /* ---------------------------------------------------------------------- */
  /* Extraction                                                              */
  /* ---------------------------------------------------------------------- */

  /** POST /v1/graph/extract — enqueue rule-based graph extraction (owner-only). */
  @Post('extract')
  @HttpCode(HttpStatus.ACCEPTED)
  extract(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GraphExtractDto,
  ): Promise<GraphExtractResponse> {
    return this.graphService.extract(user.userId, {
      workspaceId: dto.workspaceId,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Entities                                                                */
  /* ---------------------------------------------------------------------- */

  /** GET /v1/graph/entities?workspaceId=&type=&q= — list entities (owner-only). */
  @Get('entities')
  async listEntities(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EntityListQueryDto,
  ): Promise<EntityListResponse> {
    const items = await this.graphService.listEntities(user.userId, {
      workspaceId: query.workspaceId,
      type: query.type,
      q: query.q,
    });
    return { items };
  }

  /** GET /v1/graph/entities/:id?current=&asOf= — entity + 1-hop local graph (owner-only). */
  @Get('entities/:id')
  getEntity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: EntityDetailQueryDto,
  ): Promise<EntityDetail> {
    return this.graphService.getEntity(user.userId, id, {
      current: query.current === 'true',
      asOf: query.asOf,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Relationships                                                           */
  /* ---------------------------------------------------------------------- */

  /** GET /v1/graph/relationships?workspaceId=&entityId=&type=&current=&asOf= — list (owner-only). */
  @Get('relationships')
  async listRelationships(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RelationshipListQueryDto,
  ): Promise<RelationshipListResponse> {
    const items = await this.graphService.listRelationships(user.userId, {
      workspaceId: query.workspaceId,
      entityId: query.entityId,
      type: query.type,
      current: query.current === 'true',
      asOf: query.asOf,
    });
    return { items };
  }

  /** POST /v1/graph/relationships/:id/supersede — explicitly replace a relationship (owner-only). */
  @Post('relationships/:id/supersede')
  @HttpCode(HttpStatus.CREATED)
  supersedeRelationship(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RelationshipSupersedeDto,
  ): Promise<RelationshipSummary> {
    return this.graphService.supersedeRelationship(user.userId, id, {
      sourceEntityId: dto.sourceEntityId,
      targetEntityId: dto.targetEntityId,
      type: dto.type,
      sourceRefId: dto.sourceRefId,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Timeline                                                                */
  /* ---------------------------------------------------------------------- */

  /** GET /v1/graph/timeline?workspaceId=&entityId= — relationship history, validFrom asc (owner-only). */
  @Get('timeline')
  async timeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TimelineQueryDto,
  ): Promise<TimelineResponse> {
    const items = await this.graphService.timeline(user.userId, {
      workspaceId: query.workspaceId,
      entityId: query.entityId,
    });
    return { entityId: query.entityId, items };
  }
}
