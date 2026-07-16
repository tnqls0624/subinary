import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';

import { loadConfig } from '@family/config';

import { ZodValidationPipe } from 'nestjs-zod';

import { AiModule } from './ai/ai.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { BudgetsModule } from './budgets/budgets.module';
import { CardSmsModule } from './card-sms/card-sms.module';
import { CardsModule } from './cards/cards.module';
import { CategoriesModule } from './categories/categories.module';
import { DatabaseModule } from './database/database.module';
import { DevModule } from './dev/dev.module';
import { DevicesModule } from './devices/devices.module';
import { GraphModule } from './graph/graph.module';
import { HealthModule } from './health/health.module';
import { HouseholdModule } from './household/household.module';
import { MemoryModule } from './memory/memory.module';
import { QueueModule } from './queue/queue.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { SlackModule } from './slack/slack.module';
import { StorageModule } from './storage/storage.module';
import { TransactionsModule } from './transactions/transactions.module';

/**
 * DevModule exposes development-only endpoints (echo, test-job, storage-test)
 * and must never be mounted in production.
 */
const devOnlyModules = process.env.NODE_ENV !== 'production' ? [DevModule] : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig] }),
    DatabaseModule,
    StorageModule,
    QueueModule,
    AiModule,
    HealthModule,
    AuthModule,
    HouseholdModule,
    DevicesModule,
    CardSmsModule,
    CardsModule,
    CategoriesModule,
    TransactionsModule,
    AnalyticsModule,
    BudgetsModule,
    SlackModule,
    RetrievalModule,
    MemoryModule,
    GraphModule,
    ...devOnlyModules,
  ],
  providers: [
    // 전역 zod 검증 파이프. APP_GUARD(AccessTokenGuard)는 AuthModule에서 provide.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
