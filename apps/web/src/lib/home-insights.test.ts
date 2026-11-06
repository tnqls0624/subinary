import { describe, expect, it } from "vitest";

import {
  buildUpcomingRows,
  kstDateKey,
  lastWeekWindow,
  nextBillingDate,
  paceText,
  previousMonthToDate,
  thisWeekWindow,
  upcomingUntil,
  weeklyDeltaText,
  whenText,
  type UpcomingHousingInput,
  type UpcomingRecurringInput,
} from "./home-insights";

/** `2026-11-04T22:37:00+09:00` 같은 KST 시각. */
const kst = (iso: string) => new Date(`${iso}+09:00`);

describe("지난달 같은 시점 창", () => {
  it("이번 달 경과 시간(시 단위 내림)만큼 지난달 1일부터 잡는다", () => {
    expect(previousMonthToDate(kst("2026-11-04T22:37:00"))).toEqual({
      from: kst("2026-10-01T00:00:00").toISOString(),
      to: kst("2026-10-04T22:00:00").toISOString(),
    });
  });
  it("지난달이 더 짧으면 지난달 끝에서 자르고, 1월이면 작년 12월과 비교한다", () => {
    expect(previousMonthToDate(kst("2026-03-31T10:00:00"))?.to).toBe(
      kst("2026-03-01T00:00:00").toISOString()
    );
    expect(previousMonthToDate(kst("2027-01-10T09:30:00"))?.from).toBe(
      kst("2026-12-01T00:00:00").toISOString()
    );
  });
  it("이번 달 첫 한 시간은 비교하지 않는다", () => {
    expect(previousMonthToDate(kst("2026-11-01T00:59:59"))).toBeNull();
  });
});

describe("페이스 문구", () => {
  it("같은 시점끼리의 차이를 말한다", () => {
    expect(paceText(100_000, 140_000)).toBe(
      "지난달 이맘때보다 40,000원 덜 썼어요"
    );
    expect(paceText(150_000, 100_000)).toBe(
      "지난달 이맘때보다 50,000원 더 썼어요"
    );
    expect(paceText(5_000, 5_000)).toBe("지난달 이맘때와 같아요");
  });
  it("둘 다 0이면 말할 게 없다", () => {
    expect(paceText(0, 0)).toBeNull();
    expect(paceText(Number.NaN, 1)).toBeNull();
  });
});

describe("지난주 창", () => {
  it("월요일 0시 기준으로 지난주 전체를 잡고 일요일까지를 라벨로 쓴다", () => {
    // 2026-11-04는 수요일. 이번 주 월요일 = 11월 2일.
    expect(lastWeekWindow(kst("2026-11-04T22:00:00"))).toEqual({
      from: kst("2026-10-26T00:00:00").toISOString(),
      to: kst("2026-11-02T00:00:00").toISOString(),
      label: "10월 26일 – 11월 1일",
    });
  });
  it("해가 바뀐 주는 지난해 날짜에 연도를 붙인다", () => {
    // 2027-01-06은 수요일. 지난주 = 2026-12-28(월) ~ 2027-01-03(일).
    expect(lastWeekWindow(kst("2027-01-06T10:00:00")).label).toBe(
      "2026년 12월 28일 – 1월 3일"
    );
  });
  it("월요일 0시 직후에도 막 끝난 지난주를 본다", () => {
    expect(lastWeekWindow(kst("2026-11-02T00:10:00")).to).toBe(
      kst("2026-11-02T00:00:00").toISOString()
    );
  });
  it("그 전주가 0이면 비교하지 않는다", () => {
    expect(weeklyDeltaText(30_000, 0)).toBeNull();
    expect(weeklyDeltaText(30_000, 50_000)).toBe(
      "그 전주보다 20,000원 덜 썼어요"
    );
  });
});

