/**
 * 주기 유지보수 모듈.
 *
 * BullMQ 큐를 쓰지 않는 "그냥 주기적으로 돌아야 하는" 정리 작업을 모은다. 전용 큐를
 * 만들 만한 작업이 아니고(재시도·관측이 필요한 일이 아니다), 프로세서에 얹으면 잡이
 * 들어오지 않으면 영원히 돌지 않는다.
 */
import { Module } from '@nestjs/common';

import { DeviceNonceCleanupService } from './device-nonce-cleanup.service';

@Module({
  providers: [DeviceNonceCleanupService],
})
export class MaintenanceModule {}
