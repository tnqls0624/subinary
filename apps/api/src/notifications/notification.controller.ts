/**
 * 알림 HTTP 표면 — 푸시 구독 등록/해지 + 알림 선호 조회/갱신.
 * 전역 AccessTokenGuard로 보호되며, 모든 자원은 인증 사용자 단위다.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  notificationPreferencesUpdateRequestSchema,
  pushSubscriptionRegisterRequestSchema,
  type NotificationPreferences,
  type PushSubscriptionResponse,
} from '@family/contracts';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { NotificationService } from './notification.service';

class PushSubscriptionRegisterDto extends createZodDto(
  pushSubscriptionRegisterRequestSchema,
) {}
class NotificationPreferencesUpdateDto extends createZodDto(
  notificationPreferencesUpdateRequestSchema,
) {}

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /** POST /v1/notifications/subscriptions — FCM 토큰 등록/갱신. */
  @Post('subscriptions')
  @HttpCode(HttpStatus.OK)
  async registerSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PushSubscriptionRegisterDto,
  ): Promise<PushSubscriptionResponse> {
    await this.notificationService.registerSubscription(user.userId, dto);
    return { registered: true };
  }

  /** DELETE /v1/notifications/subscriptions/:token — 구독 해지(로그아웃). */
  @Delete('subscriptions/:token')
  @HttpCode(HttpStatus.OK)
  async removeSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<{ removed: true }> {
    await this.notificationService.removeSubscription(user.userId, token);
    return { removed: true };
  }

  /** GET /v1/notifications/preferences — 현재 알림 선호(없으면 기본값). */
  @Get('preferences')
  getPreferences(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NotificationPreferences> {
    return this.notificationService.getPreferences(user.userId);
  }

  /** PUT /v1/notifications/preferences — 알림 선호 전체 대체. */
  @Put('preferences')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: NotificationPreferencesUpdateDto,
  ): Promise<NotificationPreferences> {
    return this.notificationService.updatePreferences(user.userId, dto);
  }
}
