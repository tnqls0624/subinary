/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 홈 인사이트 계산(순수 함수)
 *
 * 홈은 "이번 달 괜찮나 · 누가 얼마 · 곧 나갈 돈 · 지난주"를 답한다(2026-11-04 홈 개편).
 * 여기 있는 함수는 **기간 창과 문구만** 만든다. 금액 합계는 전부 서버 집계
 * (`/analytics/*`, ADR-0026 지출 정의)를 그대로 쓴다 — 화면이 거래를 다시 세면 같은
 * 기간의 숫자가 화면마다 갈린다.
 *
 * 시간 경계는 모두 Asia/Seoul이다. 서버 analytics도 달 경계를 KST로 자른다.
 * ------------------------------------------------------------------------- */
import { formatMonthDay, formatWon } from "@/lib/format";
import { manualKrwText } from "@/lib/home-finance-summary";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface TimeWindow {
  /** ISO 시각. 반열린 구간 `[from, to)`. */
  from: string;
  to: string;
}

/** `YYYY-MM` → 그 달 1일 0시(KST). */
export function kstMonthStart(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1) - KST_OFFSET_MS);
}

/** 시각이 속한 KST 달(`YYYY-MM`). */
export function kstMonthKey(now: Date): string {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(
    shifted.getUTCMonth() + 1
  ).padStart(2, "0")}`;
}

/** 시각이 속한 KST 날짜(`YYYY-MM-DD`). */
export function kstDateKey(now: Date): string {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}`;
}

/**
 * 지난달 같은 시점까지의 창: `[지난달 1일 0시, 지난달 1일 0시 + 이번 달 경과 시간)`.
 *
 * 이번 달은 아직 끝나지 않았으니 지난달 **전체**와 비교하면 매달 초에 늘 "덜 썼어요"가
 * 된다. 같은 경과 시간끼리 비교해야 페이스가 된다. 경과 시간은 시간 단위로 내린다 —
 * 한 시간 안에서는 같은 창(같은 쿼리 키)을 써서 홈 폴링마다 새 요청을 만들지 않는다.
 * 지난달이 더 짧으면(3월 31일 → 2월) 지난달 끝에서 자른다. 이번 달 첫 한 시간은
 * 비교할 거리가 없어 null이다.
 */
export function previousMonthToDate(now: Date): TimeWindow | null {
  const month = kstMonthKey(now);
  const thisStart = kstMonthStart(month).getTime();
  const elapsed = Math.floor((now.getTime() - thisStart) / HOUR_MS) * HOUR_MS;
  if (elapsed <= 0) return null;
  const previousStart = kstMonthStart(shiftMonth(month, -1)).getTime();
  const to = Math.min(previousStart + elapsed, thisStart);
  return {
    from: new Date(previousStart).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/** 이번 달 누적과 지난달 같은 시점 누적의 차이를 한 줄로. 둘 다 0이면 말할 게 없다. */
export function paceText(
  currentNet: number,
  previousToDateNet: number
): string | null {
  if (!Number.isFinite(currentNet) || !Number.isFinite(previousToDateNet))
    return null;
  if (currentNet === 0 && previousToDateNet === 0) return null;
  const delta = currentNet - previousToDateNet;
  if (delta === 0) return "지난달 이맘때와 같아요";
  return `지난달 이맘때보다 ${formatWon(Math.abs(delta))} ${
    delta > 0 ? "더" : "덜"
  } 썼어요`;
}

export interface WeekWindow extends TimeWindow {
  /** `10월 27일 – 11월 2일`. 해가 다른 날은 `2026년 12월 28일`(lib/format 날짜 표기). */
  label: string;
}

/** 이번 주 월요일 0시(KST)의 UTC epoch ms. 주 시작은 월요일(홈·주간 회고와 동일). */
function thisMondayUtcMs(now: Date): number {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  return (
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() - daysSinceMonday
    ) - KST_OFFSET_MS
  );
}

/** 지난주 월요일 0시 ~ 이번 주 월요일 0시(KST). 서버가 그 앞 같은 길이(그 전주)를 비교 구간으로 준다. */
export function lastWeekWindow(now: Date): WeekWindow {
  const thisMonday = thisMondayUtcMs(now);
  const from = thisMonday - 7 * DAY_MS;
  return {
    from: new Date(from).toISOString(),
    to: new Date(thisMonday).toISOString(),
    label: `${formatMonthDay(new Date(from), now)} – ${formatMonthDay(
      new Date(thisMonday - DAY_MS),
      now
    )}`,
  };
}

/** 이번 주 월요일 0시 ~ 다음 주 월요일 0시(KST). 「주간 가계 돌아보기」기간. */
export function thisWeekWindow(now: Date): WeekWindow {
  const thisMonday = thisMondayUtcMs(now);
  const nextMonday = thisMonday + 7 * DAY_MS;
  return {
    from: new Date(thisMonday).toISOString(),
    to: new Date(nextMonday).toISOString(),
    label: `${formatMonthDay(new Date(thisMonday), now)} – ${formatMonthDay(
      new Date(nextMonday - DAY_MS),
      now
    )}`,
  };
}

export function weeklyDeltaText(
  net: number,
  previousNet: number
): string | null {
  if (
    !Number.isFinite(net) ||
    !Number.isFinite(previousNet) ||
    previousNet === 0
  )
    return null;
  const delta = net - previousNet;
  if (delta === 0) return "그 전주와 같아요";
  return `그 전주보다 ${formatWon(Math.abs(delta))} ${
    delta > 0 ? "더" : "덜"
  } 썼어요`;
}

/* ------------------------------------------------------------------------- *
 * 다가오는 지출
 * ------------------------------------------------------------------------- */

/** 정기 결제·카드 결제일을 보여주는 창(오늘부터 7일). 주택 납부는 금액이 커서 30일 전부터 보여준다. */
export const UPCOMING_DAYS = 7;
export const HOUSING_NOTICE_DAYS = 30;

/**
 * 정기 결제 예정 조회 창의 끝: 오늘부터 7일째 되는 날의 마지막 순간(KST). 하루 동안 같은
 * 값이라 홈 폴링이 새 쿼리 키를 만들지 않는다.
 */
export function upcomingUntil(now: Date): string {
  const [year, month, day] = kstDateKey(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + UPCOMING_DAYS + 1) - KST_OFFSET_MS - 1).toISOString();
}

