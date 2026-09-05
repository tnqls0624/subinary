/**
 * 플레이그라운드 미니앱 상태 HTTP 표면.
 *
 * 경로에 미니앱 키가 들어간다(`/v1/play/monthly-forecast/2026-09`). 미니앱을 추가할 때
 * 서버를 고치지 않는 것이 이 설계의 요점이다 — 새 게임은 새 키를 쓰면 된다.
 *
 * 키는 계약(`playAppKeySchema`)이 영숫자·`_`·`-`로 좁힌다. 경로에 그대로 실리므로
 * 슬래시가 섞이면 라우팅이 어긋난다.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  playAppKeySchema,
  playStateKeySchema,
  playStateSaveRequestSchema,
  type PlayStateDeleteResponse,
  type PlayStateListResponse,
  type PlayState,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { PlayService } from './play.service';

const playListQuerySchema = z.object({ householdId: z.string().uuid() });
class PlayListQueryDto extends createZodDto(playListQuerySchema) {}
class PlayStateSaveDto extends createZodDto(playStateSaveRequestSchema) {}

/** 경로 파라미터는 파이프를 타지 않으므로 여기서 직접 검증한다. */
function parseKey(value: string, schema_: typeof playAppKeySchema): string {
  return schema_.parse(value);
}

@Controller('play')
export class PlayController {
  constructor(private readonly playService: PlayService) {}

  /** GET /v1/play/:appKey?householdId=… — 그 미니앱의 상태 전부. */
  @Get(':appKey')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('appKey') appKey: string,
    @Query() query: PlayListQueryDto,
  ): Promise<PlayStateListResponse> {
    const items = await this.playService.list(
      user.userId,
      query.householdId,
      parseKey(appKey, playAppKeySchema),
    );
    return { items };
  }

  /** PUT /v1/play/:appKey/:stateKey — 저장(upsert). */
  @Put(':appKey/:stateKey')
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('appKey') appKey: string,
    @Param('stateKey') stateKey: string,
    @Body() dto: PlayStateSaveDto,
  ): Promise<PlayState> {
    return this.playService.save(
      user.userId,
      parseKey(appKey, playAppKeySchema),
      parseKey(stateKey, playStateKeySchema),
      dto,
    );
  }

  /** DELETE /v1/play/:appKey/:stateKey?householdId=… — 멱등 삭제. */
  @Delete(':appKey/:stateKey')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('appKey') appKey: string,
    @Param('stateKey') stateKey: string,
    @Query() query: PlayListQueryDto,
  ): Promise<PlayStateDeleteResponse> {
    const deleted = await this.playService.remove(
      user.userId,
      query.householdId,
      parseKey(appKey, playAppKeySchema),
      parseKey(stateKey, playStateKeySchema),
    );
    return { deleted };
  }
}
