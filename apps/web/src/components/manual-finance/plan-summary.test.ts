/**
 * 주택 상세 시트의 순수 계산(2026-11-08 PO 재설계). 금액은 모두 가짜 값이다.
 * 모름(null)과 0을 구분하고, 20자리 금액도 문자열/BigInt로 정확히 더하는지, 사람 말(영문 칸 이름·ISO 날짜 없음)로 나오는지 고정한다.
 */
import { summarizeManualHousingPlans } from "@family/shared";
import type {
  HousingBrandConnection,
  HousingBrandFetchedItem,
  ManualHousingPayment,
  ManualHousingPlanResponse,
} from "@family/contracts";
import { describe, expect, it } from "vitest";

import {
  BRAND_PENDING_LINE,
  brandConnectionState,
  brandSourceLine,
  draftPaymentSummary,
  groupPlanPayments,
  housingPaymentName,
  mergePlanRead,
  nextPaymentLine,
  paymentProgress,
  paymentRowCaption,
  paymentRowView,
  paymentStatusChip,
  planMoneySummary,
  planNextPayment,
  planSummaryLines,
  previewChanges,
  previewUnreadLine,
  splitOptionLabel,
} from "./plan-summary";

const NOW = new Date("2026-11-08T03:00:00Z");
const PLAN = {
  id: "c6a5d4e3-2b1a-4f9e-8d7c-6b5a4e3d2c1b",
  label: "합성 아파트 59",
};
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function pay(over: Partial<ManualHousingPayment> = {}): ManualHousingPayment {
  return {
    id: id(),
    planId: PLAN.id,
    kind: "interim",
    installment: 1,
    label: null,
    dueDate: "2026-11-20",
    amount: "30000000",
    paidAmount: "0",
    paidDate: null,
    ...over,
  };
}

