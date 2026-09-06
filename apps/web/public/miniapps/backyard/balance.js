// @ts-check
/** 뒷마당의 확정 밸런스를 제공한다. 전역 등록 외 부팅 작업은 없다. */
var BackyardBalance = (() => {
  /** 변경할 수 없는 밸런스 상수를 반환한다. */
  function createBalance() {
    return Object.freeze({
      rows: 4, cols: 4, capacity: 16,
      // 설계서 원안 2개에서 고친 값: 첫 수확으로 첫 화분을 구매한다.
      initialPots: 3,
      potPrices: Object.freeze([3, 4, 6, 8, 11, 14, 18, 22, 27, 32, 38, 44, 51, 58, 66, 74]),
      wellPrice: 15, chairPrice: 4,
      growthSec: 10800, boostedGrowthSec: 8100, harvestFruit: 1,
    });
  }
  return Object.freeze({ createBalance });
})();
