import { describe, expect, it, vi } from "vitest";
import type { ImportedLoanRecord, ManualAsset, ShinhanLoanCapture } from "@family/contracts";
import {
  LOAN_CAPTURE_MAX_BYTES,
  LOAN_EXCLUSION_LABELS,
  createLoanTaskSession,
  loanFailureMessage,
  loanReviewDraft,
  loanReviewFields,
  matchingReplacementOptions,
  parseLoanCapture,
  readLoanCaptureFile,
} from "./model";

const householdId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const capture: ShinhanLoanCapture = {
  formatVersion: 1,
  provider: "shinhan",
  source: "browser_assisted",
  origin: "https://bank.shinhan.com",
  pageKind: "loan_account_list",
  capturedAt: "2020-01-01T00:00:00Z",
  accountFingerprint: "a".repeat(64),
  accountLast4: "1234",
  loanType: "jeonse",
  outstandingPrincipalKrw: "99999999999999999999",
  maturityDate: "2032-02-29",
  bankAsOfDate: null,
};
const manualLoan: ManualAsset = {
  id: recordId,
  householdId,
  ownerUserId: userId,
  version: 7,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z",
  canEdit: true,
  kind: "loan",
  visibility: "private",
  label: "합성 대출",
  amount: "100",
  currency: "KRW",
  asOfDate: "2020-01-01",
  source: "manual",
  legalOwnerLabel: null,
  note: null,
};
const importedLoan: ImportedLoanRecord = {
  id: recordId,
  householdId,
  ownerUserId: userId,
  version: 2,
  label: "합성 가져온 대출",
  visibility: "household",
  totalMode: "replacement",
  replacesManualAssetId: otherId,
  manualExpectedVersion: 7,
  accountLast4: capture.accountLast4,
  loanType: capture.loanType,
  outstandingPrincipalKrw: capture.outstandingPrincipalKrw,
  maturityDate: capture.maturityDate,
  capturedAt: capture.capturedAt,
  bankAsOfDate: null,
  source: "shinhan_browser",
  canEdit: true,
  includedInTotals: true,
  exclusionReason: null,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("fixed synthetic loan capture JSON", () => {
  it("preserves exact string principal, observed time, and an explicitly unknown bank date", () => {
    expect(parseLoanCapture(JSON.stringify(capture))).toEqual(capture);
    expect(parseLoanCapture(JSON.stringify({ ...capture, outstandingPrincipalKrw: "0", maturityDate: null }))).toMatchObject({
      outstandingPrincipalKrw: "0", maturityDate: null, bankAsOfDate: null,
    });
  });

  it.each(["password", "accountNumber", "fullAccountNumber", "cookie", "html", "__proto__"])(
    "rejects the unexpected %s field without including its value in the error",
    (field) => {
      const text = JSON.stringify({ ...capture, [field]: "SYNTHETIC_PRIVATE_VALUE" });
      expect(() => parseLoanCapture(text)).toThrow("지원하는 신한 대출 확인 파일이 아니에요");
      try { parseLoanCapture(text); } catch (error) {
        expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
      }
    }
  );

  it.each([100, null, "-1", "1.5", "1e3", "01", "1,000", "100000000000000000000"])(
    "rejects malformed or non-string principal %j",
    (outstandingPrincipalKrw) => {
      expect(() => parseLoanCapture(JSON.stringify({ ...capture, outstandingPrincipalKrw }))).toThrow("지원하는 신한 대출 확인 파일이 아니에요");
    }
  );

  it.each(["2031-02-29", "2032-02-30", "2032-13-01", "0000-01-01", "2032/02/29", ""])(
    "rejects invalid maturity %j instead of rolling it forward",
    (maturityDate) => {
      expect(() => parseLoanCapture(JSON.stringify({ ...capture, maturityDate }))).toThrow();
    }
  );

  it.each([
    { formatVersion: 2 },
    { provider: "other" },
    { source: "automatic" },
    { origin: "https://example.invalid" },
    { pageKind: "other" },
    { accountFingerprint: "not-a-fingerprint" },
    { accountLast4: "12345" },
    { capturedAt: "2020-01-01" },
    { loanType: "other" },
    { bankAsOfDate: "2020-01-01" },
  ])("requires the collector's fixed contract for %j", (change) => {
    expect(() => parseLoanCapture(JSON.stringify({ ...capture, ...change }))).toThrow();
  });

  it.each(["", "<html>synthetic</html>", "{", "null", "[]", "{}"])("rejects non-capture input %j", (text) => {
    expect(() => parseLoanCapture(text)).toThrow();
  });

  it("rejects repeated keys, including escape-equivalent keys, before a last value can win", () => {
    const valid = JSON.stringify(capture);
    for (const extra of [
      '"accountLast4":"1234"',
      '"accountLast\\u0034":"1234"',
      '"outstandingPrincipalKrw":"0"',
      '"\\u006futstandingPrincipalKrw":"0"',
    ]) {
      expect(() => parseLoanCapture(`${valid.slice(0, -1)},${extra}}`)).toThrow("JSON 형식이 올바르지 않아요");
    }
  });

  it("allows exactly 64 KiB and rejects the next byte before parsing", () => {
    const valid = JSON.stringify(capture);
    const exact = valid + " ".repeat(LOAN_CAPTURE_MAX_BYTES - new TextEncoder().encode(valid).length);
    expect(new TextEncoder().encode(exact).byteLength).toBe(64 * 1024);
    expect(parseLoanCapture(exact)).toEqual(capture);
    expect(() => parseLoanCapture(exact + " ")).toThrow("64KB 이하");
  });

  it("enforces UTF-8 byte length rather than JavaScript character count", () => {
    const text = JSON.stringify({ ...capture, unexpected: "가".repeat(22_000) });
    expect(text.length).toBeLessThan(LOAN_CAPTURE_MAX_BYTES);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(LOAN_CAPTURE_MAX_BYTES);
    expect(() => parseLoanCapture(text)).toThrow("64KB 이하");
  });
});

describe("bounded cancellable file reads", () => {
  it("rejects an oversized file before reading its content", async () => {
    const text = vi.fn(async () => JSON.stringify(capture));
    await expect(readLoanCaptureFile({ size: LOAN_CAPTURE_MAX_BYTES + 1, text }, new AbortController().signal)).rejects.toThrow("64KB 이하");
    expect(text).not.toHaveBeenCalled();
  });

  it("checks the read text size even if the supplied file size is smaller", async () => {
    const text = vi.fn(async () => " ".repeat(LOAN_CAPTURE_MAX_BYTES + 1));
    await expect(readLoanCaptureFile({ size: 1, text }, new AbortController().signal)).rejects.toThrow("64KB 이하");
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("accepts a bounded file and preserves the captured values", async () => {
    const value = JSON.stringify(capture);
    const text = vi.fn(async () => value);
    await expect(readLoanCaptureFile({ size: new TextEncoder().encode(value).length, text }, new AbortController().signal)).resolves.toEqual(capture);
  });

  it("stops an already-cancelled read before invoking file.text", async () => {
    const controller = new AbortController();
    controller.abort();
    const text = vi.fn(async () => JSON.stringify(capture));
    await expect(readLoanCaptureFile({ size: 1, text }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(text).not.toHaveBeenCalled();
  });

  it("does not parse or return content after cancellation while file.text is pending", async () => {
    const controller = new AbortController();
    const read = deferred<string>();
    const text = vi.fn(() => read.promise);
    const pending = readLoanCaptureFile({ size: 1, text }, controller.signal);
    controller.abort();
    read.resolve("invalid JSON which must never be parsed");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(text).toHaveBeenCalledTimes(1);
  });
});

describe("loan review defaults and replacement ownership", () => {
  it("explains duplicate exclusion without claiming another record was counted", () => {
    const duplicate: ImportedLoanRecord = { ...importedLoan, includedInTotals: false, exclusionReason: "duplicate_visible_loan" };
    const label = LOAN_EXCLUSION_LABELS[duplicate.exclusionReason!];
    expect(label).toBe("같은 계좌의 기록이 겹쳐 합계에서 제외됐어요. 중복 기록을 확인해 주세요.");
    expect(label).not.toContain("다른 기록이 합산");
  });

  it("starts new captures as private references without implicit sharing approval", () => {
    expect(loanReviewDraft(undefined, capture)).toEqual({
      label: "신한 전세 대출", visibility: "private", totalMode: "reference", replacesManualAssetId: "", confirmedSharing: false,
    });
    expect(loanReviewDraft(undefined, { ...capture, loanType: "interim" }).label).toBe("신한 중도금 대출");
  });

  it("retains saved metadata while requiring sharing confirmation again", () => {
    expect(loanReviewDraft(importedLoan)).toEqual({
      label: importedLoan.label, visibility: "household", totalMode: "replacement", replacesManualAssetId: otherId, confirmedSharing: false,
    });
  });

  it("offers only editable loans owned by the current actor in the same household and visibility", () => {
    const options: ManualAsset[] = [
      manualLoan,
      { ...manualLoan, id: otherId, ownerUserId: otherId },
      { ...manualLoan, id: otherId, householdId: otherId },
      { ...manualLoan, id: otherId, visibility: "household" },
      { ...manualLoan, id: otherId, kind: "account" },
      { ...manualLoan, id: otherId, canEdit: false },
    ];
    expect(matchingReplacementOptions(options, userId, householdId, "private")).toEqual([manualLoan]);
    expect(matchingReplacementOptions(options, userId, householdId, "household")).toEqual([options[3]]);
  });

  it("pins a chosen valid replacement to its current version", () => {
    const draft = { ...loanReviewDraft(), label: "  합성 연결 대출  ", totalMode: "replacement" as const, replacesManualAssetId: recordId };
    expect(loanReviewFields(draft, [manualLoan], userId, householdId)).toEqual({
      label: "합성 연결 대출", visibility: "private", totalMode: "replacement", replacesManualAssetId: recordId, manualExpectedVersion: 7, confirmedSharing: false,
    });
    expect(loanReviewFields({ ...draft, visibility: "household" }, [manualLoan], userId, householdId)).toMatchObject({
      replacesManualAssetId: null, manualExpectedVersion: null,
    });
  });

  it("clears stale replacement identifiers for reference and distinct modes", () => {
    for (const totalMode of ["reference", "distinct"] as const) {
      expect(loanReviewFields({ ...loanReviewDraft(), totalMode, replacesManualAssetId: recordId }, [manualLoan], userId, householdId)).toMatchObject({
        totalMode, replacesManualAssetId: null, manualExpectedVersion: null,
      });
    }
  });
});

describe("loan task lifetime", () => {
  it("claims the pending lock synchronously so repeated clicks send one request", async () => {
    const session = createLoanTaskSession();
    const task = deferred<string>();
    const request = vi.fn((_signal: AbortSignal) => task.promise);
    const publish = vi.fn();
    const fail = vi.fn();
    const first = session.run(request, publish, fail);
    expect(session.pending).toBe(true);
    await expect(session.run(request, publish, fail)).resolves.toBe("busy");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    task.resolve("synthetic record");
    await expect(first).resolves.toBe("saved");
    expect(publish).toHaveBeenCalledWith("synthetic record");
    expect(fail).not.toHaveBeenCalled();
    expect(session.pending).toBe(false);
  });

  it("aborts before a late success can publish and permits a fresh context immediately", async () => {
    const session = createLoanTaskSession();
    const oldTask = deferred<string>();
    let oldSignal: AbortSignal | undefined;
    const publish = vi.fn();
    const fail = vi.fn();
    const old = session.run((signal) => { oldSignal = signal; return oldTask.promise; }, publish, fail);
    session.invalidate();
    expect(oldSignal?.aborted).toBe(true);
    expect(session.pending).toBe(false);
    const newTask = deferred<string>();
    const current = session.run(() => newTask.promise, publish, fail);
    oldTask.resolve("old household");
    await expect(old).resolves.toBe("stale");
    expect(session.pending).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    newTask.resolve("current household");
    await expect(current).resolves.toBe("saved");
    expect(publish).toHaveBeenCalledExactlyOnceWith("current household");
    expect(fail).not.toHaveBeenCalled();
  });

  it("suppresses an old rejection after cancellation without unlocking the newer request", async () => {
    const session = createLoanTaskSession();
    const oldTask = deferred<string>();
    const publish = vi.fn();
    const fail = vi.fn();
    const old = session.run(() => oldTask.promise, publish, fail);
    session.invalidate();
    const currentTask = deferred<string>();
    const current = session.run(() => currentTask.promise, publish, fail);
    oldTask.reject(new Error("SYNTHETIC_OLD_FAILURE"));
    await expect(old).resolves.toBe("stale");
    expect(session.pending).toBe(true);
    expect(fail).not.toHaveBeenCalled();
    currentTask.resolve("current");
    await expect(current).resolves.toBe("saved");
    expect(publish).toHaveBeenCalledExactlyOnceWith("current");
  });

  it("suppresses an already-resolved promise when invalidated before its continuation", async () => {
    const session = createLoanTaskSession();
    const publish = vi.fn();
    const fail = vi.fn();
    const task = session.run(async () => "old preview", publish, fail);
    session.invalidate();
    await expect(task).resolves.toBe("stale");
    expect(publish).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("publishes an active failure once and releases the lock for an explicit retry", async () => {
    const session = createLoanTaskSession();
    const error = new Error("SYNTHETIC_FAILURE");
    const publish = vi.fn();
    const fail = vi.fn();
    await expect(session.run(async () => { throw error; }, publish, fail)).resolves.toBe("failed");
    expect(fail).toHaveBeenCalledExactlyOnceWith(error);
    expect(session.pending).toBe(false);
    await expect(session.run(async () => "retry", publish, fail)).resolves.toBe("saved");
    expect(publish).toHaveBeenCalledExactlyOnceWith("retry");
  });

  it("keeps response payload and exception text out of user-visible errors", () => {
    for (const error of [new Error("SYNTHETIC_PRIVATE_VALUE"), { status: 409, body: "SYNTHETIC_PRIVATE_VALUE" }, { status: 403 }, { status: 422 }]) {
      expect(loanFailureMessage(error)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    }
  });
});
