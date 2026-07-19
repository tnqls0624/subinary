import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@family/shared';

import { TransactionPromotionService } from '../promotion/transaction-promotion.service';
import { OutboxDispatcherService } from '../outbox/outbox-dispatcher.service';
import { WorkerModelServingService } from '../model-serving/model-serving.service';
import { LocalMerchantClassifierService } from '../model-serving/local-merchant-classifier.service';
import { RealtimePublisherService } from '../realtime/realtime-publisher.service';
import { FcmService } from '../notifications/fcm.service';
import { StorageModule } from '../storage/storage.module';
import { CardSmsParseProcessor } from './card-sms-parse.processor';
import { CategorySuggestProcessor } from './category-suggest.processor';
import { GraphExtractProcessor } from './graph-extract.processor';
import { MemoryExtractProcessor } from './memory-extract.processor';
import { NotificationDispatchProcessor } from './notification-dispatch.processor';
import { RagIndexProcessor } from './rag-index.processor';
import { SlackImportProcessor } from './slack-import.processor';
import { SourceTombstoneProcessor } from './source-tombstone.processor';
import { TestProcessor } from './test.processor';

@Module({
  imports: [
    // 프로세서(Worker)가 forRoot의 connection/prefix 설정을 상속받도록
    // 소비하는 큐를 등록한다(NestJS BullMQ consumer 표준 패턴).
    // RAG_INDEX는 RagIndexProcessor가 소비하고, SlackImportProcessor가 import
    // 성공 후 이 큐에 add하므로(생산자) 함께 등록한다(스펙 §5).
    // MEMORY_EXTRACT/GRAPH_EXTRACT는 RAG outbox가 revision target을 생산하고,
    // API가 복구/backfill용 workspace 전체 잡을 생산한다.
    // CATEGORY_SUGGEST는 CategorySuggestProcessor가 소비하고,
    // TransactionPromotionService가 미분류 승격 시 add하므로(생산자) 함께 등록한다.
    // defaultJobOptions(attempts+backoff)는 SlackImportProcessor가 RAG_INDEX에,
    // TransactionPromotionService가 CATEGORY_SUGGEST에 add하는 producer 경로에
    // 적용된다(소비 동작에는 영향 없음).
    BullModule.registerQueue(
      { name: QUEUE_NAMES.TEST, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.CARD_SMS_PARSE, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.SLACK_IMPORT, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.RAG_INDEX, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.SOURCE_TOMBSTONE, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.MEMORY_EXTRACT, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.GRAPH_EXTRACT, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.CATEGORY_SUGGEST, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      // NotificationDispatchProcessor가 소비하고, TransactionPromotionService가
      // 새 승격 시 add하므로(생산자) 함께 등록한다.
      { name: QUEUE_NAMES.NOTIFICATION_DISPATCH, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
    ),
    // Slack import 프로세서가 MinIO에서 원문 번들을 읽기 위한 경량 스토리지.
    StorageModule,
  ],
  // TransactionPromotionService는 파싱 잡 안에서 거래 승격을 담당한다(스펙 §6).
  // DB(@Global)/ConfigService(@Global)만 의존하므로 별도 import 없이 provider로 둔다.
  // SlackImportProcessor는 StorageModule(export)의 ObjectStorageService를 주입받는다.
  // RagIndexProcessor는 DB(@Global) + createProviders(config.ai)로 자체 임베딩한다.
  // Memory/Graph processor는 current chunk revision을 재검증하고 증분 파생 결과를 publish한다.
  // CategorySuggestProcessor는 DB(@Global) + createProviders(config.ai)로 LLM 분류를 제안한다.
  providers: [
    TestProcessor,
    CardSmsParseProcessor,
    TransactionPromotionService,
    // 거래 승격/파싱 완료를 Redis pub/sub로 발행하는 실시간 힌트 퍼블리셔.
    RealtimePublisherService,
    SlackImportProcessor,
    SourceTombstoneProcessor,
    RagIndexProcessor,
    MemoryExtractProcessor,
    GraphExtractProcessor,
    CategorySuggestProcessor,
    // 새 거래 승격 시 FCM 푸시를 발송(수신자 해석·마스킹·선호 필터).
    NotificationDispatchProcessor,
    FcmService,
    OutboxDispatcherService,
    WorkerModelServingService,
    LocalMerchantClassifierService,
  ],
})
export class ProcessorsModule {}
