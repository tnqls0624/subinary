/**
 * 실시간 브릿지 (Redis pub/sub → 가족별 RxJS Subject 팬아웃).
 *
 * 워커가 발행한 `fma:rt:household:{id}` 힌트를 psubscribe 1커넥션으로 받아,
 * household별 Subject로 팬아웃한다. SSE 컨트롤러가 `streamFor(householdId)`를
 * 구독해 연결된 클라이언트에 중계한다. 페이로드는 무효화 힌트뿐(PII 없음)이라
 * 유실 허용 — Redis 재연결 구간의 이벤트는 클라이언트 안전망(폴링·복귀 무효화)이
 * 흡수한다.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import {
  householdIdFromChannel,
  REALTIME_CHANNEL_PATTERN,
  type RealtimeEvent,
} from '@family/shared';
import { Redis } from 'ioredis';
import { Subject, type Observable } from 'rxjs';

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly subscriber: Redis;
  /** householdId → 팬아웃 Subject. 구독자 0이어도 유지(가족 수 규모라 무해). */
  private readonly subjects = new Map<string, Subject<RealtimeEvent>>();

  constructor(configService: ConfigService) {
    const redis = configService.get<AppConfig['redis']>('redis');
    if (!redis) {
      throw new Error('Redis configuration is missing');
    }
    // 구독 전용 클라이언트(ioredis는 subscribe 모드 커넥션에서 일반 명령 불가).
    this.subscriber = new Redis({
      host: redis.host,
      port: redis.port,
      lazyConnect: true,
    });
    this.subscriber.on('error', (error: Error) => {
      this.logger.warn(`realtime subscriber error: ${error.message}`);
    });
    // 리스너는 연결 상태와 무관하게 항상 등록해 두고, psubscribe는 'ready'마다
    // 다시 발행한다 — 부팅 시 Redis가 불통이어도 ioredis 기본 retryStrategy가
    // 백그라운드 재연결을 계속하므로, 최초 성공/모든 재연결 시점에 구독이 복원된다.
    // (ioredis의 구독 자동복원은 "이전에 구독했던" 채널에만 동작하므로, 최초
    // psubscribe가 실패한 채 방치하면 영구 불능이 된다 — 명시 재발행이 안전.)
    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      this.dispatch(channel, message);
    });
    this.subscriber.on('ready', () => {
      void this.subscriber
        .psubscribe(REALTIME_CHANNEL_PATTERN)
        .catch((error: Error) => {
          this.logger.warn(`realtime psubscribe failed: ${error.message}`);
        });
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.subscriber.connect();
    } catch (error) {
      // Redis 불통이어도 API 부팅은 막지 않는다 — retryStrategy가 재연결을
      // 계속하고, 성공 시 'ready' 핸들러가 psubscribe를 복원한다(위 참조).
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `realtime redis connect failed (retrying in background): ${reason}`,
      );
    }
  }

  /** 채널 메시지를 해당 가족 Subject로 팬아웃한다. 형식 오류는 조용히 버린다. */
  private dispatch(channel: string, message: string): void {
    const householdId = householdIdFromChannel(channel);
    if (!householdId) return;
    const subject = this.subjects.get(householdId);
    if (!subject) return;

    try {
      const event = JSON.parse(message) as RealtimeEvent;
      if (event && typeof event.type === 'string') {
        subject.next(event);
      }
    } catch {
      // 무효 페이로드는 무시(힌트 채널 — 치명적이지 않음).
    }
  }

  /** 가족 채널 스트림. 컨트롤러가 SSE로 중계한다. */
  streamFor(householdId: string): Observable<RealtimeEvent> {
    let subject = this.subjects.get(householdId);
    if (!subject) {
      subject = new Subject<RealtimeEvent>();
      this.subjects.set(householdId, subject);
    }
    return subject.asObservable();
  }

  async onModuleDestroy(): Promise<void> {
    for (const subject of this.subjects.values()) {
      subject.complete();
    }
    try {
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
  }
}
