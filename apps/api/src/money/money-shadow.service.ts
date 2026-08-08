/**
 * 금액 계약 shadow 관측 — API 쪽 얇은 래퍼 (ADR-0027 롤아웃 3단계).
 *
 * worker 래퍼(`apps/worker/src/promotion/money-shadow.service.ts`)와 **같은 도메인
 * 구현**을 감싼다. 계산이 앱마다 갈리면 ADR-0027이 없애려는 상태가 그대로 남으므로,
 * 두 래퍼 모두 배선과 스위치만 갖는다.
 *
 * ⚠️ 아무것도 바꾸지 않는다. 기존 쓰기 경로가 커밋한 거래를 다시 읽어 새 계약의
 * 계산 결과와 대조하고 `transaction_money_repair_log`에 미적용 manifest로 남긴다.
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

import { DB } from '../database/database.constants';

/** worker 래퍼와 같은 스위치. 자세한 근거는 그쪽 주석 참고. */
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
    const logger = createLogger('api:money-shadow', {
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
   * 관측을 시작하고 **기다리지 않는다**(`void`). HTTP 응답 지연에 관측을 얹지 않기
   * 위함이고, 관찰기가 예외를 전부 삼키므로 처리되지 않은 rejection도 생기지 않는다.
   * 기존 편집 경로의 `realtimePublisher.publish`와 같은 패턴이다.
   */
  observe(transactionId: string | null | undefined, path: MoneyShadowPath): void {
    if (!this.observer || !transactionId) return;
    void this.observer.observe(transactionId, path);
  }

  /** 기록 실패(삼킨 횟수) 카운터. */
  stats(): { recorded: number; swallowed: number } {
    return this.sink?.stats() ?? { recorded: 0, swallowed: 0 };
  }
}
