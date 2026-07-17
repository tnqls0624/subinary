import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@family/shared';

import { TransactionPromotionService } from '../promotion/transaction-promotion.service';
import { StorageModule } from '../storage/storage.module';
import { CardSmsParseProcessor } from './card-sms-parse.processor';
import { CategorySuggestProcessor } from './category-suggest.processor';
import { GraphExtractProcessor } from './graph-extract.processor';
import { MemoryExtractProcessor } from './memory-extract.processor';
import { RagIndexProcessor } from './rag-index.processor';
import { SlackImportProcessor } from './slack-import.processor';
import { TestProcessor } from './test.processor';

@Module({
  imports: [
    // 프로세서(Worker)가 forRoot의 connection/prefix 설정을 상속받도록
    // 소비하는 큐를 등록한다(NestJS BullMQ consumer 표준 패턴).
    // RAG_INDEX는 RagIndexProcessor가 소비하고, SlackImportProcessor가 import
    // 성공 후 이 큐에 add하므로(생산자) 함께 등록한다(스펙 §5).
    // MEMORY_EXTRACT는 MemoryExtractProcessor가 소비한다(api가 생산, Phase 8 §5).
    // GRAPH_EXTRACT는 GraphExtractProcessor가 소비한다(api가 생산, Phase 9 §5).
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
      { name: QUEUE_NAMES.MEMORY_EXTRACT, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.GRAPH_EXTRACT, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
      { name: QUEUE_NAMES.CATEGORY_SUGGEST, defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS },
    ),
    // Slack import 프로세서가 MinIO에서 원문 번들을 읽기 위한 경량 스토리지.
    StorageModule,
  ],
  // TransactionPromotionService는 파싱 잡 안에서 거래 승격을 담당한다(스펙 §6).
  // DB(@Global)/ConfigService(@Global)만 의존하므로 별도 import 없이 provider로 둔다.
  // SlackImportProcessor는 StorageModule(export)의 ObjectStorageService를 주입받는다.
  // RagIndexProcessor는 DB(@Global) + createProviders(config.ai)로 자체 임베딩한다.
  // MemoryExtractProcessor는 DB(@Global) + @family/rag 규칙 추출로 후보를 upsert한다.
  // GraphExtractProcessor는 DB(@Global) + @family/rag extractGraph로 엔티티/관계를 upsert한다.
  // CategorySuggestProcessor는 DB(@Global) + createProviders(config.ai)로 LLM 분류를 제안한다.
  providers: [
    TestProcessor,
    CardSmsParseProcessor,
    TransactionPromotionService,
    SlackImportProcessor,
    RagIndexProcessor,
    MemoryExtractProcessor,
    GraphExtractProcessor,
    CategorySuggestProcessor,
  ],
})
export class ProcessorsModule {}