function fetched(
  over: Partial<HousingBrandFetchedItem> = {}
): HousingBrandFetchedItem {
  return {
    key: id(),
    kind: "interim",
    installment: 3,
    label: null,
    scheduledAmount: null,
    dueDate: null,
    paidAmount: null,
    paidDate: null,
    actualPaidDate: null,
    matchedPaymentId: null,
    changedFields: [],
    unreadFields: [],
    ...over,
  };
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const FIELD_NAMES =
  /scheduledAmount|dueDate|paidAmount|paidDate|actualPaidDate|installment|changedFields/;

describe("이름", () => {
  it("분양대금은 '중도금 3회차'·'계약금', 옵션은 '제목 줄 이름'", () => {
    expect(housingPaymentName({ kind: "interim", installment: 3 })).toBe(
      "중도금 3회차"
    );
    expect(housingPaymentName({ kind: "contract", installment: null })).toBe(
      "계약금"
    );
    expect(housingPaymentName({ kind: "balance", installment: null })).toBe(
      "잔금"
    );
    expect(
      housingPaymentName({
        kind: "option",
        installment: null,
        label: "발코니 확장 외 2 · 계약금",
      })
    ).toBe("발코니 확장 외 2 계약금");
    expect(
      housingPaymentName({
        kind: "option",
        installment: null,
        label: "시스템 에어컨",
      })
    ).toBe("시스템 에어컨");
    expect(
      housingPaymentName({ kind: "option", installment: null, label: null })
    ).toBe("옵션");
  });

  it("옵션이 아니면 label(주택 이름 등)을 이름으로 읽지 않는다", () => {
    expect(
      housingPaymentName({
        kind: "interim",
        installment: 2,
        label: "합성 아파트 59",
      })
    ).toBe("중도금 2회차");
  });

  it("옵션 이름은 마지막 ' · ' 앞이 계약 제목, 뒤가 줄 이름", () => {
    expect(splitOptionLabel("가전 A · 가전 B · 잔금")).toEqual({
      title: "가전 A · 가전 B",
      name: "잔금",
    });
    expect(splitOptionLabel("시스템 에어컨")).toEqual({
      title: null,
      name: "시스템 에어컨",
    });
    expect(splitOptionLabel(" · 계약금")).toEqual({
      title: null,
      name: " · 계약금",
    });
  });
});

describe("일정 하나의 상태", () => {
  it("모름은 0이 아니라 확인 필요, 남은 금액은 0 아래로 내려가지 않는다", () => {
    expect(paymentProgress({ amount: null, paidAmount: "0" })).toEqual({
      status: "unknown",
      remaining: null,
    });
    expect(paymentProgress({ amount: "100", paidAmount: null })).toEqual({
      status: "unknown",
      remaining: null,
    });
    expect(paymentProgress({ amount: "100", paidAmount: "0" })).toEqual({
      status: "unpaid",
      remaining: "100",
    });
    expect(paymentProgress({ amount: "100", paidAmount: "40" })).toEqual({
      status: "partial",
      remaining: "60",
    });
    expect(paymentProgress({ amount: "100", paidAmount: "100" })).toEqual({
      status: "paid",
      remaining: "0",
    });
    expect(paymentProgress({ amount: "0", paidAmount: "0" })).toEqual({
      status: "paid",
      remaining: "0",
    });
  });

  it("칩은 납부 완료·일부 납부·확인 필요만 — 기본 상태(예정)는 그리지 않는다", () => {
    expect(paymentStatusChip("paid")).toEqual({
      label: "납부 완료",
      tone: "ok",
    });
    expect(paymentStatusChip("partial")).toEqual({
      label: "일부 납부",
      tone: "pending",
    });
    expect(paymentStatusChip("unknown")).toEqual({
      label: "확인 필요",
      tone: "attention",
    });
    expect(paymentStatusChip("unpaid")).toBeNull();
  });

  it("줄 아래 한 줄은 'M월 D일 예정' 또는 'M월 D일 납부', 일부 납부면 남은 금액", () => {
    expect(paymentRowCaption(pay(), NOW)).toBe("11월 20일 예정");
    expect(
      paymentRowCaption(
        pay({ paidAmount: "30000000", paidDate: "2026-11-03" }),
        NOW
      )
    ).toBe("11월 3일 납부");
    expect(
      paymentRowCaption(
        pay({ paidAmount: "29000000", paidDate: "2026-11-03" }),
        NOW
      )
    ).toBe("11월 20일 예정 · 남은 1,000,000원");
    expect(
      paymentRowCaption(pay({ amount: null, paidAmount: null }), NOW)
    ).toBe("11월 20일 예정");
    expect(paymentRowCaption(pay({ paidAmount: null }), NOW)).toBe(
      "11월 20일 예정 · 낸 금액 미확인"
    );
    expect(paymentRowCaption(pay({ dueDate: null }), NOW)).toBe(
      "예정일 미입력"
    );
    expect(paymentRowCaption(pay({ dueDate: "2027-01-10" }), NOW)).toBe(
      "2027년 1월 10일 예정"
    );
  });

  it("줄 아래에 '낸 금액 미확인'이 있으면 '확인 필요' 칩을 붙이지 않는다 — 같은 말을 한 번만", () => {
    expect(paymentRowView(pay({ paidAmount: null }), NOW)).toEqual({
      caption: "11월 20일 예정 · 낸 금액 미확인",
      chip: null,
    });
    // 예정 금액을 모르면 값 자리가 '금액 미입력'이고, 칩이 상태를 말한다.
    expect(
      paymentRowView(pay({ amount: null, paidAmount: null }), NOW)
    ).toEqual({
      caption: "11월 20일 예정",
      chip: { label: "확인 필요", tone: "attention" },
    });
    expect(
      paymentRowView(
        pay({ paidAmount: "10000000", paidDate: "2026-11-03" }),
        NOW
      )
    ).toEqual({
      caption: "11월 20일 예정 · 남은 20,000,000원",
      chip: { label: "일부 납부", tone: "pending" },
    });
    expect(paymentRowView(pay(), NOW).chip).toBeNull();
  });
});

describe("남은 금액 요약", () => {
  it("두 금액을 다 아는 일정만 더하고, 뺀 일정 수를 말한다", () => {
    const summary = planMoneySummary([
      pay({
        amount: "10000000",
        paidAmount: "10000000",
        paidDate: "2026-03-02",
      }),
      pay({
        amount: "30000000",
        paidAmount: "10000000",
        paidDate: "2026-07-01",
      }),
      pay({ amount: "30000000", paidAmount: "0" }),
      pay({ amount: null, paidAmount: null }),
      pay({ amount: "5000000", paidAmount: null }),
    ]);
    expect(summary).toEqual({
      total: "70000000",
      paid: "20000000",
      remaining: "50000000",
      unknownCount: 2,
      unknownAmountCount: 1,
      unknownPaidCount: 1,
    });
    expect(planSummaryLines(summary)).toEqual({
      headline: null,
      paidLine: "총 70,000,000원 중 20,000,000원 냈어요",
      caveat:
        "확인된 금액 기준 · 예정 금액이나 낸 금액을 모르는 일정 2개는 뺐어요",
    });
  });

  it("무엇을 모르는지 따로 말한다 — 줄에 금액이 보이는 일정을 '금액을 모른다'고 하지 않는다", () => {
    const known = pay({ amount: "10000000", paidAmount: "0" });
    expect(
      planSummaryLines(
        planMoneySummary([known, pay({ amount: "5000000", paidAmount: null })])
      ).caveat
    ).toBe("확인된 금액 기준 · 낸 금액을 모르는 일정 1개는 뺐어요");
    expect(
      planSummaryLines(
        planMoneySummary([known, pay({ amount: null, paidAmount: "0" })])
      ).caveat
    ).toBe("확인된 금액 기준 · 예정 금액을 모르는 일정 1개는 뺐어요");
  });

  it("예정 금액만 알고 낸 금액은 모르면(직접 만든 주택) 남은 금액 대신 무엇을 하면 되는지 말한다", () => {
    const summary = planMoneySummary([
      pay({ installment: 1, paidAmount: null }),
      pay({ installment: 2, paidAmount: null }),
    ]);
    expect(summary).toEqual({
      total: null,
      paid: null,
      remaining: null,
      unknownCount: 2,
      unknownAmountCount: 0,
      unknownPaidCount: 2,
    });
    expect(planSummaryLines(summary, { canEdit: true })).toEqual({
      headline: "이미 낸 금액(없으면 0)을 적으면 남은 금액을 계산해요",
      paidLine: null,
      caveat: "낸 금액을 모르는 일정이 2개 있어요",
    });
    // 고칠 수 없는 사람에게는 '적으면'이라고 하지 않는다.
    expect(planSummaryLines(summary).headline).toBe(
      "남은 금액을 아직 계산할 수 없어요"
    );
  });

  it("다 아는 일정이 하나도 없으면 0원이 아니라 null — 그래도 왜 없는지 한 줄은 남긴다", () => {
    const summary = planMoneySummary([pay({ amount: null, paidAmount: null })]);
    expect(summary).toEqual({
      total: null,
      paid: null,
      remaining: null,
      unknownCount: 1,
      unknownAmountCount: 1,
      unknownPaidCount: 0,
    });
    expect(planSummaryLines(summary, { canEdit: true })).toEqual({
      headline: "예정 금액을 적으면 남은 금액을 계산해요",
      paidLine: null,
      caveat: "예정 금액을 모르는 일정이 1개 있어요",
    });
    expect(
      planSummaryLines(
        planMoneySummary([
          pay({ amount: null, paidAmount: null }),
          pay({ paidAmount: null }),
        ]),
        { canEdit: true }
      )
    ).toEqual({
      headline:
        "예정 금액과 이미 낸 금액(없으면 0)을 적으면 남은 금액을 계산해요",
      paidLine: null,
      caveat: "예정 금액이나 낸 금액을 모르는 일정이 2개 있어요",
    });
    expect(planMoneySummary([])).toEqual({
      total: null,
      paid: null,
      remaining: null,
      unknownCount: 0,
      unknownAmountCount: 0,
      unknownPaidCount: 0,
    });
    expect(planSummaryLines(planMoneySummary([]))).toEqual({
      headline: null,
      paidLine: null,
      caveat: null,
    });
  });

  it("0원 일정은 모름이 아니다 — 합계에 넣고 안내를 붙이지 않는다", () => {
    const summary = planMoneySummary([pay({ amount: "0", paidAmount: "0" })]);
    expect(summary).toEqual({
      total: "0",
      paid: "0",
      remaining: "0",
      unknownCount: 0,
      unknownAmountCount: 0,
      unknownPaidCount: 0,
    });
    expect(planSummaryLines(summary).caveat).toBeNull();
    expect(planSummaryLines(summary).headline).toBeNull();
  });

  it("20자리 금액도 Number로 잃지 않고 정확히 더한다", () => {
    const summary = planMoneySummary([
      pay({
        amount: "99999999999999999999",
        paidAmount: "1",
        paidDate: "2026-03-02",
      }),
      pay({ amount: "99999999999999999999", paidAmount: "0" }),
    ]);
    expect(summary.total).toBe("199999999999999999998");
    expect(summary.remaining).toBe("199999999999999999997");
    expect(planSummaryLines(summary).paidLine).toBe(
      "총 199,999,999,999,999,999,998원 중 1원 냈어요"
    );
  });
});

describe("다음 납부", () => {
  it("/plan '다음 납부'(서버 summarizeManualHousingPlans)와 같은 일정·금액을 고른다", () => {
    const payments = [
      pay({
        installment: 1,
        dueDate: "2026-03-02",
        paidAmount: "30000000",
        paidDate: "2026-03-02",
      }),
      pay({ installment: 3, dueDate: "2027-01-10" }),
      pay({
        installment: 2,
        dueDate: "2026-11-20",
        paidAmount: "10000000",
        paidDate: "2026-11-03",
      }),
      pay({
        installment: 4,
        dueDate: "2026-11-01",
        amount: null,
        paidAmount: null,
      }),
      pay({ installment: 5, dueDate: null }),
    ];
    const next = planNextPayment(PLAN, payments);
    const server = summarizeManualHousingPlans([
      { ...PLAN, payments },
    ]).nextPayment;
    expect(next).toEqual({
      paymentId: server?.paymentId,
      dueDate: "2026-11-20",
      remaining: server?.remainingAmountKrw,
      name: "중도금 2회차",
    });
    expect(next?.remaining).toBe("20000000");
    expect(nextPaymentLine(next!, NOW)).toBe(
      "다음 납부 11월 20일 · 중도금 2회차 20,000,000원"
    );
  });

  it("옵션이면 옵션 이름을 쓰고, 다 냈거나 날짜·금액을 모르면 없다", () => {
    const option = pay({
      kind: "option",
      installment: null,
      label: "발코니 확장 외 2 · 계약금",
      dueDate: "2026-12-01",
      amount: "1000000",
    });
    expect(planNextPayment(PLAN, [option])?.name).toBe(
      "발코니 확장 외 2 계약금"
    );
    expect(
      planNextPayment(PLAN, [
        pay({ paidAmount: "30000000", paidDate: "2026-11-03" }),
        pay({ amount: null, paidAmount: null }),
        pay({ dueDate: null }),
      ])
    ).toBeNull();
  });

  it("서버 함수가 던지는 값(미래 납부일)이어도 시트를 깨지 않고 없다고 본다", () => {
    expect(
      planNextPayment(PLAN, [pay({ paidAmount: "1", paidDate: "2999-01-01" })])
    ).toBeNull();
  });
});

describe("일정 묶기", () => {
  it("분양대금은 계약금 → 중도금(회차 순) → 잔금, 옵션은 계약 제목별", () => {
    const balance = pay({
      kind: "balance",
      installment: null,
      dueDate: "2028-06-30",
    });
    const interim2 = pay({ installment: 2 });
    const contract = pay({
      kind: "contract",
      installment: null,
      dueDate: "2026-03-02",
    });
    const interim1 = pay({ installment: 1 });
    const balcony1 = pay({
      kind: "option",
      installment: null,
      label: "발코니 확장 외 2 · 계약금",
    });
    const aircon = pay({
      kind: "option",
      installment: null,
      label: "시스템 에어컨",
    });
    const balcony2 = pay({
      kind: "option",
      installment: null,
      label: "발코니 확장 외 2 · 잔금",
    });
    const groups = groupPlanPayments([
      balance,
      balcony1,
      interim2,
      aircon,
      contract,
      balcony2,
      interim1,
    ]);
    expect(groups.apartment.map((row) => row.name)).toEqual([
      "계약금",
      "중도금 1회차",
      "중도금 2회차",
      "잔금",
    ]);
    expect(groups.apartment[0]?.payment).toBe(contract);
    expect(groups.options).toEqual([
      {
        title: "발코니 확장 외 2",
        rows: [
          { payment: balcony1, name: "계약금" },
          { payment: balcony2, name: "잔금" },
        ],
      },
      { title: null, rows: [{ payment: aircon, name: "시스템 에어컨" }] },
    ]);
  });
});

describe("수자인 줄", () => {
  it("'수자인 · 11월 8일 오후 11:27 기준' — 한 번도 못 가져왔으면 그렇게 말한다", () => {
    expect(brandSourceLine("수자인", "2026-11-08T14:27:00.000Z", NOW)).toBe(
      "수자인 · 11월 8일 오후 11:27 기준"
    );
    expect(brandSourceLine("수자인", null, NOW)).toBe(
      "수자인 · 아직 가져오지 않았어요"
    );
  });

  it("서버의 '확인 필요'는 둘로 가른다 — 가져왔는데 반영 전(pending)과 추가 인증으로 못 가져옴(failed)", () => {
    const at = "2026-11-08T14:27:00.000Z";
    expect(
      brandConnectionState({
        status: "connected",
        lastFetchAt: at,
        lastSuccessAt: at,
      })
    ).toBe("ok");
    expect(
      brandConnectionState({
        status: "failed",
        lastFetchAt: "2026-11-08T15:00:00.000Z",
        lastSuccessAt: at,
      })
    ).toBe("failed");
    // 가져오기에 성공하면 서버가 두 시각을 같은 값으로 남긴다.
    expect(
      brandConnectionState({
        status: "needs_confirmation",
        lastFetchAt: at,
        lastSuccessAt: at,
      })
    ).toBe("pending");
    // 추가 인증 실패는 가져온 시각만 늦어진다(성공 시각은 그대로이거나 없다).
    expect(
      brandConnectionState({
        status: "needs_confirmation",
        lastFetchAt: "2026-11-08T15:00:00.000Z",
        lastSuccessAt: at,
      })
    ).toBe("failed");
    expect(
      brandConnectionState({
        status: "needs_confirmation",
        lastFetchAt: at,
        lastSuccessAt: null,
      })
    ).toBe("failed");
    expect(BRAND_PENDING_LINE).toBe("가져온 내용을 아직 반영하지 않았어요");
    expect(BRAND_PENDING_LINE).not.toContain("골라 주세요");
  });
});

describe("읽은 주택 합치기", () => {
  const read = (
    brandConnection?: HousingBrandConnection | null
  ): ManualHousingPlanResponse => ({
    item: {
      id: PLAN.id,
      householdId: "4d1f3c22-1e6b-4b5f-8a3e-2a9b6c7d8e90",
      ownerUserId: "me",
      version: 2,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      canEdit: true,
      label: PLAN.label,
      visibility: "household",
      occupancyYear: 2028,
      contractStage: null,
      fundingNote: null,
    },
    payments: [pay()],
    ...(brandConnection === undefined ? {} : { brandConnection }),
  });
  const connection: HousingBrandConnection = {
    id: "11111111-1111-4111-8111-111111111111",
    planId: PLAN.id,
    brand: "sujain",
    status: "connected",
    statusMessage: null,
    credentialsStored: true,
    version: 3,
    lastFetchAt: null,
    lastSuccessAt: null,
    canManage: true,
  };

  it("응답에 연결 칸이 없으면 전 연결을 지키고, null 이면 연결 없음으로 받는다", () => {
    const old = read(connection);
    expect(mergePlanRead(old, read()).brandConnection).toBe(connection);
    expect(mergePlanRead(old, read(null)).brandConnection).toBeNull();
    const fresh = { ...connection, version: 4 };
    expect(mergePlanRead(old, read(fresh)).brandConnection).toBe(fresh);
    expect(mergePlanRead(undefined, read()).brandConnection).toBeUndefined();
    expect(mergePlanRead(old, read()).item.version).toBe(2);
  });
});

describe("가져온 결과(달라진 내용)", () => {
  const interim3 = pay({
    installment: 3,
    amount: "3000000",
    dueDate: "2026-11-20",
  });
  const contract = pay({
    kind: "contract",
    installment: null,
    amount: "10000000",
    paidAmount: "0",
    dueDate: "2026-03-02",
  });

  it("맞춰진 일정은 바뀐 칸마다 사람 말 '예정 금액 A → B', 새 일정은 '새 일정 · 이름 금액 · 날짜'", () => {
    const changes = previewChanges(
      [
        fetched({
          matchedPaymentId: interim3.id,
          scheduledAmount: "3100000",
          dueDate: "2026-11-25",
          changedFields: ["scheduledAmount", "dueDate"],
        }),
        fetched({
          matchedPaymentId: contract.id,
          kind: "contract",
          installment: null,
          paidAmount: "10000000",
          paidDate: "2026-03-02",
          actualPaidDate: "2026-03-02",
          changedFields: ["paidAmount", "paidDate", "actualPaidDate"],
        }),
        fetched({
          kind: "option",
          installment: null,
          label: "발코니 확장 외 2 · 계약금",
          scheduledAmount: "1000000",
          dueDate: "2026-11-20",
          changedFields: ["scheduledAmount", "dueDate", "label"],
        }),
      ],
      [interim3, contract],
      NOW
    );
    expect(
      changes.map(({ title, detail, isNew }) => ({ title, detail, isNew }))
    ).toEqual([
      {
        title: "중도금 3회차",
        detail:
          "예정 금액 3,000,000원 → 3,100,000원 · 예정일 11월 20일 → 11월 25일",
        isNew: false,
      },
      {
        title: "계약금",
        detail: "낸 금액 0원 → 10,000,000원 · 납부일 미입력 → 3월 2일",
        isNew: false,
      },
      {
        title: "새 일정",
        detail: "발코니 확장 외 2 계약금 1,000,000원 · 11월 20일",
        isNew: true,
      },
    ]);
    for (const change of changes) {
      expect(change.detail).not.toMatch(ISO_DATE);
      expect(change.detail).not.toMatch(FIELD_NAMES);
    }
  });

  it("값은 같고 못 읽은 칸만 있는 줄은 '달라진 내용'에서 빼고, 못 읽은 칸은 회색 한 줄로", () => {
    const changes = previewChanges(
      [
        fetched({
          matchedPaymentId: interim3.id,
          unreadFields: [
            { field: "scheduledAmount", reason: "금액 칸을 읽지 못했어요." },
          ],
        }),
      ],
      [interim3],
      NOW
    );
    expect(changes).toEqual([]);
    expect(
      previewUnreadLine({
        unreadCount: 2,
        unreadReasons: ["금액 칸을 읽지 못했어요."],
      })
    ).toBe("읽지 못한 칸이 2개 있어요 · 금액 칸을 읽지 못했어요.");
    expect(previewUnreadLine({ unreadCount: 1, unreadReasons: [] })).toBe(
      "읽지 못한 칸이 1개 있어요"
    );
    expect(previewUnreadLine({ unreadCount: 0, unreadReasons: [] })).toBeNull();
  });

  it("지금 일정을 못 찾으면 전 값을 지어내지 않고 새 값만, 회차·이름도 사람 말", () => {
    const [change] = previewChanges(
      [
        fetched({
          matchedPaymentId: id(),
          installment: 4,
          scheduledAmount: "99999999999999999999",
          changedFields: ["scheduledAmount", "installment"],
        }),
      ],
      [],
      NOW
    );
    expect(change?.title).toBe("중도금 4회차");
    expect(change?.detail).toBe(
      "예정 금액 99,999,999,999,999,999,999원 · 회차 4회차"
    );
  });

  it("새 일정에 이미 낸 금액이 있으면 덧붙이고, 금액·날짜를 모르면 빼고 쓴다", () => {
    const changes = previewChanges(
      [
        fetched({
          kind: "contract",
          installment: null,
          scheduledAmount: "10000000",
          paidAmount: "10000000",
          dueDate: "2026-03-02",
        }),
        fetched({ kind: "option", installment: null, label: "시스템 에어컨" }),
      ],
      [],
      NOW
    );
    expect(changes.map((change) => change.detail)).toEqual([
      "계약금 10,000,000원 · 3월 2일 · 낸 금액 10,000,000원",
      "시스템 에어컨",
    ]);
  });
});

describe("입력 폼의 접힌 일정 한 줄", () => {
  it("'중도금 3회차 · 3,000,000원 · 11월 20일' — 모르면 미입력", () => {
    const draft = {
      kind: "interim" as const,
      installment: "3",
      label: "",
      amount: "3000000",
      dueDate: "2026-11-20",
    };
    expect(draftPaymentSummary(draft, NOW)).toBe(
      "중도금 3회차 · 3,000,000원 · 11월 20일"
    );
    expect(draftPaymentSummary({ ...draft, amount: "3,000,000" }, NOW)).toBe(
      "중도금 3회차 · 3,000,000원 · 11월 20일"
    );
    expect(
      draftPaymentSummary({ ...draft, amount: "", dueDate: "" }, NOW)
    ).toBe("중도금 3회차 · 금액 미입력 · 예정일 미입력");
    expect(draftPaymentSummary({ ...draft, amount: "3.5" }, NOW)).toBe(
      "중도금 3회차 · 금액 확인 필요 · 11월 20일"
    );
    expect(draftPaymentSummary({ ...draft, amount: "0" }, NOW)).toBe(
      "중도금 3회차 · 0원 · 11월 20일"
    );
    expect(
      draftPaymentSummary(
        {
          ...draft,
          kind: "option",
          installment: "",
          label: "발코니 확장 외 2 · 계약금",
        },
        NOW
      )
    ).toBe("발코니 확장 외 2 계약금 · 3,000,000원 · 11월 20일");
  });
});
