import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ManualAsset,
  ManualAssetSummary,
  ManualHousingPayment,
  ManualHousingPlan,
} from "@family/contracts";
import {
  assetDraft,
  assetRequest,
  savingsPlanLine,
  createManualSaveSession,
  displayManualKrw,
  hideManualSharedEditor,
  manualEditorUnavailable,
  manualFailureMessage,
  manualFailureRequiresRead,
  manualFinanceCanCreate,
  manualFinanceEditorContext,
  manualRecordVersionChanged,
  parseManualKrwInput,
  paymentDraft,
  planDraft,
  planRequest,
} from "./model";
import { ManualAssetsSummary } from "./asset-summary";

const id = "11111111-1111-4111-8111-111111111111",
  householdId = "22222222-2222-4222-8222-222222222222";
const summary: ManualAssetSummary = {
  currency: "KRW",
  grossAssets: null,
  debt: null,
  netAssets: null,
  assetsCompleteness: "empty",
  debtCompleteness: "empty",
  completeness: "empty",
  asOfDate: null,
  oldestAsOfDate: null,
  newestAsOfDate: null,
  mixedAsOfDates: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe("manual recorded values", () => {
  it("creates shared drafts while keeping amounts and dates unknown", () => {
    expect(assetDraft()).toEqual({
      kind: "account",
      label: "",
      visibility: "household",
      amount: "",
      asOfDate: "",
      legalOwnerLabel: "",
      note: "",
      autoSave: false,
      monthlyAmount: "",
      contributionDay: "",
      endDate: "",
    });
    expect(planDraft()).toEqual({
      label: "",
      visibility: "household",
      occupancyYear: "",
      contractStage: "",
      fundingNote: "",
      payments: [],
    });
    const sharedPlan = planRequest(
      { ...planDraft(), label: "합성 가족 계획" }, id, householdId
    );
    expect(sharedPlan.ok).toBe(true);
    if (sharedPlan.ok) expect(sharedPlan.body.visibility).toBe("household");
    expect(paymentDraft(id)).toEqual({
      id,
      kind: "contract",
      installment: "",
      dueDate: "",
      amount: "",
      paidAmount: "",
      paidDate: "",
      label: "",
      amountSource: null,
      amountAsOfAt: null,
      amountAsOfSeoul: null,
      paidAmountSource: null,
      paidAmountAsOfAt: null,
      paidAmountAsOfSeoul: null,
      remainingAmount: null,
      status: "unknown",
    });
  });
  it("preserves existing private asset and plan visibility through an edit request", () => {
    const asset = assetDraft({
      kind: "account",
      label: "합성 비공개 통장",
      visibility: "private",
      amount: null,
      asOfDate: null,
      legalOwnerLabel: null,
      note: null,
    } as ManualAsset);
    const plan = planDraft({
      label: "합성 비공개 계획",
      visibility: "private",
      occupancyYear: null,
      contractStage: null,
      fundingNote: null,
    } as ManualHousingPlan);
    expect(asset.visibility).toBe("private");
    expect(plan.visibility).toBe("private");
    const assetEdit = assetRequest({ ...asset, label: "합성 수정 통장" }, id, householdId);
    const planEdit = planRequest({ ...plan, label: "합성 수정 계획" }, id, householdId);
    expect(assetEdit.ok).toBe(true);
    expect(planEdit.ok).toBe(true);
    if (assetEdit.ok) expect(assetEdit.body.visibility).toBe("private");
    if (planEdit.ok) expect(planEdit.body.visibility).toBe("private");
  });
  it("disables creation in the legacy private view without removing existing editor permissions", () => {
    for (const role of ["owner", "admin", "member", "viewer", null, undefined])
      expect(manualFinanceCanCreate(role, "private")).toBe(false);
    expect(manualFinanceCanCreate("member", "household")).toBe(true);
    expect(manualFinanceCanCreate("viewer", "household")).toBe(false);
    expect(manualFinanceEditorContext(id, householdId, "private", "member")).toBe(
      `${id}/${householdId}/private/writer`
    );
  });
  it("distinguishes unknown and explicit zero and preserves 20-digit integer precision", () => {
    expect(parseManualKrwInput(" ")).toBeNull();
    expect(displayManualKrw(null)).toBe("— 원");
    expect(parseManualKrwInput("0")).toBe("0");
    expect(displayManualKrw("0")).toBe("0원");
    expect(parseManualKrwInput("99,999,999,999,999,999,999")).toBe(
      "99999999999999999999"
    );
    expect(displayManualKrw("99999999999999999999")).toBe(
      "99,999,999,999,999,999,999원"
    );
    expect(displayManualKrw("-9007199254740993")).toBe(
      "-9,007,199,254,740,993원"
    );
  });
  it.each([
    "-1",
    "1.5",
    "1e3",
    "01",
    "0,000",
    "1,00",
    "1 000",
    "100000000000000000000",
    "１２３",
    "NaN",
  ])("rejects %j instead of truncating or rounding", (amount) =>
    expect(parseManualKrwInput(amount)).toBeUndefined()
  );
  it("submits unknown asset values as null and never inserts a source or date", () => {
    const result = assetRequest(
      { ...assetDraft(), label: "합성 통장" },
      id,
      householdId
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.body).toMatchObject({
        id,
        householdId,
        amount: null,
        asOfDate: null,
        source: null,
        legalOwnerLabel: null,
        note: null,
        visibility: "household",
      });
  });
  it("requires actual as-of date for a recorded amount and rejects future or rollover dates", () => {
    const draft = {
      ...assetDraft(),
      label: "합성 통장",
      amount: "99999999999999999999",
    };
    for (const asOfDate of ["", "9999-01-01", "2020-02-30"])
      expect(assetRequest({ ...draft, asOfDate }, id, householdId).ok).toBe(
        false
      );
    const result = assetRequest(
      { ...draft, asOfDate: "2020-02-29" },
      id,
      householdId
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.amount).toBe("99999999999999999999");
    expect(
      assetRequest(
        { ...draft, amount: "", asOfDate: "2020-01-01" },
        id,
        householdId
      ).ok
    ).toBe(false);
  });
  it("keeps the writer separate from an unconfirmed legal owner label", () => {
    const result = assetRequest(
      { ...assetDraft(), label: "합성", legalOwnerLabel: "  " },
      id,
      householdId
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.legalOwnerLabel).toBeNull();
      expect(result.body).not.toHaveProperty("ownerUserId");
    }
  });
  it("carries every existing payment ID and unknown field into an update draft", () => {
    const item = {
      label: "합성 계획",
      visibility: "private",
      occupancyYear: null,
      contractStage: null,
      fundingNote: null,
    } as ManualHousingPlan;
    const payment = {
      id,
      planId: id,
      kind: "option",
      installment: null,
      dueDate: null,
      amount: null,
      paidAmount: null,
      paidDate: null,
    } as ManualHousingPayment;
    const result = planRequest(planDraft(item, [payment]), id, householdId);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.body).toMatchObject({
        occupancyYear: null,
        contractStage: null,
        fundingNote: null,
        payments: [
          {
            id,
            kind: "option",
            installment: null,
            amount: null,
            paidAmount: null,
            paidDate: null,
            dueDate: null,
          },
        ],
      });
  });
  it("requires known target and actual paid date before recording a positive payment", () => {
    const plan = {
      ...planDraft(),
      label: "합성 계획",
      payments: [
        {
          ...paymentDraft(id),
          amount: "100",
          paidAmount: "101",
          paidDate: "2020-01-01",
        },
      ],
    };
    expect(planRequest(plan, id, householdId).ok).toBe(false);
    expect(
      planRequest(
        {
          ...plan,
          payments: [{ ...plan.payments[0]!, paidAmount: "50", paidDate: "" }],
        },
        id,
        householdId
      ).ok
    ).toBe(false);
    expect(
      planRequest(
        {
          ...plan,
          payments: [
            { ...plan.payments[0]!, amount: "", paidAmount: "0", paidDate: "" },
          ],
        },
        id,
        householdId
      ).ok
    ).toBe(false);
    expect(
      planRequest(
        {
          ...plan,
          payments: [{ ...plan.payments[0]!, paidAmount: "0", paidDate: "" }],
        },
        id,
        householdId
      ).ok
    ).toBe(true);
  });
  it("accepts future planned due date but does not manufacture an occupancy year or paid status", () => {
    const result = planRequest(
      {
        ...planDraft(),
        label: "합성 계획",
        payments: [{ ...paymentDraft(id), dueDate: "2100-01-01" }],
      },
      id,
      householdId
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.occupancyYear).toBeNull();
      expect(result.body.payments[0]?.paidAmount).toBeNull();
      expect(result.body.payments[0]?.dueDate).toBe("2100-01-01");
    }
  });
  it("preserves existing asset zero and manual as-of facts without converting to today", () => {
    const draft = assetDraft({
      kind: "loan",
      label: "합성 원금",
      visibility: "household",
      amount: "0",
      asOfDate: "2020-01-01",
      legalOwnerLabel: null,
      note: null,
    } as ManualAsset);
    expect(draft.amount).toBe("0");
    expect(draft.asOfDate).toBe("2020-01-01");
    expect(draft.visibility).toBe("household");
  });
  it("renders absent values as unknown and marks incomplete or mixed snapshots", () => {
    const empty = renderToStaticMarkup(
      createElement(ManualAssetsSummary, { summary })
    );
    expect(empty).toContain("등록된 자산이 없어요");
    expect(empty).not.toContain("0원");
    expect(empty).not.toContain("— 원");
    const partial = renderToStaticMarkup(
      createElement(ManualAssetsSummary, {
        summary: {
          ...summary,
          grossAssets: "9007199254740993",
          assetsCompleteness: "partial",
          completeness: "partial",
          mixedAsOfDates: true,
          oldestAsOfDate: "2020-01-01",
          newestAsOfDate: "2020-01-03",
        },
      })
    );
    expect(partial).toContain("자산 (일부 입력)");
    expect(partial).toContain("항목별 기준일");
    expect(partial).toContain("미입력");
    expect(partial).toContain("9,007,199,254,740,993원"); // 입력된 값만으로 계산한 순자산(§8)
    expect(partial).not.toContain("— 원");
    expect(partial).not.toContain(">0원<");
    expect(partial).toContain("9,007,199,254,740,993원");
  });
  it("dismisses a revoked record without discarding an unrelated draft during a transient refresh", () => {
    const context = {
      error: null,
      id,
      visibleIds: [id],
      succeeded: true,
      refreshing: false,
    };
    expect(manualEditorUnavailable(context)).toBe(false);
    expect(manualEditorUnavailable({ ...context, visibleIds: [] })).toBe(true);
    expect(
      manualEditorUnavailable({ ...context, visibleIds: [], refreshing: true })
    ).toBe(false);
    expect(
      manualEditorUnavailable({
        ...context,
        visibleIds: [],
        succeeded: false,
        refreshing: true,
        cacheCleared: true,
      })
    ).toBe(true);
    expect(
      manualEditorUnavailable({
        ...context,
        visibleIds: [],
        succeeded: false,
        error: new TypeError("synthetic network"),
      })
    ).toBe(false);
    expect(
      manualEditorUnavailable({ ...context, id: null, visibleIds: [] })
    ).toBe(false);
    expect(
      manualEditorUnavailable({ ...context, error: { status: 403 } })
    ).toBe(true);
    expect(
      manualEditorUnavailable({ ...context, error: { status: 404 } })
    ).toBe(true);
  });
  it("preserves the writer's dirty public asset and housing drafts across an unrelated shared-record hint", () => {
    const actorUserId = "33333333-3333-4333-8333-333333333333";
    const own = { visibility: "household" as const, ownerUserId: actorUserId };
    const asset = Object.freeze({
      ...assetDraft(),
      label: "합성 수정 중",
      visibility: "household" as const,
      amount: "200",
      asOfDate: "2020-01-01",
    });
    const plan = Object.freeze({
      ...planDraft(),
      label: "합성 계획 수정 중",
      visibility: "household" as const,
      fundingNote: "저장 전 합성 메모",
    });
    const before = JSON.stringify({ asset, plan });
    const hide = hideManualSharedEditor({
      item: own,
      actorUserId,
      pending: true,
      hasData: false,
    });
    expect(hide).toBe(false);
    expect(
      manualEditorUnavailable({
        id,
        error: null,
        visibleIds: [],
        succeeded: false,
        refreshing: true,
        cacheCleared: hide,
      })
    ).toBe(false);
    expect(
      manualEditorUnavailable({
        id,
        error: null,
        visibleIds: [id, householdId],
        succeeded: true,
        refreshing: false,
      })
    ).toBe(false);
    expect(manualRecordVersionChanged(2, undefined)).toBe(false);
    expect(manualRecordVersionChanged(2, 2)).toBe(false);
    expect(JSON.stringify({ asset, plan })).toBe(before);
  });
  it("hides only another writer's shared details during reset and leaves private or new drafts unaffected", () => {
    const context = { actorUserId: id, pending: true, hasData: false };
    expect(
      hideManualSharedEditor({
        ...context,
        item: { visibility: "household", ownerUserId: householdId },
      })
    ).toBe(true);
    expect(
      hideManualSharedEditor({
        ...context,
        item: { visibility: "household", ownerUserId: id },
      })
    ).toBe(false);
    expect(
      hideManualSharedEditor({
        ...context,
        item: { visibility: "private", ownerUserId: id },
      })
    ).toBe(false);
    expect(hideManualSharedEditor({ ...context, item: null })).toBe(false);
    expect(
      hideManualSharedEditor({
        ...context,
        item: { visibility: "household", ownerUserId: householdId },
        hasData: true,
      })
    ).toBe(false);
  });
  it("gates a newer record version without replacing the draft or treating an older list as newer", () => {
    expect(manualRecordVersionChanged(2, 3)).toBe(true);
    expect(manualRecordVersionChanged(3, 3)).toBe(false);
    expect(manualRecordVersionChanged(3, 2)).toBe(false);
    expect(manualRecordVersionChanged(null, 3)).toBe(false);
    const draft = assetDraft();
    draft.label = "합성 입력 유지";
    expect(manualRecordVersionChanged(2, 3)).toBe(true);
    expect(draft.label).toBe("합성 입력 유지");
  });
  it("keeps viewers and unconfirmed roles read-only and invalidates an existing writer editor on permission loss", () => {
    for (const role of ["owner", "admin", "member"])
      expect(manualFinanceCanCreate(role)).toBe(true);
    for (const role of ["viewer", null, undefined, "other"])
      expect(manualFinanceCanCreate(role)).toBe(false);
    const writer = manualFinanceEditorContext(
      id,
      householdId,
      "household",
      "member"
    );
    expect(
      manualFinanceEditorContext(id, householdId, "household", "viewer")
    ).not.toBe(writer);
    expect(
      manualFinanceEditorContext(id, householdId, "household", null)
    ).not.toBe(writer);
    expect(
      manualFinanceEditorContext(id, householdId, "household", "admin")
    ).toBe(writer);
    expect(
      manualFinanceEditorContext(id, householdId, "household", "owner")
    ).toBe(writer);
    expect(
      manualFinanceEditorContext(id, householdId, "private", "member")
    ).not.toBe(writer);
  });
});

