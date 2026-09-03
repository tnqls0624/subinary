/**
 * 예정 정기 지출 합계 — **순수·결정적** (금액 레이어 S1).
 *
 * ## 이 파일이 지키는 것
 *
 * 합계는 쉽게 거짓말이 된다. 빠진 항목을 세지 않으면 "이번 달 34,200원 나가요"가
 * 실제로는 "우리가 셀 수 있었던 것만 34,200원"이 되고, 사용자는 그 차이를 알 방법이
 * 없다. 그래서 이 함수는 **합계와 함께 빠진 건수를 돌려주고**, 사유를 둘로 나눈다.
 *
 * | 사유 | 뜻 | 사용자가 할 수 있는 것 |
 * |---|---|---|
 * | `excludedCount` | 근거에 v1 거래가 섞여 금액을 예고할 수 없다(기획 D2) | 기다리면 풀린다(수리·재계산) |
 * | `otherCurrencyCount` | 원화가 아니라 합산하지 않았다 | 없다 — 환산은 금액 계약의 일이다 |
 *
 * 둘을 한 숫자로 합치면 안 된다. 앞은 일시적이고 뒤는 영구적이라, 화면이 사용자에게
 * 다른 말을 해야 한다.
 *
 * DB·시계·난수에 손대지 않는다. 그래야 "이 입력이면 이 합계"를 테스트가 못 박을 수 있다.
 */
import { MONEY_CONTRACT_VERSION_V2 } from '@family/database';

/** 합계 판정에 필요한 최소 모양. 전체 행을 요구하지 않는다(조회 컬럼이 바뀌어도 안 깨진다). */
export interface UpcomingSummaryInput {
  readonly amountMedian: number;
  readonly currency: string;
  readonly moneyContractVersion: number;
}

export interface UpcomingSummary {
  /** 예고 가능한 것들의 합(minor units, `totalCurrency` 기준). */
  readonly totalAmount: number;
  readonly forecastableCount: number;
  readonly excludedCount: number;
  readonly otherCurrencyCount: number;
}

/**
 * 이 series의 금액을 예고해도 되는가.
 *
 * `moneyContractVersion`은 **근거 거래 중 최솟값**이다(ADR-0027). 하나라도 v1이 섞이면
 * series 전체가 v1 신뢰도이므로 금액을 말하지 않는다 — 기획 D2가 "날짜만 말하거나
 * 확인 필요로"라고 정한 이유다.
 */
export function isAmountForecastable(
  row: UpcomingSummaryInput,
  totalCurrency: string,
): boolean {
  return (
    row.moneyContractVersion >= MONEY_CONTRACT_VERSION_V2 &&
    row.currency === totalCurrency
  );
}

/**
 * 예정 목록의 합계와 **빠진 건수**를 함께 낸다.
 *
 * 통화 판정이 계약 버전 판정보다 먼저인 이유: 외화이면서 v1인 행을 두 번 세지 않기
 * 위해서다. 한 행은 한 사유에만 들어간다 — 그러지 않으면 `forecastableCount +
 * excludedCount + otherCurrencyCount`가 전체 건수와 어긋나고, 화면이 "나머지"를
 * 계산할 수 없다.
 */
export function summarizeUpcoming(
  rows: readonly UpcomingSummaryInput[],
  totalCurrency: string,
): UpcomingSummary {
  let totalAmount = 0;
  let forecastableCount = 0;
  let excludedCount = 0;
  let otherCurrencyCount = 0;

  for (const row of rows) {
    if (row.currency !== totalCurrency) {
      otherCurrencyCount += 1;
      continue;
    }
    if (row.moneyContractVersion < MONEY_CONTRACT_VERSION_V2) {
      excludedCount += 1;
      continue;
    }
    totalAmount += row.amountMedian;
    forecastableCount += 1;
  }

  return { totalAmount, forecastableCount, excludedCount, otherCurrencyCount };
}
