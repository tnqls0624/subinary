/**
 * 금액 계약 shadow 모듈 (ADR-0027 롤아웃 3단계).
 *
 * 거래를 만드는 경로가 두 모듈(`CardSmsModule`의 수동 입력·사람 검토,
 * `TransactionsModule`의 수정·취소 연결)에 흩어져 있어 공용 모듈로 뺀다. 관측 지점이
 * 늘어날 때 이 모듈만 import하면 되고, **관측 코드가 진입점마다 복사되지 않는다** —
 * D-2·D-3이 정확히 복사로 생긴 결함이라 관측만큼은 같은 실수를 피한다.
 */
import { Module } from '@nestjs/common';

import { MoneyShadowService } from './money-shadow.service';

@Module({
  providers: [MoneyShadowService],
  exports: [MoneyShadowService],
})
export class MoneyModule {}