describe("이번 주 창", () => {
  it("월요일 0시 기준으로 이번 주 전체를 잡고 일요일까지를 라벨로 쓴다", () => {
    // 2026-11-04는 수요일. 이번 주 월요일 = 11월 2일, 다음 주 월요일 = 11월 9일.
    expect(thisWeekWindow(kst("2026-11-04T22:00:00"))).toEqual({
      from: kst("2026-11-02T00:00:00").toISOString(),
      to: kst("2026-11-09T00:00:00").toISOString(),
      label: "11월 2일 – 11월 8일",
    });
  });
  it("지난주 창의 to와 이번 주 창의 from이 같다", () => {
    const now = kst("2026-11-04T22:00:00");
    expect(thisWeekWindow(now).from).toBe(lastWeekWindow(now).to);
  });
});

describe("정기 결제 예정 창", () => {
  it("오늘부터 7일째 날 마지막 순간(KST)까지 잡고 하루 동안 같은 값을 쓴다", () => {
    expect(upcomingUntil(kst("2026-11-04T09:00:00"))).toBe(new Date(kst("2026-11-12T00:00:00").getTime() - 1).toISOString());
    expect(upcomingUntil(kst("2026-11-04T23:59:00"))).toBe(upcomingUntil(kst("2026-11-04T00:00:00")));
  });
});

describe("다가오는 날짜 표기", () => {
  it("오늘·내일·예정일 지남 외에는 'M월 D일', 해가 바뀌면 연도를 붙인다", () => {
    expect(whenText("2026-11-05", "2026-11-05")).toBe("오늘");
    expect(whenText("2026-11-06", "2026-11-05")).toBe("내일");
    expect(whenText("2026-11-04", "2026-11-05")).toBe("예정일 지남");
    expect(whenText("2026-11-20", "2026-11-05")).toBe("11월 20일");
    expect(whenText("2027-01-02", "2026-12-30")).toBe("2027년 1월 2일");
  });
});

describe("결제일", () => {
  it("오늘이 결제일이면 오늘, 지났으면 다음 달이다", () => {
    expect(nextBillingDate(14, "2026-11-14")).toBe("2026-11-14");
    expect(nextBillingDate(14, "2026-11-15")).toBe("2026-12-14");
    expect(nextBillingDate(14, "2026-12-20")).toBe("2027-01-14");
  });
  it("그 달에 없는 날은 말일로 당긴다", () => {
    expect(nextBillingDate(31, "2026-11-04")).toBe("2026-11-30");
    expect(nextBillingDate(31, "2027-02-10")).toBe("2027-02-28");
  });
});

