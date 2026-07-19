import { Module } from '@nestjs/common';

import { OperationalAlertDispatcherService } from './operational-alert-dispatcher.service';

/** 원문 없는 운영 지표와 외부 alert 제어 평면. */
@Module({
  providers: [OperationalAlertDispatcherService],
  exports: [OperationalAlertDispatcherService],
})
export class ObservabilityModule {}
