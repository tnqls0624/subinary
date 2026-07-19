import {
  Controller,
  Delete,
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
  quarantinedOutboxListQuerySchema,
  type OutboxReprocessResponse,
  type QuarantinedOutboxListResponse,
  type SourceTombstoneResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { LearningDataControlService } from './learning-data-control.service';

class SourceItemParamDto extends createZodDto(
  z.object({ sourceItemId: z.string().uuid() }),
) {}
class OutboxEventParamDto extends createZodDto(
  z.object({ eventId: z.string().uuid() }),
) {}
class QuarantinedOutboxListQueryDto extends createZodDto(
  quarantinedOutboxListQuerySchema,
) {}

/** owner/admin 전용 삭제 전파와 outbox 복구 API. */
@Controller('learning')
export class LearningDataControlController {
  constructor(private readonly controlService: LearningDataControlService) {}

  /** source를 tombstone 처리하고 비동기 privacy propagation을 예약한다. */
  @Delete('sources/:sourceItemId')
  @HttpCode(HttpStatus.OK)
  tombstoneSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: SourceItemParamDto,
  ): Promise<SourceTombstoneResponse> {
    return this.controlService.tombstoneSource(
      user.userId,
      params.sourceItemId,
    );
  }

  /** 소유 범위의 격리 event 운영 메타데이터를 조회한다. */
  @Get('outbox/quarantined')
  async listQuarantinedEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QuarantinedOutboxListQueryDto,
  ): Promise<QuarantinedOutboxListResponse> {
    return {
      items: await this.controlService.listQuarantinedEvents(user.userId, query),
    };
  }

  /** 격리 event의 retry budget을 초기화해 dispatcher 재발행을 예약한다. */
  @Post('outbox/:eventId/reprocess')
  @HttpCode(HttpStatus.OK)
  reprocessQuarantinedEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: OutboxEventParamDto,
  ): Promise<OutboxReprocessResponse> {
    return this.controlService.reprocessQuarantinedEvent(
      user.userId,
      params.eventId,
    );
  }
}