describe("manual save lifetime", () => {
  it("claims synchronously so repeated clicks send one request", async () => {
    const task = deferred<string>(),
      session = createManualSaveSession(),
      request = vi.fn(() => task.promise),
      saved = vi.fn(),
      failed = vi.fn();
    const first = session.run(request, saved, failed);
    expect(session.pending).toBe(true);
    expect(await session.run(request, saved, failed)).toBe("busy");
    expect(request).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
    task.resolve("record");
    expect(await first).toBe("saved");
    expect(saved).toHaveBeenCalledWith("record");
    expect(session.pending).toBe(false);
  });
  it("does not change failed input and invalidates success and failure after scope or account change", async () => {
    const draft = Object.freeze({ amount: "100", asOfDate: "2020-01-01" }),
      session = createManualSaveSession(),
      saved = vi.fn(),
      failed = vi.fn();
    const first = deferred<string>();
    const promise = session.run(() => first.promise, saved, failed);
    session.invalidate();
    first.resolve("old family");
    expect(await promise).toBe("stale");
    expect(saved).not.toHaveBeenCalled();
    const second = deferred<string>();
    const next = session.run(() => second.promise, saved, failed);
    session.invalidate();
    second.reject(new Error("old failure"));
    expect(await next).toBe("stale");
    expect(failed).not.toHaveBeenCalled();
    expect(draft.amount).toBe("100");
    expect(await session.run(async () => "new session", saved, failed)).toBe(
      "saved"
    );
  });
  it("requires current-read for unknown, conflict and permission failure, with no payload text leak", () => {
    for (const error of [
      new TypeError("synthetic secret"),
      { status: 409 },
      { status: 403 },
      { status: 404 },
      { status: 500 },
    ])
      expect(manualFailureRequiresRead(error)).toBe(true);
    expect(manualFailureRequiresRead({ status: 400 })).toBe(false);
    expect(
      manualFailureMessage({
        status: 409,
        body: { sensitive: "SYNTHETIC_PRIVATE" },
      })
    ).not.toContain("SYNTHETIC_PRIVATE");
    expect(manualFailureMessage(new Error("SYNTHETIC_PRIVATE"))).not.toContain(
      "SYNTHETIC_PRIVATE"
    );
  });
});

