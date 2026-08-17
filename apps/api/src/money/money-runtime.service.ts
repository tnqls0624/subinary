/**
 * 금액 계약 런타임 상태 (API 쪽) — 모드 게시 + 쓰기 펜스 조회.
 *
 * ADR-0027 5단계 전환의 1·3번 단계를 가능하게 하는 배선이다. **아무 금액도 계산하지
 * 않는다.** "지금 어느 모드인가 / 지금 쓰기를 막는가"만 안다.
 *
 * ## 캐시를 두는 이유와 그 수명
 *
 * 펜스는 **요청마다** 판정돼야 하는데 Redis 왕복을 매 요청에 얹으면 정상(펜스 꺼짐)
 * 상태의 지연이 늘어난다. 그래서 짧은 TTL 캐시를 둔다. 캐시가 길면 "껐는데 아직
 * 막힌다"가 되고, 짧으면 Redis 부하가 는다 — {@link FENCE_CACHE_MS}는 사람이 켜고
 * 확인하는 속도(수 초)보다 충분히 짧게 잡았다.
 *
 * ## 실패 시 판정: fail-closed
 *
 * Redis를 못 읽으면 **막는 쪽**을 택한다. 근거:
 *  - 펜스의 존재 이유가 "모드가 갈린 동안 금액 쓰기 0"이다. 열어 두고 틀리면 그 결과는
 *    **가족이 매일 보는 금액이 조용히 틀어지는 것**이고 되돌리기가 비싸다.
 *  - 막아서 틀리면 4개 경로가 503이고 사용자는 잠시 후 다시 하면 된다. 수집(문자)과
 *    모든 읽기는 이 가드를 지나지 않으므로 **영향 범위가 좁다.**
 *  - 애초에 Redis가 죽으면 BullMQ도 죽어 승격이 멈춘다 — 이미 정상 상태가 아니다.
 *
 * 다만 **부팅 직후 첫 조회 실패로 전면 503이 되는 것**은 과하므로, 연속 실패가
 * {@link FENCE_FAILURE_GRACE} 회를 넘을 때부터 닫는다(일시적 blip 흡수).
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import type { AppConfig } from '@family/config';
import {
  MONEY_MODE_HEARTBEAT_MS,
  MONEY_MODE_TTL_SEC,
  moneyModeBootWarning,
  moneyServiceModeKey,
  moneyWriteFenceKey,
  type MoneyContractMode,
} from '@family/shared';

import { MONEY_REDIS_CLIENT } from './money.constants';

/** 펜스 조회 캐시 수명(ms). 켠/끈 뒤 이 시간 안에 반영된다. */
const FENCE_CACHE_MS = 1_000;

/** 연속 조회 실패 몇 번까지 "열림"으로 볼 것인가(일시적 blip 흡수). */
const FENCE_FAILURE_GRACE = 3;

@Injectable()
export class MoneyRuntimeService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MoneyRuntimeService.name);
  private readonly mode: MoneyContractMode;
  private readonly fenceKey: string;
  private readonly modeKey: string;

  private cachedFence = false;
  private cachedAt = 0;
  private consecutiveFailures = 0;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    @Inject(MONEY_REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    const money = configService.get<AppConfig['money']>('money');
    const queue = configService.get<AppConfig['queue']>('queue');
    if (!money || !queue) {
      throw new Error('Money/queue configuration is missing');
    }
    this.mode = money.contractMode;
    this.fenceKey = moneyWriteFenceKey(queue.prefix);
    this.modeKey = moneyServiceModeKey(queue.prefix, 'api');
  }

  /** 이 프로세스가 부팅한 모드(환경변수로 고정 — 런타임에 바뀌지 않는다). */
  get contractMode(): MoneyContractMode {
    return this.mode;
  }

  onApplicationBootstrap(): void {
    // 부팅 모드를 로그에 남긴다 — 갈렸을 때 사후에 확인할 수 있는 기록.
    this.logger.log(`money contract mode=${this.mode} (api)`);
    const warning = moneyModeBootWarning(this.mode);
    if (warning) this.logger.warn(warning);

    // 그리고 Redis에 게시한다. 로그만으로는 두 서비스를 **한 번에 비교할 수 없다**.
    void this.publishMode();
    this.heartbeat = setInterval(
      () => void this.publishMode(),
      MONEY_MODE_HEARTBEAT_MS,
    );
    this.heartbeat.unref();
  }

  onApplicationShutdown(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * 지금 쓰기 펜스가 켜져 있는가.
   *
   * 실패는 삼키되 **연속 실패는 세어 fail-closed로 넘어간다**(위 주석 참조).
   */
  async isWriteFenceOn(): Promise<boolean> {
    const now = Date.now();
    if (now - this.cachedAt < FENCE_CACHE_MS) {
      return this.cachedFence;
    }
    try {
      const raw = await this.redis.exists(this.fenceKey);
      this.consecutiveFailures = 0;
      this.cachedFence = raw === 1;
      this.cachedAt = now;
      return this.cachedFence;
    } catch (error: unknown) {
      this.consecutiveFailures += 1;
      const closed = this.consecutiveFailures > FENCE_FAILURE_GRACE;
      this.logger.warn(
        `money write fence lookup failed (${this.consecutiveFailures}회 연속) — ` +
          `${closed ? '쓰기를 막습니다(fail-closed)' : '열어 둡니다(유예)'}: ` +
          (error instanceof Error ? error.name : 'unknown'),
      );
      // 캐시를 갱신하지 않는다 — 다음 요청이 다시 시도해야 복구가 빠르다.
      return closed;
    }
  }

  /** 남은 펜스 시간(초). 켜져 있지 않거나 알 수 없으면 `null`. */
  async fenceTtlSeconds(): Promise<number | null> {
    try {
      const ttl = await this.redis.ttl(this.fenceKey);
      return ttl >= 0 ? ttl : null;
    } catch {
      return null;
    }
  }

  /** 자기 모드를 TTL과 함께 게시한다. 죽은 서비스의 옛 모드가 남지 않게 한다. */
  private async publishMode(): Promise<void> {
    try {
      await this.redis.set(this.modeKey, this.mode, 'EX', MONEY_MODE_TTL_SEC);
    } catch {
      // 게시 실패는 조용히 넘긴다 — 전환 절차가 "게시가 보이지 않으면 진행하지 않는다"로
      // 설계돼 있어(운영 문서), 실패는 곧 "진행 금지"로 나타난다.
    }
  }
}
