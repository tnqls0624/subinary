/**
 * Slack HTTP surface (Phase 6 Build Spec §5.3).
 *
 * All routes require a normal user access token (the global
 * {@link AccessTokenGuard} runs — none are `@Public()`). The authenticated
 * principal is passed to the service as the actor `userId`; the service enforces
 * owner-only access (PRD §26) and returns a 403 to any non-owner (family members
 * included).
 *
 * `POST /v1/slack/import` is `multipart/form-data`: the bundle arrives as the
 * `file` part alongside optional text fields (`mySlackUserId`, `workspaceName`,
 * `kind`). Multipart bypasses the JSON body DTO pipeline, so the parts are read
 * manually from the Fastify request via `@fastify/multipart` (registered in
 * `main.ts`). The remaining routes are read-only GETs with query parameters
 * only, so no request-body DTO is involved.
 */
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
// Importing a multipart type also loads the `fastify` module augmentation that
// adds `req.isMultipart()` / `req.parts()` used below.
import type { MultipartFile } from '@fastify/multipart';

import type {
  SlackImportResponse,
  SlackMessageListResponse,
  SlackThreadResponse,
  SlackWorkspaceSummary,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { SlackService, type SlackImportFields } from './slack.service';

@Controller('slack')
export class SlackController {
  constructor(private readonly slackService: SlackService) {}

  /**
   * POST /v1/slack/import — upload a Slack export bundle (multipart). Reads the
   * `file` part into a buffer and collects the optional text fields regardless
   * of part order, then hands off to the (idempotent, async-parsing) service.
   */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  async importBundle(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
  ): Promise<SlackImportResponse> {
    if (!req.isMultipart()) {
      throw new BadRequestException('multipart/form-data is required');
    }

    let fileBuffer: Buffer | null = null;
    const fields: SlackImportFields = {};

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        const filePart = part as MultipartFile;
        if (filePart.fieldname === 'file' && fileBuffer === null) {
          fileBuffer = await filePart.toBuffer();
        } else {
          // Drain any unexpected/extra file stream so iteration can proceed.
          await filePart.toBuffer();
        }
      } else {
        const value =
          typeof part.value === 'string' ? part.value : String(part.value);
        if (part.fieldname === 'mySlackUserId') {
          fields.mySlackUserId = value;
        } else if (part.fieldname === 'workspaceName') {
          fields.workspaceName = value;
        } else if (part.fieldname === 'kind') {
          fields.kind = value;
        }
      }
    }

    if (!fileBuffer) {
      throw new BadRequestException('file field is required');
    }

    return this.slackService.import(user.userId, fileBuffer, fields);
  }

  /** GET /v1/slack/workspaces — the caller's own Slack workspaces. */
  @Get('workspaces')
  listWorkspaces(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SlackWorkspaceSummary[]> {
    return this.slackService.listWorkspaces(user.userId);
  }

  /** GET /v1/slack/workspaces/:id — a single owned workspace summary. */
  @Get('workspaces/:id')
  getWorkspace(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<SlackWorkspaceSummary> {
    return this.slackService.getWorkspace(user.userId, id);
  }

  /**
   * GET /v1/slack/messages?slackWorkspaceId=&channelId=&from=&to=&q=&mine=&limit=&cursor=
   * — owner-only keyword/channel/date/mine search (newest first, keyset-paged).
   */
  @Get('messages')
  searchMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Query('slackWorkspaceId') slackWorkspaceId?: string,
    @Query('channelId') channelId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('mine') mine?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SlackMessageListResponse> {
    return this.slackService.searchMessages(user.userId, {
      slackWorkspaceId,
      channelId,
      from,
      to,
      q,
      mine,
      limit,
      cursor,
    });
  }

  /**
   * GET /v1/slack/threads?slackWorkspaceId=&channelId=&threadTs= — a restored
   * thread (root + replies ordered by ts ascending), owner-only.
   */
  @Get('threads')
  getThread(
    @CurrentUser() user: AuthenticatedUser,
    @Query('slackWorkspaceId') slackWorkspaceId?: string,
    @Query('channelId') channelId?: string,
    @Query('threadTs') threadTs?: string,
  ): Promise<SlackThreadResponse> {
    return this.slackService.getThread(
      user.userId,
      slackWorkspaceId,
      channelId,
      threadTs,
    );
  }
}