export interface UpcomingRecurringInput {
  id: string;
  merchant: string;
  amount: number;
  currency: string;
  amountForecastable: boolean;
  nextExpectedAt: string;
  nextExpectedPhase: "upcoming" | "due" | "overdue";
  overdueDays: number;
}

export interface UpcomingHousingInput {
  /** 서버가 고른 가장 이른 미지급 일정. 주택 쿼리가 성공했을 때만 넘긴다. */
  nextPayment: {
    label: string;
    kind: "contract" | "interim" | "balance" | "option";
    installment: number | null;
    dueDate: string;
    remainingAmountKrw: string;
  } | null;
  hasIncompletePayments: boolean;
}

export interface UpcomingCardInput {
  id: string;
  alias: string;
  status: string;
  billingDay: number | null;
}

export interface UpcomingRow {
  key: string;
  /** 정렬·표시 기준 날짜(`YYYY-MM-DD`, KST). 날짜를 모르는 안내 행은 null. */
  date: string | null;
  /** `오늘`·`내일`·`11월 7일`·`예정일 지남` */
  when: string;
  title: string;
  subtitle: string | null;
  /** 금액을 말할 수 있을 때만. 모르면 null(0원으로 만들지 않는다). */
  amountText: string | null;
  href: string;
  overdue: boolean;
}

const HOUSING_PAYMENT_LABEL = {
  contract: "계약금",
  interim: "중도금",
  balance: "잔금",
  option: "옵션",
} as const;

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function daysBetween(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS
  );
}

/** `오늘`·`내일`·`11월 7일`(해가 바뀌면 `2027년 1월 2일`)·`예정일 지남`. 날짜는 둘 다 KST `YYYY-MM-DD`. */
export function whenText(dateKey: string, todayKey: string): string {
  const days = daysBetween(todayKey, dateKey);
  if (days < 0) return "예정일 지남";
  if (days === 0) return "오늘";
  if (days === 1) return "내일";
  return formatMonthDay(dateKey, new Date(`${todayKey}T12:00:00+09:00`));
}

/**
 * 다음 결제일(`YYYY-MM-DD`, KST). 오늘이 결제일이면 오늘이다. 결제일이 그 달에 없으면
 * (31일 결제 → 30일까지인 달) 그 달 마지막 날로 당긴다 — 카드사도 말일로 처리한다.
 */