describe("적금 자동 납입 입력", () => {
  const saving = {
    ...assetDraft(),
    kind: "saving" as const,
    label: "합성 적금",
    amount: "1,000,000",
    asOfDate: "2026-01-01",
    autoSave: true,
    monthlyAmount: "500,000",
    contributionDay: "15",
    endDate: "",
  };

  it("적금이면 매월 넣는 날·금액·만기일을 요청에 싣는다", () => {
    const result = assetRequest(saving, id, householdId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.savingsPlan).toEqual({ monthlyAmount: "500000", day: 15, endDate: null });
      expect(result.body.amount).toBe("1000000");
      // 편집용 필드가 strict 요청에 새지 않는다.
      expect(Object.keys(result.body)).not.toContain("autoSave");
    }
    const ended = assetRequest({ ...saving, endDate: "2027-06-30" }, id, householdId);
    expect(ended.ok && ended.body.savingsPlan?.endDate).toBe("2027-06-30");
  });

  it("끄거나 적금이 아니면 계획을 지운다(null)", () => {
    for (const draft of [{ ...saving, autoSave: false }, { ...saving, kind: "account" as const }]) {
      const result = assetRequest(draft, id, householdId);
      expect(result.ok && result.body.savingsPlan).toBeNull();
    }
  });

  it("금액·날·기준 금액이 없으면 이유를 말하고 막는다", () => {
    expect(assetRequest({ ...saving, monthlyAmount: "0" }, id, householdId)).toMatchObject({ ok: false, message: expect.stringContaining("1원 이상") });
    expect(assetRequest({ ...saving, contributionDay: "" }, id, householdId)).toMatchObject({ ok: false, message: expect.stringContaining("넣는 날") });
    expect(assetRequest({ ...saving, amount: "", asOfDate: "" }, id, householdId)).toMatchObject({ ok: false, message: expect.stringContaining("현재 적립액과 기준일") });
  });

  it("저장된 계획을 편집 초안으로 되살리고 목록 부제를 만든다", () => {
    const plan = { monthlyAmount: "500000", day: 15, endDate: null, baseAmount: "1000000", baseAsOfDate: "2026-01-01", contributions: 10 };
    const draft = assetDraft({ ...({} as ManualAsset), kind: "saving", label: "합성 적금", visibility: "household", amount: "6000000", asOfDate: "2026-10-15", legalOwnerLabel: null, note: null, savingsPlan: plan });
    expect(draft).toMatchObject({ amount: "6000000", asOfDate: "2026-10-15", autoSave: true, monthlyAmount: "500000", contributionDay: "15", endDate: "" });
    expect(savingsPlanLine(plan)).toBe("매월 15일 +500,000원");
    expect(savingsPlanLine(undefined)).toBeNull();
  });
});
