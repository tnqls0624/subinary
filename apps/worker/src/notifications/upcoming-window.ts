/**
 * 정기 결제 예고의 창 계산과 사용자별 묶기 — **순수·결정적** (금액 레이어 S3).
 *
 * ## 왜 분리했는가
 *
 * 이 두 계산이 S3의 DoD를 결정한다. 창이 하루 어긋나면 "내일 나가요"가 거짓이 되고,
 * 묶기에서 금액 판정이 틀리면 "0원 나가요"라고 말한다. 둘 다 DB 없이 검증할 수 있고,
 * 검증해야 한다 — 스케줄러 안에 두면 테스트가 컨테이너를 띄워야 한다.
 *
 * ## KST 날짜 경계 (여기서 실제로 사고가 났다)
 *
 * "내일"은 사용자의 달력 날짜다. UTC로 자르면 KST 09시 이전 결제가 전날로 밀려 예고가
 * 하루 어긋난다. 매일 9시 반복 알림 루프가 그 경계에서 생겼다. 그래서 KST
 * 00:00:00.000 ~ 23:59:59.999를 UTC instant로 환산해 비교한다.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** v2 미만이거나 원화가 아니면 금액을 예고하지 않는다(기획 D2). */
const FORECASTABLE_CONTRACT_VERSION = 2;
const FORECAST_CURRENCY = 'KRW';

export interface UpcomingWindow {
  /** 내일 KST 00:00:00.000의 UTC instant. */
  readonly start: Date;
  /** 내일 KST 23:59:59.999의 UTC instant. */
  readonly end: Date;
}

/**
 * `seoul`(= UTC + 9h로 밀어 둔 Date)이 가리키는 날의 **다음 날** KST 하루 창.
 *
 * 인자가 이미 밀린 Date인 이유: 스케줄러가 `new Date(Date.now() + KST_OFFSET_MS)`로
 * 시각 판정(`getUTCHours()`)을 하고 있어 같은 값을 그대로 넘겨야 판정과 창이 어긋나지
 * 않는다.
 */
export function tomorrowKstWindow(seoul: Date): UpcomingWindow {
  const y = seoul.getUTCFullYear();
  const mi = seoul.getUTCMonth();
  const d = seoul.getUTCDate();
  return {
    start: new Date(Date.UTC(y, mi, d + 1) - KST_OFFSET_MS),
    end: new Date(Date.UTC(y, mi, d + 2) - KST_OFFSET_MS - 1),
  };
}

export interface UpcomingSeriesRow {
  readonly userId: string;
  readonly householdId: string;
  readonly amountMedian: number;
  readonly currency: string;
  readonly moneyContractVersion: number;
}

export interface UpcomingUserBucket {
  readonly householdId: string;
  /** 내일 예정된 확정 series 건수(금액을 못 세는 것 포함). */
  readonly count: number;
  /**
   * 예고 가능한 것들의 합(KRW minor units). **`null`은 "얼마인지 모른다"**이고
   * 0과 다르다 — 0원을 말하면 "0원 나간다"는 거짓이 된다.
   */
  readonly totalAmount: number | null;
  /** 금액을 세지 못해 합계에서 빠진 건수. */
  readonly excludedCount: number;
}

/**
 * 사용자별로 묶는다 (기획 D5 — 구독 8개면 개별 알림은 폭탄이다).
 *
 * 수신자는 **series 소유자 1인**이다. 거절 알림처럼 전원에게 보내지 않는다 — 예고는
 * 조치를 요구하지 않는 정보이고, 남의 구독 예고가 매일 오면 그건 소음이다.
 */
export function groupUpcomingByUser(
  rows: readonly UpcomingSeriesRow[],
): Map<string, UpcomingUserBucket> {
  const acc = new Map<
    string,
    { householdId: string; count: number; total: number; forecastable: number }
  >();

  for (const row of rows) {
    const bucket = acc.get(row.userId) ?? {
      householdId: row.householdId,
      count: 0,
      total: 0,
      forecastable: 0,
    };
    bucket.count += 1;
    if (
      row.moneyContractVersion >= FORECASTABLE_CONTRACT_VERSION &&
      row.currency === FORECAST_CURRENCY
    ) {
      bucket.total += row.amountMedian;
      bucket.forecastable += 1;
    }
    acc.set(row.userId, bucket);
  }

  const out = new Map<string, UpcomingUserBucket>();
  for (const [userId, b] of acc) {
    out.set(userId, {
      householdId: b.householdId,
      count: b.count,
      // 하나도 못 세면 null. 이 구분이 문구를 가른다.
      totalAmount: b.forecastable > 0 ? b.total : null,
      excludedCount: b.count - b.forecastable,
    });
  }
  return out;
}
