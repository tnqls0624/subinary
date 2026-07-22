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
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';

import {
  notificationPreferencesUpdateRequestSchema,
  pushSubscriptionRegisterRequestSchema,
  type NotificationListResponse,
  type NotificationPreferences,
  type NotificationUnreadCount,
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

  /* --- 인앱 알림함 --- */

  /** GET /v1/notifications/unread-count — 안읽음 개수. (동적 :id보다 먼저 선언) */
  @Get('unread-count')
  unreadCount(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NotificationUnreadCount> {
    return this.notificationService.unreadCount(user.userId);
  }

  /** GET /v1/notifications?cursor=&limit= — 알림 목록(최신순, 커서). */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<NotificationListResponse> {
    const parsed = limit !== undefined ? Number(limit) : undefined;
    const take =
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
    return this.notificationService.listNotifications(user.userId, cursor, take);
  }

  /** POST /v1/notifications/read-all — 전체 읽음. */
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllRead(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ success: true }> {
    await this.notificationService.markAllRead(user.userId);
    return { success: true };
  }

  /** POST /v1/notifications/:id/read — 단건 읽음. */
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ success: true }> {
    await this.notificationService.markRead(user.userId, id);
    return { success: true };
  }
}
