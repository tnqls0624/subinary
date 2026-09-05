/* ---------------------------------------------------------------------------
 * 주간 리듬 — 언제 쓰는지를 요일로 본다
 *
 * ## 금액이 아니라 횟수를 센다
 *
 * 두 가지 이유가 있다.
 *
 * 1. **합계 정의와 충돌하지 않는다.** 지출 합계의 정의(취소 상계·제외 거래·공개범위)는
 *    ADR-0026이 하나로 정했고 `GET /v1/transactions/summary`가 소유한다. 이 화면이
 *    거래 목록을 받아 금액을 다시 더하면 같은 달의 숫자가 화면마다 갈린다. 횟수는
 *    그 계약 밖이라 안전하다.
 * 2. **리듬은 원래 횟수의 이야기다.** "금요일에 많이 쓴다"보다 "금요일에 자주 산다"가
 *    요일 패턴이 실제로 말하는 것이다. 큰 결제 한 건이 요일 하나를 왜곡하지도 않는다.
 *
 * ## 판정하지 않는다
 *
 * "금요일에 조심하세요" 같은 문구를 만들지 않는다. 요일별 횟수는 관측된 사실이고,
 * 많은 요일이 나쁜 요일이라는 판단은 이 화면의 것이 아니다 — 장을 몰아서 보는 사람의
 * 토요일과 매일 편의점에 가는 사람의 평일은 같은 숫자라도 다른 이야기다.
 *
 * 실측(2026-09-05, 승인 거래 전체): 금 49 · 목 46 · 토 40 · 일 37 · 수 36 · 화 34 · 월 21.
 * ------------------------------------------------------------------------- */

/** 요일 인덱스(0=일요일)와 한국어 라벨. 화면과 계산이 같은 배열을 쓴다. */
export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 이 계산에 필요한 거래의 최소 형태. */
export interface RhythmTransaction {
  /** 승인 시각(ISO). 없으면 이 화면이 셀 수 없다 — 언제인지 모르는 결제다. */
  approvedAt: string | null;
  transactionType: 'approval' | 'cancellation';
  merchantNormalized: string | null;
}

/** 요일 한 칸. */
export interface WeekdayBucket {
  /** 0=일 … 6=토. */
  weekday: number;
  label: string;
  count: number;
}

/**
 * ISO 시각의 **KST 요일**(0=일). 브라우저 타임존과 무관하게 같은 답을 준다.
 *
 * `new Date(iso).getDay()`를 쓰지 않는 이유: 그것은 실행 기기의 타임존을 따른다.
 * 해외에서 앱을 열면 같은 결제가 다른 요일로 세어지고, 그 어긋남은 화면에 드러나지
 * 않은 채 숫자만 바뀐다.
 */
export function kstWeekday(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return -1;
  return new Date(t + 9 * 60 * 60 * 1000).getUTCDay();
}

/**
 * 요일별 결제 횟수. 일요일부터 토요일 순으로 **항상 7칸**을 돌려준다.
 *
 * 빈 요일을 빼지 않는 이유: 막대 하나가 사라지면 그 요일에 결제가 없었다는 사실이
 * 화면에서 지워진다. 0도 관측 결과다.
 *
 * 취소 행은 세지 않는다 — "그날 결제했다"를 세는 것이 목적이고, 취소는 별도 행으로
 * 오므로 함께 세면 같은 사건이 두 번 잡힌다.
 */
export function weekdayBuckets(
  rows: readonly RhythmTransaction[],
): WeekdayBucket[] {
  const counts = new Array(7).fill(0) as number[];
  for (const r of rows) {
    if (r.transactionType !== 'approval') continue;
    if (!r.approvedAt) continue;
    const w = kstWeekday(r.approvedAt);
    if (w >= 0) counts[w] = (counts[w] as number) + 1;
  }
  return WEEKDAY_LABELS.map((label, weekday) => ({
    weekday,
    label,
    count: counts[weekday] as number,
  }));
}

/** 한 가맹점의 요일 분포 — 반복이 뚜렷한 곳을 찾는 데 쓴다. */
export interface MerchantRhythm {
  merchant: string;
  total: number;
  /** 0=일 … 6=토. 길이 7. */
  byWeekday: number[];
  /** 평일(월~금)에만 나타나는가. 주말 0건 + 평일 전체 기준. */
  weekdayOnly: boolean;
}

/**
 * 반복이 뚜렷한 가맹점.
 *
 * `minVisits` 이상 방문한 곳만 본다 — 2~3회로는 요일 편향을 말할 수 없다.
 * 실측에서 이 함수가 찾는 것은 `벤디스`(18회, 월2 화3 수4 목6 금3, **주말 0**)처럼
 * 생활 리듬에 붙은 결제다.
 */
export function merchantRhythms(
  rows: readonly RhythmTransaction[],
  minVisits = 5,
): MerchantRhythm[] {
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    if (r.transactionType !== 'approval') continue;
    if (!r.approvedAt || !r.merchantNormalized) continue;
    const w = kstWeekday(r.approvedAt);
    if (w < 0) continue;
    const arr = acc.get(r.merchantNormalized) ?? (new Array(7).fill(0) as number[]);
    arr[w] = (arr[w] as number) + 1;
    acc.set(r.merchantNormalized, arr);
  }
  const out: MerchantRhythm[] = [];
  for (const [merchant, byWeekday] of acc) {
    const total = byWeekday.reduce((s, n) => s + n, 0);
    if (total < minVisits) continue;
    const weekend = (byWeekday[0] as number) + (byWeekday[6] as number);
    out.push({ merchant, total, byWeekday, weekdayOnly: weekend === 0 });
  }
  return out.sort((a, b) => b.total - a.total || a.merchant.localeCompare(b.merchant));
}
