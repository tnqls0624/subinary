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
 * `kind`, `syncMode`). Multipart bypasses the JSON body DTO pipeline, so the
 * parts are read manually from the Fastify request via `@fastify/multipart`
 * (registered in `main.ts`). Message PATCH/DELETE routes update the current
 * projection and atomically publish a target RAG event; other routes are GETs.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
// Importing a multipart type also loads the `fastify` module augmentation that
// adds `req.isMultipart()` / `req.parts()` used below.
import type { MultipartFile } from '@fastify/multipart';

import type {
  SlackImportResponse,
  SlackImportStatusResponse,
  SlackMessageChangeResponse,
  SlackMessageEditRequest,
  SlackMessageListResponse,
  SlackThreadResponse,
  SlackWorkspaceSummary,
} from '@family/contracts';
import { slackMessageEditRequestSchema } from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { SlackMessageMutationService } from './slack-message-mutation.service';
import { SlackService, type SlackImportFields } from './slack.service';
import {
  SLACK_UPLOAD_RETRY_AFTER_SECONDS,
  UploadMemoryBudget,
} from './upload-budget';

class SlackMessageParamDto extends createZodDto(
  z.object({ id: z.string().uuid() }),
) {}
class SlackImportParamDto extends createZodDto(
  z.object({ importId: z.string().uuid() }),
) {}
class SlackMessageEditDto extends createZodDto(
  slackMessageEditRequestSchema,
) {}

/**
 * 동시 업로드 메모리 예산(프로세스 전역).
 *
 * 컨트롤러 인스턴스가 아니라 모듈 스코프에 두는 이유: NestJS 기본 스코프에서 컨트롤러는
 * 싱글턴이지만, 나중에 REQUEST 스코프로 바뀌면 요청마다 예산이 새로 생겨 상한이 조용히
 * 사라진다. 막으려는 것은 **이 프로세스의 힙**이므로 프로세스에 붙여 둔다.
 */
const uploadBudget = new UploadMemoryBudget();

@Controller('slack')
export class SlackController {
  constructor(
    private readonly slackService: SlackService,
    private readonly messageMutationService: SlackMessageMutationService,
  ) {}

  /**
   * POST /v1/slack/import — upload a Slack export (multipart). Accepts **both** a
   * Slack Export **ZIP** and the legacy pre-merged single JSON bundle; the format
   * is decided by magic bytes in the service, never by the client's content-type.
   *
   * 업로드는 파일 **전체를 메모리에** 올린다(`toBuffer`). 동시에 여러 건이 올라오면
   * 그것만으로 API가 죽으므로 **읽기 전에** 프로세스 전역 메모리 예산을 잡고, 여유가
   * 없으면 503 + `Retry-After`로 돌려보낸다. 예산은 `finally`에서 반드시 푼다 —
   * 한 번이라도 새면 상한이 영구히 줄어든다.
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

    const release = uploadBudget.tryAcquire();
    if (release === null) {
      // 사용자 잘못이 아니라 서버가 지금 여유가 없는 것이다 — 429가 아니라 503이고,
      // 잠시 뒤 같은 파일을 그대로 다시 올리면 된다.
      throw new ServiceUnavailableException({
        message: 'too many concurrent uploads; retry shortly',
        retryAfterSeconds: SLACK_UPLOAD_RETRY_AFTER_SECONDS,
      });
    }

    try {
      let fileBuffer: Buffer | null = null;
      const fields: SlackImportFields = {};

      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const filePart = part as MultipartFile;
          if (filePart.fieldname === 'file' && fileBuffer === null) {
            // ZIP은 워크스페이스 표시명을 담고 있지 않다 — 파일 이름이 마지막 단서다.
            fields.fileName = filePart.filename;
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
          } else if (part.fieldname === 'syncMode') {
            fields.syncMode = value;
          }
        }
      }

      if (!fileBuffer) {
        throw new BadRequestException('file field is required');
      }

      return await this.slackService.import(user.userId, fileBuffer, fields);
    } finally {
      release();
    }
  }

  /**
   * GET /v1/slack/imports/:importId — import 1건의 상태(owner 전용).
   *
   * 업로드 응답은 `queued`뿐이라 그것만으로는 성공을 알 수 없다. 이 조회가 없던 동안
   * 워커에서 실패해도 사용자는 이유를 영영 알 수 없었다.
   *
   * `no-store`: 폴링하는 값이라 중간 캐시가 옛 상태를 돌려주면 화면이 영영 `queued`에
   * 머문다.
   */
  @Get('imports/:importId')
  @Header('Cache-Control', 'no-store')
  getImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: SlackImportParamDto,
  ): Promise<SlackImportStatusResponse> {
    return this.slackService.getImport(user.userId, params.importId);
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

  /** 메시지 current projection을 편집하고 대상 chunk 증분 갱신을 예약한다. */
  @Patch('messages/:id')
  editMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: SlackMessageParamDto,
    @Body() dto: SlackMessageEditDto,
  ): Promise<SlackMessageChangeResponse> {
    const input: SlackMessageEditRequest = dto;
    return this.messageMutationService.editMessage(
      user.userId,
      params.id,
      input,
    );
  }

  /** 메시지를 tombstone 처리하고 대상 chunk 증분 삭제를 예약한다. */
  @Delete('messages/:id')
  @HttpCode(HttpStatus.OK)
  deleteMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: SlackMessageParamDto,
  ): Promise<SlackMessageChangeResponse> {
    return this.messageMutationService.deleteMessage(user.userId, params.id);
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