export function nextBillingDate(billingDay: number, todayKey: string): string {
  const [year, month, day] = todayKey.split("-").map(Number);
  const inMonth = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1, Math.min(billingDay, last)))
      .toISOString()
      .slice(0, 10);
  };
  const thisMonth = inMonth(year, month);
  if (Number(thisMonth.slice(8, 10)) >= day) return thisMonth;
  return month === 12 ? inMonth(year + 1, 1) : inMonth(year, month + 1);
}

/**
 * 다가오는 지출 행. 세 출처를 날짜순으로 합친다.
 * - 정기 결제: 서버가 7일 창으로 거른 예정(지난 예정 포함). 금액은 예고할 수 있을 때만.
 * - 카드 결제일: 결제일을 입력한 활성 카드. **청구액이 아니라 지난달 사용액**을 보조로만
 *   말한다 — 카드사마다 이용기간 규칙이 달라 청구액을 계산하면 틀린다.
 * - 주택 납부: 30일 안의 다음 일정. 저장된 금액·날짜를 그대로 쓴다.
 */
export function buildUpcomingRows(input: {
  now: Date;
  recurring: readonly UpcomingRecurringInput[];
  housing: UpcomingHousingInput | null;
  cards: readonly UpcomingCardInput[];
  /** 카드 id → 지난달 순사용액(원). 집계가 없으면 키가 없다. */
  lastMonthCardSpend: ReadonlyMap<string, number> | null;
}): UpcomingRow[] {
  const todayKey = kstDateKey(input.now);
  const rows: UpcomingRow[] = [];

  for (const item of input.recurring) {
    const date = kstDateKey(new Date(item.nextExpectedAt));
    const overdue = item.nextExpectedPhase === "overdue";
    rows.push({
      key: `recurring:${item.id}`,
      date,
      when: overdue ? "예정일 지남" : whenText(date, todayKey),
      title: item.merchant,
      subtitle: overdue
        ? `정기 결제 · ${item.overdueDays}일 지났어요`
        : "정기 결제",
      amountText:
        item.amountForecastable && item.currency === "KRW"
          ? formatWon(item.amount)
          : null,
      href: "/more/recurring",
      overdue,
    });
  }

  const cardWindowEnd = addDays(todayKey, UPCOMING_DAYS);
  for (const card of input.cards) {
    if (card.status !== "active" || card.billingDay == null) continue;
    const date = nextBillingDate(card.billingDay, todayKey);
    if (date > cardWindowEnd) continue;
    const spend = input.lastMonthCardSpend?.get(card.id);
    rows.push({
      key: `card:${card.id}`,
      date,
      when: whenText(date, todayKey),
      title: `${card.alias} 결제일`,
      subtitle:
        input.lastMonthCardSpend == null
          ? null
          : `지난달 사용 ${formatWon(spend ?? 0)}`,
      amountText: null,
      href: "/cards",
      overdue: false,
    });
  }

  const next = input.housing?.nextPayment ?? null;
  if (next && daysBetween(todayKey, next.dueDate) <= HOUSING_NOTICE_DAYS) {
    const overdueDays = daysBetween(next.dueDate, todayKey);
    rows.push({
      key: "housing:next",
      date: next.dueDate,
      when: whenText(next.dueDate, todayKey),
      title: `주택 ${HOUSING_PAYMENT_LABEL[next.kind]}${
        next.installment !== null ? ` ${next.installment}회차` : ""
      }`,
      // 날짜는 왼쪽 칸이 이미 말한다 — 부제에 다시 쓰지 않는다. 지난 일정은 정기 결제처럼 며칠 지났는지만.
      subtitle:
        overdueDays > 0 ? `${next.label} · ${overdueDays}일 지났어요` : next.label,
      amountText: manualKrwText(next.remainingAmountKrw),
      href: "/plan?scope=household",
      overdue: overdueDays > 0,
    });
  } else if (input.housing?.hasIncompletePayments && !next) {
    rows.push({
      key: "housing:incomplete",
      date: null,
      when: "확인 필요",
      title: "주택 납부 일정",
      subtitle: "금액·날짜·납부 내역이 비어 있는 항목이 있어요.",
      amountText: null,
      href: "/plan?scope=household",
      overdue: false,
    });
  }

  // 지난 예정이 가장 급하다. 날짜 없는 안내는 맨 뒤.
  return rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.date === null || b.date === null) return a.date === null ? 1 : -1;
    return a.date.localeCompare(b.date) || a.key.localeCompare(b.key);
  });
}
