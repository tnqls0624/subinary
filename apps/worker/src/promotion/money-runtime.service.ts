/**
 * 금액 계약 런타임 상태 (worker 쪽) — 모드 게시 + **승격 소비 일시정지**.
 *
 * ADR-0027 5단계: *"짧게 worker 승격 소비를 일시 정지하고…"*
 *
 * ## ⚠️ 승격 경로는 **둘**이다 — 큐만 멈추면 새는 구멍이 남는다
 *
 * `TransactionPromotionService.promote()`를 부르는 곳을 전수 조사한 결과:
 *
 *  1. `card-sms-parse` 큐 프로세서 (`processors/card-sms-parse.processor.ts`)
 *  2. **알림 스케줄러의 정체 자동복구** (`notifications/notification-scheduler.service.ts`의
 *     `runPromotionStallCheck()`) — 이건 **큐가 아니라 1분 `setInterval` 타이머**다.
 *
 * 그래서 BullMQ 큐만 pause하면 (2)가 그대로 돌아 펜스 중에도 금액이 쓰인다. 파싱은 끝났는데
 * 승격이 안 된 이벤트가 하나라도 있으면 정확히 그 창에서 재승격이 일어난다. 이 서비스는
 * **두 경로를 같은 플래그 하나로** 막는다.
 *
 * (`card_transactions`의 금액 소유 컬럼(`MONEY_PROTECTED_COLUMNS`)을 쓰는 worker 지점은
 * `transaction-promotion.service.ts` 하나뿐이다. `source-tombstone`은 `excludedAt`·가맹점명을,
 * `category-suggest`는 `categoryId`를 쓰는데 둘 다 금액 소유 컬럼이 아니라 대상이 아니다.)
 *
 * ## 왜 컨테이너 stop이 아닌가
 *
 * 컨테이너를 내리면 아웃박스 디스패처·알림 스케줄러·nonce 정리까지 함께 멈춘다. 특히
 * 아웃박스가 멈추면 **수집된 카드 문자가 큐에 도달조차 못 한다** — 유실은 아니지만
 * 전환이 길어질수록 밀린 양이 커진다. 소비만 멈추는 것이 정확한 조치다.
 *
 * ## 잡은 유실되지 않는다
 *
 * BullMQ `Worker.pause()`는 **새 잡을 가져오지 않을 뿐** 큐(Redis)에서 지우지 않는다.
 * pause 중 들어온 잡은 `waiting`에 쌓이고 resume 뒤 그대로 소비된다. 이 성질은 격리
 * 스택 리허설에서 실측한다(운영 문서 §리허설).
 */
import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import {
  MONEY_MODE_HEARTBEAT_MS,
  MONEY_MODE_TTL_SEC,
  createLogger,
  moneyModeBootWarning,
  moneyPromotionPauseKey,
  moneyServiceModeKey,
  type MoneyContractMode,
} from '@family/shared';
import type { Redis } from 'ioredis';

import { MONEY_REDIS_CLIENT } from './money.constants';

/** 일시정지 플래그를 다시 보는 주기(ms). 전환은 사람이 지켜보는 작업이라 2초면 충분하다. */
const PAUSE_POLL_MS = 2_000;

/** pause/resume을 실제로 수행할 대상(BullMQ Worker를 가진 프로세서). */
export interface PausableConsumer {
  readonly name: string;
  pause(): Promise<void>;
  resume(): void;
}

@Injectable()
export class MoneyRuntimeService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = createLogger('worker:money-runtime');
  private readonly mode: MoneyContractMode;
  private readonly pauseKey: string;
  private readonly modeKey: string;

  private readonly consumers: PausableConsumer[] = [];
  /** 마지막으로 **적용된** 상태. 플래그와 다르면 그 차이만큼만 행동한다. */
  private applied = false;
  private timer: NodeJS.Timeout | null = null;
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
    this.pauseKey = moneyPromotionPauseKey(queue.prefix);
    this.modeKey = moneyServiceModeKey(queue.prefix, 'worker');
  }

  get contractMode(): MoneyContractMode {
    return this.mode;
  }

  /**
   * 지금 승격이 멈춰 있는가. **큐 밖 경로**(알림 스케줄러의 정체 복구)가 이 값을 물어본다.
   *
   * 메모리 플래그를 쓰는 이유: 스케줄러 tick마다 Redis를 왕복할 필요가 없고, 폴링 주기
   * ({@link PAUSE_POLL_MS})가 충분히 짧아 지연이 무의미하다. 그리고 Redis가 죽었을 때
   * 마지막으로 **알려진** 상태를 유지하는 편이 낫다 — 펜스를 켠 채 Redis가 흔들렸다고
   * 승격이 되살아나면 안 된다.
   */
  get isPromotionPaused(): boolean {
    return this.applied;
  }

  /** 프로세서가 자기 자신을 등록한다(순환 의존을 피하려 역방향 배선). */
  register(consumer: PausableConsumer): void {
    this.consumers.push(consumer);
    // 이미 pause 상태에서 늦게 등록되면 즉시 맞춰 준다.
    if (this.applied) void consumer.pause();
  }

  onApplicationBootstrap(): void {
    this.logger.info({ mode: this.mode, service: 'worker' }, 'money contract mode');
    const warning = moneyModeBootWarning(this.mode);
    if (warning) this.logger.warn({ mode: this.mode }, warning);

    void this.publishMode();
    this.heartbeat = setInterval(
      () => void this.publishMode(),
      MONEY_MODE_HEARTBEAT_MS,
    );
    this.heartbeat.unref();

    void this.syncPauseState();
    this.timer = setInterval(() => void this.syncPauseState(), PAUSE_POLL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    for (const timer of [this.timer, this.heartbeat]) {
      if (timer !== null) clearInterval(timer);
    }
    this.timer = null;
    this.heartbeat = null;
  }

  /** 플래그를 읽어 등록된 소비자를 pause/resume한다. 실패하면 **현 상태를 유지**한다. */
  private async syncPauseState(): Promise<void> {
    let desired: boolean;
    try {
      desired = (await this.redis.exists(this.pauseKey)) === 1;
    } catch {
      // Redis를 못 읽으면 아무것도 바꾸지 않는다. pause 중이었다면 pause로 남는 것이
      // 안전하고, 아니었다면 다음 폴링이 다시 시도한다.
      return;
    }
    if (desired === this.applied) return;

    if (desired) {
      // `pause()`는 진행 중인 잡이 끝날 때까지 기다린다 — 절반만 쓰인 승격을 만들지 않는다.
      await Promise.all(this.consumers.map((consumer) => consumer.pause()));
      this.applied = true;
      this.logger.warn(
        { consumers: this.consumers.map((c) => c.name) },
        'promotion consumption paused (money write fence)',
      );
    } else {
      for (const consumer of this.consumers) consumer.resume();
      this.applied = false;
      this.logger.warn(
        { consumers: this.consumers.map((c) => c.name) },
        'promotion consumption resumed',
      );
    }
  }

  private async publishMode(): Promise<void> {
    try {
      await this.redis.set(this.modeKey, this.mode, 'EX', MONEY_MODE_TTL_SEC);
    } catch {
      // 전환 절차가 "두 모드가 보이지 않으면 진행하지 않는다"이므로 실패는 곧 진행 금지다.
    }
  }
}
