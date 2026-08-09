/**
 * 정기 지출 Radar 모듈 (C-5).
 *
 * `DB`는 전역 `DatabaseModule`에서, 라우트 보호는 전역 `AccessTokenGuard`(AppModule의
 * `AuthModule`)가 담당하므로 여기서 재import하지 않는다(다른 도메인 모듈과 같은 관례).
 *
 * ⚠️ 모듈이 붙었다고 기능이 켜진 것은 아니다 — 사용자 노출은
 * `RECURRING_RADAR_ENABLED`(기본 off)가 막는다. 스키마 배포와 노출을 분리한다.
 */
import { Module } from '@nestjs/common';

import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';

@Module({
  controllers: [RecurringController],
  providers: [RecurringService],
  exports: [RecurringService],
})
export class RecurringModule {}
