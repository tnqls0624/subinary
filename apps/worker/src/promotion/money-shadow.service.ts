/**
 * 금액 계약 shadow 관측 — worker 쪽 얇은 래퍼 (ADR-0027 롤아웃 3단계).
 *
 * 계산과 기록은 전부 `@family/transaction-domain`이 한다. 여기 있는 것은 Nest DI에
 * 붙이는 배선과 **켜고 끄는 스위치**뿐이다. 도메인 로직을 앱에 두면 API 쪽 래퍼와
 * 갈리고, 그게 ADR-0027이 없애려는 상태다.
 *
 * ⚠️ 이 서비스는 **아무것도 바꾸지 않는다.** 기존 승격이 만든 거래를 커밋 뒤에 다시
 * 읽어 "새 계약이라면 얼마였을까"를 계산하고 `transaction_money_repair_log`에
 * 미적용 manifest로 남길 뿐이다. 예외는 도메인 관찰기가 전부 삼킨다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { type Db } from '@family/database';
import { createLogger } from '@family/shared';
import {
  DrizzleFxSnapshotStore,
  TransactionMoneyShadowObserver,
  TransactionMoneyShadowSink,
  type MoneyShadowPath,
} from '@family/transaction-domain';

import { DB } from '../database/database.module';

/**
 * `MONEY_SHADOW_MODE=off`로 끌 수 있다. 기본은 켜짐 — 이번 라운드의 목적이 관측
 * 데이터를 모으는 것이고, 전환 조건("7일 이상·50건 이상")은 켜져 있어야 채워진다.
 *
 * `@family/config`의 zod 스키마가 아니라 `process.env`를 직접 읽는 이유: 이번 라운드는
 * `packages/config`가 다른 워커의 범위다. 설정 스키마로 옮기는 것은 후속 작업이며,
 * 그때까지 이 한 곳에서만 읽는다.
 */
const SHADOW_DISABLED = process.env.MONEY_SHADOW_MODE === 'off';

@Injectable()
export class MoneyShadowService {
  private readonly observer: TransactionMoneyShadowObserver | null;
  private readonly sink: TransactionMoneyShadowSink | null;

  constructor(@Inject(DB) db: Db, configService: ConfigService) {
    if (SHADOW_DISABLED) {
      this.observer = null;
      this.sink = null;
      return;
    }
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    const logger = createLogger('worker:money-shadow', {
      pretty: nodeEnv !== 'production',
    });
    this.sink = new TransactionMoneyShadowSink(db, logger);
    this.observer = new TransactionMoneyShadowObserver(
      db,
      new DrizzleFxSnapshotStore(db),
      this.sink,
    );
  }

  /**
   * 거래 하나를 관측한다. 승격 잡 안에서 `await`하는 이유: 잡이 끝난 뒤 fire-and-forget으로
   * 두면 워커 재시작 때 관측이 조용히 사라지고, 그 유실은 "delta 없음" 쪽으로 편향된다.
   * 몇 건의 읽기와 한 건의 삽입이라 승격 지연에 유의미한 영향이 없다.
   */
  async observe(transactionId: string | null, path: MoneyShadowPath): Promise<void> {
    if (!this.observer || !transactionId) return;
    await this.observer.observe(transactionId, path);
  }

  /** 기록 실패(삼킨 횟수) 카운터. 운영 점검에서 0인지 확인한다. */
  stats(): { recorded: number; swallowed: number } {
    return this.sink?.stats() ?? { recorded: 0, swallowed: 0 };
  }
}
