import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportedLoanRecord, LoanImportCommitRequest, ManualAsset, ShinhanLoanCapture } from "@family/contracts";
import { apiFetch } from "./api-client";
import { loanImportApi, loanImportKeys } from "./loan-import-client";

vi.mock("./api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("./auth-context", () => ({ useAuth: vi.fn() }));
vi.mock("./household-context", () => ({ useHousehold: vi.fn() }));

const householdId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const capture: ShinhanLoanCapture = {
  formatVersion: 1, provider: "shinhan", source: "browser_assisted",
  origin: "https://bank.shinhan.com", pageKind: "loan_account_list",
  capturedAt: "2020-01-01T00:00:00Z", accountFingerprint: "a".repeat(64), accountLast4: "1234",
  loanType: "jeonse", outstandingPrincipalKrw: "99999999999999999999", maturityDate: "2030-01-01", bankAsOfDate: null,
};
const item: ImportedLoanRecord = {
  id: recordId, householdId, ownerUserId: userId, version: 1,
  label: "합성 전세 대출", visibility: "private", totalMode: "reference",
  replacesManualAssetId: null, manualExpectedVersion: null,
  accountLast4: capture.accountLast4, loanType: capture.loanType,
  outstandingPrincipalKrw: capture.outstandingPrincipalKrw, maturityDate: capture.maturityDate,
  capturedAt: capture.capturedAt, bankAsOfDate: null, source: "shinhan_browser", canEdit: true,
  includedInTotals: false, exclusionReason: "reference", createdAt: capture.capturedAt, updatedAt: capture.capturedAt,
};
const manual: ManualAsset = {
  id: otherId, householdId, ownerUserId: userId, version: 3, kind: "loan", visibility: "private",
  label: "합성 수동 대출", amount: "100", asOfDate: "2020-01-01", source: "manual", currency: "KRW",
  legalOwnerLabel: null, note: null, createdAt: capture.capturedAt, updatedAt: capture.capturedAt, canEdit: true,
};
const summary = {
  currency: "KRW", grossAssets: null, debt: null, netAssets: null,
  assetsCompleteness: "empty", debtCompleteness: "empty", completeness: "empty",
  asOfDate: null, oldestAsOfDate: null, newestAsOfDate: null, mixedAsOfDates: false,
};
const body: LoanImportCommitRequest = {
  requestId: otherId, recordId, householdId, expectedVersion: null, capture,
  confirmedOwnAccount: true, confirmedValues: true, label: item.label,
  visibility: "private", totalMode: "reference", replacesManualAssetId: null, manualExpectedVersion: null,
  confirmedSharing: false,
};
afterEach(() => vi.mocked(apiFetch).mockReset());

describe("loan import scoped client", () => {
  it("isolates owner, family and visibility caches while sharing manual invalidation", () => {
    const keys = [
      loanImportKeys.overview(householdId, userId, "private"),
      loanImportKeys.overview(householdId, userId, "household"),
      loanImportKeys.overview(householdId, otherId, "private"),
      loanImportKeys.overview(otherId, userId, "private"),
      loanImportKeys.records(householdId, userId),
    ];
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(keys.length);
    expect(keys.every((key) => key[0] === "manual-finance")).toBe(true);
    expect(keys[1]?.[3]).toBe("household");
  });
  it("previews only the fixed capture body and validates owner replacement options", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ capture, existing: item, replacementOptions: [manual] });
    const signal = new AbortController().signal;
    const result = await loanImportApi.preview(null, { householdId, capture }, userId, signal);
    expect(result.capture.outstandingPrincipalKrw).toBe("99999999999999999999");
    expect(apiFetch).toHaveBeenCalledWith("/v1/loan-imports/preview", {
      accessToken: null, method: "POST", body: { householdId, capture }, signal,
    });
    vi.mocked(apiFetch).mockResolvedValue({ capture, existing: item, replacementOptions: [{ ...manual, ownerUserId: otherId }] });
    await expect(loanImportApi.preview(null, { householdId, capture }, userId)).rejects.toThrow("context mismatch");
    vi.mocked(apiFetch).mockResolvedValue({ capture, existing: item, replacementOptions: [{ ...manual, kind: "account" }] });
    await expect(loanImportApi.preview(null, { householdId, capture }, userId)).rejects.toThrow("replacement mismatch");
    vi.mocked(apiFetch).mockResolvedValue({ capture: { ...capture, accountLast4: "4321" }, existing: null, replacementOptions: [] });
    await expect(loanImportApi.preview(null, { householdId, capture }, userId)).rejects.toThrow("capture mismatch");
  });
  it("preserves exact amounts and stable record/request IDs across identical retries", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("synthetic offline")).mockResolvedValueOnce({ item });
    const signal = new AbortController().signal;
    await expect(loanImportApi.commit(null, body, userId, signal)).rejects.toThrow("synthetic offline");
    const result = await loanImportApi.commit(null, body, userId, signal);
    expect(result.item.outstandingPrincipalKrw).toBe(capture.outstandingPrincipalKrw);
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/v1/loan-imports/commit", { accessToken: null, method: "POST", body, signal });
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/v1/loan-imports/commit", { accessToken: null, method: "POST", body, signal });
  });
  it("validates explicit confirmations before sending a mutation", async () => {
    await expect(loanImportApi.commit(null, { ...body, confirmedOwnAccount: false } as unknown as LoanImportCommitRequest, userId)).rejects.toThrow();
    await expect(loanImportApi.commit(null, { ...body, visibility: "household", confirmedSharing: false }, userId)).rejects.toThrow();
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it("rejects foreign records and wrong mutation IDs before exposing data", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ items: [{ ...item, ownerUserId: otherId }] });
    await expect(loanImportApi.records(null, householdId, userId)).rejects.toThrow("context mismatch");
    vi.mocked(apiFetch).mockResolvedValue({ items: [{ ...item, householdId: otherId }] });
    await expect(loanImportApi.records(null, householdId, userId)).rejects.toThrow("context mismatch");
    vi.mocked(apiFetch).mockResolvedValue({ item: { ...item, id: otherId } });
    await expect(loanImportApi.commit(null, body, userId)).rejects.toThrow("record mismatch");
  });
  it("sends server scope for combined overview and rejects out-of-scope values", async () => {
    const signal = new AbortController().signal;
    vi.mocked(apiFetch).mockResolvedValue({ manualItems: [manual], loanItems: [item], summary, unresolvedLoans: 0 });
    await loanImportApi.overview(null, householdId, userId, "private", signal);
    expect(apiFetch).toHaveBeenCalledWith(`/v1/financial-overview?householdId=${householdId}&scope=private`, { accessToken: null, signal });
    await expect(loanImportApi.overview(null, householdId, userId, "household")).rejects.toThrow("context mismatch");
    await expect(loanImportApi.overview(null, householdId, otherId, "private")).rejects.toThrow("context mismatch");
  });
  it("uses record-only versioned metadata and delete endpoints", async () => {
    const update = { expectedVersion: 1, label: item.label, visibility: item.visibility, totalMode: item.totalMode, replacesManualAssetId: null, manualExpectedVersion: null, confirmedSharing: false };
    const signal = new AbortController().signal;
    vi.mocked(apiFetch).mockResolvedValueOnce({ item }).mockResolvedValueOnce({ deleted: true });
    await loanImportApi.update(null, householdId, userId, recordId, update, signal);
    expect(apiFetch).toHaveBeenLastCalledWith(`/v1/loan-imports/records/${recordId}?householdId=${householdId}`, { accessToken: null, method: "PATCH", body: update, signal });
    await loanImportApi.remove(null, householdId, recordId, 1, signal);
    expect(apiFetch).toHaveBeenLastCalledWith(`/v1/loan-imports/records/${recordId}?householdId=${householdId}`, { accessToken: null, method: "DELETE", body: { expectedVersion: 1 }, signal });
  });
  it("aborts before a token refresh can send stale work and rejects a late response", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loanImportApi.commit(null, body, userId, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(apiFetch).not.toHaveBeenCalled();
    const late = new AbortController();
    vi.mocked(apiFetch).mockImplementation(async () => { late.abort(); return { items: [item] }; });
    await expect(loanImportApi.records(null, householdId, userId, late.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
