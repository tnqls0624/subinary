import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_NAMES } from '@family/shared';

import { TestProcessor } from './test.processor';

@Module({
  imports: [
    // 프로세서(Worker)가 forRoot의 connection/prefix 설정을 상속받도록
    // 소비하는 큐를 등록한다(NestJS BullMQ consumer 표준 패턴).
    BullModule.registerQueue({ name: QUEUE_NAMES.TEST }),
  ],
  providers: [TestProcessor],
})
export class ProcessorsModule {}
