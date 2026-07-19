import { Global, Module } from '@nestjs/common';

import { RealtimePublisherService } from './realtime-publisher.service';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

/**
 * 실시간 무효화 힌트 모듈 — 워커/API의 Redis pub/sub 발행을 SSE로 중계한다.
 * DB(@Global)/ConfigService(@Global)만 의존하므로 추가 import 없음.
 * Publisher는 거래/카테고리 뮤테이션 서비스가 주입받도록 @Global export.
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService, RealtimePublisherService],
  exports: [RealtimePublisherService],
})
export class RealtimeModule {}
