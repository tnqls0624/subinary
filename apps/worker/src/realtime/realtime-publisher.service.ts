/**
 * 실시간 무효화 힌트 퍼블리셔 (worker → Redis pub/sub → api SSE).
 *
 * 거래 승격/파싱 완료 직후 가족 채널(`fma:rt:household:{id}`)로 "변경됨" 신호만
 * 발행한다. UI 힌트이므로 유실 허용(at-most-once) — 발행 실패는 잡을 실패시키지
 * 않고 warn 로그 후 흡수한다(클라이언트의 폴링 안전망·복귀 무효화가 커버).
 * 페이로드에 금액·가맹점 등 PII 금지(타입/버전만).
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import {
  createLogger,
  realtimeChannel,
  type RealtimeEvent,
  type RealtimeEventType,
} from '@family/shared';
import { Redis } from 'ioredis';

@Injectable()
export class RealtimePublisherService implements OnModuleDestroy {
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly redis: Redis;

  constructor(configService: ConfigService) {
    const redis = configService.get<AppConfig['redis']>('redis');
    if (!redis) {
      throw new Error('Redis configuration is missing');
    }
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:realtime-publisher', {
      pretty: nodeEnv !== 'production',
    });

    // 발행 전용 클라이언트: 게으른 연결 + 빠른 실패(힌트는 유실 허용이므로
    // 재시도 대기로 잡을 붙들지 않는다). connectTimeout 기본값(10초)은 hang형
    // 장애에서 publish를 수십 초 붙들 수 있어 2초로 명시한다 — 호출부도
    // await 하지 않는다(fire-and-forget).
    this.redis = new Redis({
      host: redis.host,
      port: redis.port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
    this.redis.on('error', (error: Error) => {
      this.logger.warn({ reason: error.message }, 'realtime publish client error');
    });
  }

  /**
   * 가족 채널에 변경 힌트를 발행한다(best-effort, 예외 미전파). 잡 처리 지연을
   * 만들지 않도록 호출부는 await 하지 말 것 — `void publish(...)`.
   */
  async publish(
    householdId: string,
    type: RealtimeEventType = 'transactions.changed',
  ): Promise<void> {
    if (!householdId) return;
    const event: RealtimeEvent = { type, v: 1 };
    try {
      await this.redis.publish(realtimeChannel(householdId), JSON.stringify(event));
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn({ householdId, type, reason }, 'realtime publish failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
