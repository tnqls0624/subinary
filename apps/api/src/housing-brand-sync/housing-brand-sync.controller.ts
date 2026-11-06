import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import {
  housingBrandApplyRequestSchema, housingBrandConnectRequestSchema, housingBrandSyncRequestSchema,
  type HousingBrandConnectResponse, type HousingBrandSyncPreview, type ManualHousingPlanResponse,
} from '@family/contracts';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { HousingBrandSyncService } from './housing-brand-sync.service';

class ConnectDto extends createZodDto(housingBrandConnectRequestSchema) {}
class SyncDto extends createZodDto(housingBrandSyncRequestSchema) {}
class ApplyDto extends createZodDto(housingBrandApplyRequestSchema) {}

/**
 * 신축 조회는 `/plan` 주택 납부 일정에 붙는다. 새 최상위 화면·연결 관리 화면이 아니다.
 */
@Controller('manual-finance/housing-plans/:planId')
export class HousingBrandSyncController {
  constructor(private readonly service: HousingBrandSyncService) {}

  @Post('brand-connection')
  @HttpCode(HttpStatus.OK)
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() body: ConnectDto,
  ): Promise<HousingBrandConnectResponse> {
    return this.service.connect(user.userId, planId, body);
  }

  @Post('brand-sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() body: SyncDto,
  ): Promise<HousingBrandSyncPreview> {
    return this.service.sync(user.userId, planId, body);
  }

  @Post('brand-sync/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() body: ApplyDto,
  ): Promise<ManualHousingPlanResponse> {
    return this.service.apply(user.userId, planId, body);
  }
}
