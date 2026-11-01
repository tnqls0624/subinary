import {
  shinhanLoanCaptureSchema,
  type ImportedLoanRecord,
  type LoanTotalMode,
  type ManualAsset,
  type ShinhanLoanCapture,
} from "@family/contracts";

export const LOAN_CAPTURE_MAX_BYTES = 64 * 1024;

/** Only the collector's fixed, flat JSON schema is accepted; HTML and extra fields fail closed. */
export function parseLoanCapture(text: string): ShinhanLoanCapture {
  if (new TextEncoder().encode(text).byteLength > LOAN_CAPTURE_MAX_BYTES)
    throw new Error("파일은 64KB 이하만 선택할 수 있어요.");
  let value: unknown;
  try {
    value = JSON.parse(text);
    // Capture values are primitives. Tokenizing every JSON string avoids hiding duplicate
    // field names behind escapes, or accidentally treating a colon inside a value as a key.
    const strings = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g;
    const keys = new Set<string>();
    for (const token of text.matchAll(strings)) {
      if (!/^\s*:/.test(text.slice(token.index! + token[0].length))) continue;
      const key = JSON.parse(token[0]) as string;
      if (keys.has(key)) throw new Error("duplicate key");
      keys.add(key);
    }
  } catch {
    throw new Error("확인 파일의 JSON 형식이 올바르지 않아요. 파일을 다시 만들어 주세요.");
  }
  const result = shinhanLoanCaptureSchema.safeParse(value);
  if (!result.success) throw new Error("지원하는 신한 대출 확인 파일이 아니에요. 수집 도구에서 만든 JSON 파일을 선택해 주세요.");
  return result.data;
}

export async function readLoanCaptureFile(file: Pick<File, "size" | "text">, signal: AbortSignal) {
  signal.throwIfAborted();
  if (file.size > LOAN_CAPTURE_MAX_BYTES) throw new Error("파일은 64KB 이하만 선택할 수 있어요.");
  const text = await file.text();
  signal.throwIfAborted();
  return parseLoanCapture(text);
}

export interface LoanReviewDraft {
  label: string;
  visibility: "private" | "household";
  totalMode: LoanTotalMode;
  replacesManualAssetId: string;
  confirmedSharing: boolean;
}
export function loanReviewDraft(item?: ImportedLoanRecord, capture?: ShinhanLoanCapture): LoanReviewDraft {
  return {
    label: item?.label ?? (capture?.loanType === "interim" ? "신한 중도금 대출" : "신한 전세 대출"),
    visibility: item?.visibility ?? "private",
    totalMode: item?.totalMode ?? "reference",
    replacesManualAssetId: item?.replacesManualAssetId ?? "",
    confirmedSharing: false,
  };
}
export function matchingReplacementOptions(options: ManualAsset[], userId: string, householdId: string, visibility: "private" | "household") {
  return options.filter((item) => item.kind === "loan" && item.canEdit && item.ownerUserId === userId && item.householdId === householdId && item.visibility === visibility);
}
export function loanReviewFields(draft: LoanReviewDraft, options: ManualAsset[], userId: string, householdId: string) {
  const replacement = draft.totalMode === "replacement"
    ? matchingReplacementOptions(options, userId, householdId, draft.visibility).find((item) => item.id === draft.replacesManualAssetId)
    : undefined;
  return {
    label: draft.label.trim(), visibility: draft.visibility, totalMode: draft.totalMode,
    replacesManualAssetId: replacement?.id ?? null,
    manualExpectedVersion: replacement?.version ?? null,
    confirmedSharing: draft.confirmedSharing,
  };
}
export const LOAN_TOTAL_LABELS: Record<LoanTotalMode, string> = {
  reference: "참고만 하기 · 합계 제외", distinct: "별도 대출로 합산", replacement: "기존 수동 대출 대신 합산",
};
export const LOAN_EXCLUSION_LABELS: Record<NonNullable<ImportedLoanRecord["exclusionReason"]>, string> = {
  reference: "참고 기록이라 합계에서 제외돼요.",
  replacement_changed: "연결한 수동 대출이 바뀌어 합계에서 제외돼요. 연결을 다시 확인해 주세요.",
  duplicate_visible_loan: "같은 계좌의 기록이 겹쳐 합계에서 제외됐어요. 중복 기록을 확인해 주세요.",
  sharing_expired: "공유 상태가 바뀌어 합계에서 제외돼요.",
};
export function displayLoanCapturedAt(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}
export function loanFailureStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
}
export function loanFailureMessage(error: unknown): string {
  const status = loanFailureStatus(error);
  if (status === 409) return "기록이나 연결할 대출이 바뀌었어요. 저장된 내용을 다시 확인해 주세요.";
  if (status === 403 || status === 404) return "기록이 없거나 권한이 바뀌었어요. 목록을 다시 확인해 주세요.";
  if (status === 400 || status === 422) return "입력값과 공개 범위, 연결할 대출을 다시 확인해 주세요.";
  return "저장 결과를 확인하지 못했어요. 같은 요청으로 재확인하거나 저장된 내용을 불러와 주세요.";
}

/** Synchronous pending lock plus a monotonic epoch; invalidation precedes every publish. */
export function createLoanTaskSession() {
  let epoch = 0;
  let active: AbortController | null = null;
  return {
    get pending() { return active !== null; },
    invalidate() { ++epoch; active?.abort(); active = null; },
    async run<T>(request: (signal: AbortSignal) => Promise<T>, publish: (result: T) => void, fail: (error: unknown) => void) {
      if (active) return "busy" as const;
      const controller = new AbortController();
      const revision = epoch;
      active = controller;
      try {
        const result = await request(controller.signal);
        if (epoch !== revision || active !== controller || controller.signal.aborted) return "stale" as const;
        active = null;
        publish(result);
        return "saved" as const;
      } catch (error) {
        if (epoch !== revision || active !== controller || controller.signal.aborted) return "stale" as const;
        active = null;
        fail(error);
        return "failed" as const;
      }
    },
  };
}
