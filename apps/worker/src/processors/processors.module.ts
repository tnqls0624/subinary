import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_NAMES } from '@family/shared';

import { TransactionPromotionService } from '../promotion/transaction-promotion.service';
import { StorageModule } from '../storage/storage.module';
import { CardSmsParseProcessor } from './card-sms-parse.processor';
import { SlackImportProcessor } from './slack-import.processor';
import { TestProcessor } from './test.processor';

@Module({
  imports: [
    // 프로세서(Worker)가 forRoot의 connection/prefix 설정을 상속받도록
    // 소비하는 큐를 등록한다(NestJS BullMQ consumer 표준 패턴).
    BullModule.registerQueue(
      { name: QUEUE_NAMES.TEST },
      { name: QUEUE_NAMES.CARD_SMS_PARSE },
      { name: QUEUE_NAMES.SLACK_IMPORT },
    ),
    // Slack import 프로세서가 MinIO에서 원문 번들을 읽기 위한 경량 스토리지.
    StorageModule,
  ],
  // TransactionPromotionService는 파싱 잡 안에서 거래 승격을 담당한다(스펙 §6).
  // DB(@Global)/ConfigService(@Global)만 의존하므로 별도 import 없이 provider로 둔다.
  // SlackImportProcessor는 StorageModule(export)의 ObjectStorageService를 주입받는다.
  providers: [
    TestProcessor,
    CardSmsParseProcessor,
    TransactionPromotionService,
    SlackImportProcessor,
  ],
})
export class ProcessorsModule {}
