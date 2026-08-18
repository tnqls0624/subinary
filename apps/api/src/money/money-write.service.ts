/**
 * 금액 쓰기 enforce 배선 — API 쪽 얇은 래퍼 (ADR-0027 롤아웃 5단계).
 *
 * `MoneyShadowService`가 3단계의 "대조만 한다"였다면, 이 서비스는 5단계의 "실제로
 * 쓴다"이다. 감싸는 것은 같은 도메인 구현(`TransactionMoneyService`)이고, 여기에는
 * **배선과 스위치만** 둔다 — 계산이 앱마다 갈리면 ADR-0027이 없애려는 상태가 그대로
 * 남는다.
 *
 * ## 왜 각 서비스가 직접 `TransactionMoneyService`를 만들지 않는가
 *
 * 금액 쓰기 경로는 두 모듈(`CardSmsModule`·`TransactionsModule`)에 흩어져 있고 곧
 * worker에도 같은 배선이 필요하다. 진입점마다 인스턴스를 만들면 fx resolver·모드
 * 판정·거절 매핑이 진입점 수만큼 복사된다. D-2·D-3이 정확히 그 복사로 생긴 결함이므로,
 * **새 경로가 추가돼도 이 모듈만 import하면 되게** 한다.
 *
 * ## 모드 스위치
 *
 * `enforced`가 false면 호출부는 기존 경로를 그대로 쓴다. ADR 롤아웃 5단계가 "API와
 * worker의 enforce 플래그를 **모두** v2로 바꾼 뒤 다시 연다"고 요구하므로, 한쪽만
 * 켜진 중간 상태에서 사용자 쓰기가 흐르면 안 된다 — 그 보장은 쓰기 펜스
 * (`MoneyWriteFenceGuard`)와 짝을 이룬다.
 */
import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@family/database';
import {
  DrizzleFxSnapshotStore,
  TransactionMoneyService,
} from '@family/transaction-domain';

import { DB } from '../database/database.constants';
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

  /**
   * 금액 쓰기를 새 계약이 소유하는가.
   *
   * 호출부는 이 값으로만 갈라진다. `contractMode`를 직접 읽지 않는 이유는 하나다 —
   * enforce 판정이 여섯 군데에서 각자 정의되면 그중 하나가 뒤처졌을 때 두 계약이
   * 동시에 쓰는 상태가 되고, 그것이 이 전환에서 가장 피해야 하는 상태다.
   */
  get enforced(): boolean {
    return this.runtime.contractMode === 'v2';
  }

  /** 도메인 명령. 호출부는 `enforced`가 true일 때만 부른다. */
  get commands(): TransactionMoneyService {
    return this.service;
  }
}
