/* ---------------------------------------------------------------------------
 * 이번 달 페이스 — "지난달 같은 날짜까지"와 나란히 놓는다
 *
 * ## 무엇을 하지 않는가
 *
 * 판정하지 않는다. "잘하고 있어요"·"평소보다 많아요" 같은 문구를 만들지 않는다.
 * 두 숫자는 **둘 다 관측된 사실**이고, 그것을 나란히 놓는 것까지가 이 화면의 일이다.
 * 해석은 사람이 한다.
 *
 * 이 선을 지키는 이유: '평소'를 정의하는 순간 그 기준을 지어내야 하고, 지어낸 기준은
 * 화면에 근거를 함께 띄울 수 없다. 이 저장소가 반복해서 지켜온 규칙이다.
 *
 * ## 왜 "같은 날짜까지"인가
 *
 * 9월 5일에 9월 전체(229,120원)와 8월 전체(2,835,251원)를 비교하면 항상 이긴다 —
 * 달이 아직 안 끝났기 때문이다. 그 비교는 아무것도 말하지 않는다. 같은 날짜까지로
 * 자르면 실측이 이렇게 된다:
 *
 *   9월 1~5일  229,120원 (17건)
 *   8월 1~5일  412,089원 (28건)
 *
 * ## 말일 처리
 *
 * 3월 31일의 "지난달 같은 날짜"는 2월 31일이라 존재하지 않는다. 그럴 때는 **그 달의
 * 마지막 날**로 자른다(2월 28/29일). 대안은 비교를 포기하는 것인데, 31일에만 화면이
 * 비는 것은 사용자에게 고장으로 보인다.
 *
 * 이 처리가 만드는 왜곡은 정직하게 표기해야 한다 — 31일 비교는 "28일까지"와 "31일까지"를
 * 견주게 되므로 지난달 쪽이 짧다. 화면이 그 사실을 함께 보여준다({@link PaceRange.truncated}).
 * ------------------------------------------------------------------------- */

/** 한 구간(월초 ~ 기준일 끝)의 경계. ISO 문자열은 KST 오프셋을 명시한다. */
export interface PaceRange {
  /** 화면 표기용 `YYYY-MM`. */
  month: string;
  /** 이 구간이 포함하는 마지막 날(1~31). */
  throughDay: number;
  /** `[from, to)` — `to`는 기준일 **다음 날 0시**(경계 포함을 피한다). */
  from: string;
  to: string;
  /**
   * 요청한 날짜가 그 달에 없어 마지막 날로 줄었는가(3/31 → 2/28).
   * 화면은 이 경우 비교 기간이 다르다는 사실을 표기해야 한다.
   */
  truncated: boolean;
}

/** KST 고정 오프셋. 이 앱의 모든 날짜 경계가 쓰는 값. */
const KST = '+09:00';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 그 달의 마지막 날(1~31). */
export function lastDayOfMonth(year: number, month1to12: number): number {
  // Date의 0일은 전월 말일이다.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * `year-month`의 1일부터 `day`까지를 담는 구간을 만든다.
 *
 * `day`가 그 달에 없으면 마지막 날로 줄이고 `truncated: true`를 세운다.
 */
export function paceRange(
  year: number,
  month1to12: number,
  day: number,
): PaceRange {
  const last = lastDayOfMonth(year, month1to12);
  const throughDay = Math.min(day, last);
  const month = `${year}-${pad(month1to12)}`;
  const from = `${month}-01T00:00:00${KST}`;
  // `to`는 기준일 다음 0시다. 같은 날 23:59:59로 잡으면 그 1초 사이의 거래가 빠진다.
  const endDate = new Date(Date.UTC(year, month1to12 - 1, throughDay + 1));
  const to =
    `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-` +
    `${pad(endDate.getUTCDate())}T00:00:00${KST}`;
  return { month, throughDay, from, to, truncated: throughDay !== day };
}

/**
 * 오늘(KST)을 기준으로 이번 달과 지난달의 비교 구간을 만든다.
 *
 * `now`를 주입받는 이유: 자정 근처 동작과 말일 처리를 테스트로 고정해야 하는데,
 * 시스템 시계에 의존하면 그 테스트가 하루에 한 번만 의미를 갖는다.
 */
export function currentPacePair(now: Date): {
  current: PaceRange;
  previous: PaceRange;
} {
  // KST 기준의 연·월·일을 얻는다. 오프셋을 더한 뒤 UTC 필드를 읽는 방식이
  // 로케일·타임존 설정과 무관해 브라우저마다 같은 답을 준다.
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1;
  const day = kst.getUTCDate();

  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  return {
    current: paceRange(year, month, day),
    previous: paceRange(prevYear, prevMonth, day),
  };
}

/** 두 합계의 차이. 어느 쪽이 크다는 판정은 하지 않고 부호만 준다. */
export function paceDelta(
  currentNet: number,
  previousNet: number,
): { diff: number; ratio: number | null } {
  const diff = currentNet - previousNet;
  // 지난달이 0이면 비율을 만들 수 없다. 0으로 나눈 값을 억지로 채우지 않는다 —
  // "무한% 증가"는 사실이 아니라 계산 사고다.
  const ratio = previousNet === 0 ? null : diff / previousNet;
  return { diff, ratio };
}
