/**
 * 금액 계약 공용 모듈 (ADR-0027).
 *
 * 두 가지를 담는다.
 *  1. **shadow 관측**(롤아웃 3단계) — 거래를 만드는 경로가 두 모듈(`CardSmsModule`의
 *     수동 입력·사람 검토, `TransactionsModule`의 수정·취소 연결)에 흩어져 있어 공용
 *     모듈로 뺀다. 관측 지점이 늘어날 때 이 모듈만 import하면 되고, **관측 코드가
 *     진입점마다 복사되지 않는다** — D-2·D-3이 정확히 복사로 생긴 결함이다.
 *  2. **전환 런타임**(롤아웃 5단계 선행) — 모드 게시와 쓰기 펜스. 막아야 하는 4개 경로가
 *     같은 두 모듈에 있으므로 가드도 같은 자리에서 내보낸다.
 */
import {
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { AppConfig } from '@family/config';

import { MONEY_REDIS_CLIENT } from './money.constants';
import { MoneyRuntimeService } from './money-runtime.service';
import { MoneyShadowService } from './money-shadow.service';
import { MoneyWriteFenceGuard } from './money-write-fence.guard';

@Module({
  providers: [
    {
      provide: MONEY_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const redis = configService.get<AppConfig['redis']>('redis');
        if (!redis) {
          throw new Error('Redis configuration is missing');
        }
        return new Redis({
          host: redis.host,
          port: redis.port,
          lazyConnect: true,
          // 펜스 조회는 요청 경로에 있다. 오래 매달리면 펜스가 아니라 지연이 장애가 된다 —
          // 짧게 끊고 가드가 fail-closed 판정을 내리게 한다.
          maxRetriesPerRequest: 1,
          connectTimeout: 2_000,
          commandTimeout: 2_000,
        });
      },
    },
    MoneyShadowService,
    MoneyRuntimeService,
    MoneyWriteFenceGuard,
  ],
  exports: [MoneyShadowService, MoneyRuntimeService, MoneyWriteFenceGuard],
})
export class MoneyModule implements OnModuleDestroy {
  private readonly logger = new Logger(MoneyModule.name);

  constructor(@Inject(MONEY_REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Redis quit failed, forcing disconnect: ${message}`);
      this.redis.disconnect();
    }
  }
}
