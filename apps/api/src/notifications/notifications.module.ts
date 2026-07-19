import { Module } from '@nestjs/common';

import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/**
 * 알림 모듈 — 푸시 구독/선호 관리. DB(@Global)/전역 AccessTokenGuard만 의존하므로
 * 추가 import 없음. 실제 발송은 worker의 notification-dispatch가 담당한다.
 */
@Module({
  controllers: [NotificationController],
  providers: [NotificationService],
})
export class NotificationsModule {}
