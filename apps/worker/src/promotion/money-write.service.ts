/**
 * 금액 쓰기 enforce 배선 — worker 쪽 얇은 래퍼 (ADR-0027 롤아웃 5단계).
 *
 * API 래퍼(`apps/api/src/money/money-write.service.ts`)와 **같은 도메인 구현**을 감싼다.
 * 계산이 앱마다 갈리면 ADR-0027이 없애려는 상태가 그대로 남으므로, 두 래퍼 모두
 * 배선과 스위치만 갖는다 — `MoneyShadowService`가 3단계에서 그랬던 것과 같다.
 *
 * ⚠️ ADR 롤아웃 5단계는 "API와 worker의 enforce 플래그를 **모두** v2로 바꾼 뒤 다시
 * 연다"고 요구한다. 한쪽만 켜진 동안 사용자 쓰기가 흐르면 두 계약의 거래가 섞이므로,
 * 그 구간은 쓰기 펜스와 승격 일시정지가 막는다(`scripts/money-fence.mjs`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@family/database';
import {
  DrizzleFxSnapshotStore,
  TransactionMoneyService,
} from '@family/transaction-domain';

import { DB } from '../database/database.module';
import { MoneyRuntimeService } from './money-runtime.service';

@Injectable()
export class MoneyWriteService {
  private readonly service: TransactionMoneyService;

  constructor(
    @Inject(DB) db: Db,
    private readonly runtime: MoneyRuntimeService,
  ) {
    this.service = new TransactionMoneyService(db, new DrizzleFxSnapshotStore(db));
  }

  /** 금액 쓰기를 새 계약이 소유하는가. 승격 경로는 이 값으로만 갈라진다. */
  get enforced(): boolean {
    return this.runtime.contractMode === 'v2';
  }

  /** 도메인 명령. 호출부는 `enforced`가 true일 때만 부른다. */
  get commands(): TransactionMoneyService {
    return this.service;
  }
}
