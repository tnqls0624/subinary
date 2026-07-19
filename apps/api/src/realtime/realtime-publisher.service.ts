/**
 * API 측 실시간 힌트 퍼블리셔 — 사용자 편집(거래 수정/제외/취소연결, 카테고리
 * CRUD)을 가족의 다른 열린 화면에 전파한다. 워커 퍼블리셔와 동일 채널 규약.
 *
 * best-effort: 발행 실패는 뮤테이션을 실패시키지 않는다(warn 후 흡수 —
 * 클라이언트 staleTime/포커스 리페치가 안전망). 페이로드 PII 금지.
 * connectTimeout을 짧게 잡아(2초) Redis 부분 장애가 응답 지연으로 전이되는
 * 것을 막고, 호출부는 await 하지 않는다(fire-and-forget).
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import {
  realtimeChannel,
  type RealtimeEvent,
  type RealtimeEventType,
} from '@family/shared';
import { Redis } from 'ioredis';

@Injectable()
export class RealtimePublisherService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimePublisherService.name);
  private readonly redis: Redis;

  constructor(configService: ConfigService) {
    const redis = configService.get<AppConfig['redis']>('redis');
    if (!redis) {
      throw new Error('Redis configuration is missing');
    }
    this.redis = new Redis({
      host: redis.host,
      port: redis.port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`realtime publish client error: ${error.message}`);
    });
  }

  /**
   * 가족 채널에 변경 힌트를 발행한다. 반환 Promise를 await 하지 말 것 —
   * 내부에서 실패를 흡수하므로 `void publish(...)`로 흘려보내면 된다.
   */
  async publish(
    householdId: string,
    type: RealtimeEventType = 'transactions.changed',
  ): Promise<void> {
    if (!householdId) return;
    const event: RealtimeEvent = { type, v: 1 };
    try {
      await this.redis.publish(
        realtimeChannel(householdId),
        JSON.stringify(event),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `realtime publish failed householdId=${householdId} type=${type}: ${reason}`,
      );
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