describe("다가오는 지출", () => {
  const now = kst("2026-11-04T09:00:00");
  const recurring = (
    over: Partial<UpcomingRecurringInput> = {}
  ): UpcomingRecurringInput => ({
    id: "r1",
    merchant: "넷플릭스",
    amount: 17_000,
    currency: "KRW",
    amountForecastable: true,
    nextExpectedAt: kst("2026-11-06T00:00:00").toISOString(),
    nextExpectedPhase: "upcoming",
    overdueDays: 0,
    ...over,
  });
  const housing = (
    over: Partial<NonNullable<UpcomingHousingInput["nextPayment"]>> = {}
  ): UpcomingHousingInput => ({
    nextPayment: {
      label: "합성 테스트 주택",
      kind: "interim",
      installment: 2,
      dueDate: "2026-11-20",
      remainingAmountKrw: "90071992547409931234",
      ...over,
    },
    hasIncompletePayments: false,
  });
  const build = (input: Partial<Parameters<typeof buildUpcomingRows>[0]>) =>
    buildUpcomingRows({
      now,
      recurring: [],
      housing: null,
      cards: [],
      lastMonthCardSpend: null,
      ...input,
    });

  it("세 출처를 날짜순으로 합치고, 지난 예정을 맨 앞에 둔다", () => {
    const rows = build({
      recurring: [
        recurring(),
        recurring({
          id: "r2",
          merchant: "헬스장",
          nextExpectedAt: kst("2026-11-01T00:00:00").toISOString(),
          nextExpectedPhase: "overdue",
          overdueDays: 3,
        }),
      ],
      housing: housing(),
      cards: [{ id: "c1", alias: "현대카드", status: "active", billingDay: 5 }],
      lastMonthCardSpend: new Map([["c1", 832_000]]),
    });
    expect(rows.map((row) => row.key)).toEqual([
      "recurring:r2",
      "card:c1",
      "recurring:r1",
      "housing:next",
    ]);
    expect(rows[0]).toMatchObject({
      when: "예정일 지남",
      subtitle: "정기 결제 · 3일 지났어요",
    });
    expect(rows[1]).toMatchObject({
      when: "내일",
      title: "현대카드 결제일",
      subtitle: "지난달 사용 832,000원",
      amountText: null,
    });
    expect(rows[2]).toMatchObject({ when: "11월 6일", amountText: "17,000원" });
  });

  it("예고할 수 없는 금액과 외화는 0원으로 만들지 않는다", () => {
    expect(
      build({ recurring: [recurring({ amountForecastable: false })] })[0]
        .amountText
    ).toBeNull();
    expect(
      build({ recurring: [recurring({ currency: "USD" })] })[0].amountText
    ).toBeNull();
  });

  it("카드는 결제일을 입력한 활성 카드 중 7일 안만, 청구액이 아니라 지난달 사용액만 말한다", () => {
    const cards = [
      { id: "c1", alias: "A", status: "active", billingDay: 11 },
      { id: "c2", alias: "B", status: "active", billingDay: 12 },
      { id: "c3", alias: "C", status: "inactive", billingDay: 5 },
      { id: "c4", alias: "D", status: "active", billingDay: null },
    ];
    const rows = build({ cards, lastMonthCardSpend: new Map() });
    expect(rows.map((row) => row.key)).toEqual(["card:c1"]);
    expect(rows[0].subtitle).toBe("지난달 사용 0원");
    expect(build({ cards }).map((row) => row.subtitle)).toEqual([null]);
  });

  it("주택은 저장된 금액·날짜를 그대로 쓰고 30일 밖이면 숨긴다", () => {
    const [row] = build({ housing: housing() });
    expect(row).toMatchObject({
      title: "주택 중도금 2회차",
      amountText: "90,071,992,547,409,931,234원",
      href: "/plan?scope=household",
      // 저장된 날짜를 시간대 때문에 하루 옮기지 않는다.
      date: "2026-11-20",
      when: "11월 20일",
    });
    // 날짜는 왼쪽 칸에만 — 부제에 같은 날짜를 다시 쓰지 않는다.
    expect(row.subtitle).toBe("합성 테스트 주택");
    expect(build({ housing: housing({ dueDate: "2026-12-20" }) })).toEqual([]);
  });

  it("납부일이 지난 주택 일정은 정기 결제처럼 며칠 지났는지 말한다", () => {
    const [row] = build({ housing: housing({ dueDate: "2026-11-01" }) });
    expect(row).toMatchObject({
      when: "예정일 지남",
      subtitle: "합성 테스트 주택 · 3일 지났어요",
      overdue: true,
    });
    const [today] = build({ housing: housing({ dueDate: "2026-11-04" }) });
    expect(today).toMatchObject({ when: "오늘", subtitle: "합성 테스트 주택", overdue: false });
  });

  it("일정이 없고 비어 있는 항목만 있으면 0원 대신 확인 안내 한 줄을 둔다", () => {
    const rows = build({
      housing: { nextPayment: null, hasIncompletePayments: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: null,
      amountText: null,
      subtitle: "금액·날짜·납부 내역이 비어 있는 항목이 있어요.",
    });
    expect(
      build({ housing: { nextPayment: null, hasIncompletePayments: false } })
    ).toEqual([]);
  });

  it("KST 날짜 경계를 쓴다", () => {
    expect(kstDateKey(new Date("2026-11-04T15:30:00Z"))).toBe("2026-11-05");
  });
});
