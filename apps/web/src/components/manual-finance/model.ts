import {
  manualAssetCreateRequestSchema,
  manualHousingPlanCreateRequestSchema,
  type ManualAsset,
  type ManualAssetCreateRequest,
  type ManualAssetKind,
  type ManualFinanceScope,
  type ManualFinanceVisibility,
  type ManualHousingPayment,
  type ManualHousingPaymentKind,
  type ManualHousingPlan,
  type ManualHousingPlanCreateRequest,
} from "@family/contracts";

export const ASSET_LABELS: Record<ManualAssetKind, string> = {
  account: "통장·현금",
  saving: "적금",
  stock: "주식",
  loan: "대출",
};
export const ASSET_VALUE_LABELS: Record<ManualAssetKind, string> = {
  account: "현재 잔액",
  saving: "현재 적립액",
  stock: "현재 평가액",
  loan: "남은 원금",
};
export const PAYMENT_LABELS: Record<ManualHousingPaymentKind, string> = {
  contract: "계약금",
  interim: "중도금",
  balance: "잔금",
  option: "옵션",
};
export const scopeLabel = (scope: ManualFinanceScope) =>
  scope === "household" ? "가족 공유" : "나만 보기";
export const visibilityLabel = (visibility: ManualFinanceVisibility) =>
  visibility === "household" ? "가족 공개" : "비공개";
const nullableText = (value: string) => value.trim() || null;

export function displayManualKrw(amount: string | null): string {
  return amount === null
    ? "— 원"
    : `${BigInt(amount).toLocaleString("ko-KR")}원`;
}

export function parseManualKrwInput(value: string): string | null | undefined {
  const text = value.trim();
  if (!text) return null;
  if (!/^(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text)) return undefined;
  const digits = text.replaceAll(",", "");
  return digits.length <= 20 ? digits : undefined;
}

export interface AssetDraft {
  kind: ManualAssetKind;
  label: string;
  visibility: ManualFinanceVisibility;
  amount: string;
  asOfDate: string;
  legalOwnerLabel: string;
  note: string;
}
export function assetDraft(item?: ManualAsset): AssetDraft {
  return item
    ? {
        kind: item.kind,
        label: item.label,
        visibility: item.visibility,
        amount: item.amount ?? "",
        asOfDate: item.asOfDate ?? "",
        legalOwnerLabel: item.legalOwnerLabel ?? "",
        note: item.note ?? "",
      }
    : {
        kind: "account",
        label: "",
        visibility: "household",
        amount: "",
        asOfDate: "",
        legalOwnerLabel: "",
        note: "",
      };
}

type Validation<T> = { ok: true; body: T } | { ok: false; message: string };
export function assetRequest(
  draft: AssetDraft,
  id: string,
  householdId: string
): Validation<ManualAssetCreateRequest> {
  const amount = parseManualKrwInput(draft.amount);
  if (!draft.label.trim())
    return { ok: false, message: "자산 이름을 입력해 주세요." };
  if (amount === undefined)
    return {
      ok: false,
      message: "금액은 0원 이상, 소수점 없이 입력해 주세요. 최대 20자리까지 가능해요.",
    };
  if (amount === null && draft.asOfDate)
    return { ok: false, message: "금액을 입력하지 않았다면 기준일도 비워 주세요." };
  const result = manualAssetCreateRequestSchema.safeParse({
    id,
    householdId,
    ...draft,
    label: draft.label.trim(),
    amount,
    asOfDate: draft.asOfDate || null,
    source: amount === null ? null : "manual",
    legalOwnerLabel: nullableText(draft.legalOwnerLabel),
    note: nullableText(draft.note),
  });
  if (!result.success)
    return {
      ok: false,
      message: result.error.issues.some((issue) => issue.path[0] === "asOfDate")
        ? "금액을 확인한 날짜를 입력해 주세요. 미래 날짜는 사용할 수 없어요."
        : "이름·메모의 길이와 금액·공개 범위를 확인해 주세요.",
    };
  return { ok: true, body: result.data };
}

export interface PaymentDraft {
  id: string;
  kind: ManualHousingPaymentKind;
  installment: string;
  dueDate: string;
  amount: string;
  paidAmount: string;
  paidDate: string;
}
export interface PlanDraft {
  label: string;
  visibility: ManualFinanceVisibility;
  occupancyYear: string;
  contractStage: string;
  fundingNote: string;
  payments: PaymentDraft[];
}
export function paymentDraft(
  id: string,
  item?: ManualHousingPayment
): PaymentDraft {
  return item
    ? {
        id: item.id,
        kind: item.kind,
        installment: item.installment?.toString() ?? "",
        dueDate: item.dueDate ?? "",
        amount: item.amount ?? "",
        paidAmount: item.paidAmount ?? "",
        paidDate: item.paidDate ?? "",
      }
    : {
        id,
        kind: "contract",
        installment: "",
        dueDate: "",
        amount: "",
        paidAmount: "",
        paidDate: "",
      };
}
export function planDraft(
  item?: ManualHousingPlan,
  payments: ManualHousingPayment[] = []
): PlanDraft {
  return item
    ? {
        label: item.label,
        visibility: item.visibility,
        occupancyYear: item.occupancyYear?.toString() ?? "",
        contractStage: item.contractStage ?? "",
        fundingNote: item.fundingNote ?? "",
        payments: payments.map((p) => paymentDraft(p.id, p)),
      }
    : {
        label: "",
        visibility: "household",
        occupancyYear: "",
        contractStage: "",
        fundingNote: "",
        payments: [],
      };
}
export function planRequest(
  draft: PlanDraft,
  id: string,
  householdId: string
): Validation<ManualHousingPlanCreateRequest> {
  if (!draft.label.trim())
    return { ok: false, message: "주택 계획 이름을 입력해 주세요." };
  if (draft.occupancyYear && !/^[1-9]\d{0,3}$/.test(draft.occupancyYear))
    return {
      ok: false,
      message: "입주연도를 확인해 주세요. 아직 모르면 비워두세요.",
    };
  for (const [index, p] of draft.payments.entries()) {
    if (
      parseManualKrwInput(p.amount) === undefined ||
      parseManualKrwInput(p.paidAmount) === undefined
    )
      return {
        ok: false,
        message: `${
          index + 1
        }번째 납부 금액을 확인해 주세요. 0원 이상, 소수점 없이 최대 20자리까지 입력할 수 있어요.`,
      };
    if (p.installment && !/^[1-9]\d{0,3}$/.test(p.installment))
      return {
        ok: false,
        message: `${index + 1}번째 납부 일정의 회차를 확인해 주세요.`,
      };
  }
  const result = manualHousingPlanCreateRequestSchema.safeParse({
    id,
    householdId,
    label: draft.label.trim(),
    visibility: draft.visibility,
    occupancyYear: draft.occupancyYear ? Number(draft.occupancyYear) : null,
    contractStage: nullableText(draft.contractStage),
    fundingNote: nullableText(draft.fundingNote),
    payments: draft.payments.map((p) => ({
      id: p.id,
      kind: p.kind,
      installment: p.installment ? Number(p.installment) : null,
      dueDate: p.dueDate || null,
      amount: parseManualKrwInput(p.amount),
      paidAmount: parseManualKrwInput(p.paidAmount),
      paidDate: p.paidDate || null,
    })),
  });
  if (!result.success)
    return {
      ok: false,
      message:
        "납부 날짜와 금액을 확인해 주세요. 낸 금액은 예정 금액을 넘을 수 없어요. 실제 납부액이 있으면 납부일도 입력해 주세요.",
    };
  return { ok: true, body: result.data };
}

export function manualFailureRequiresRead(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status: unknown }).status
      : null;
  return status !== 400 && status !== 422;
}
export function manualFailureMessage(error: unknown): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status: unknown }).status
      : null;
  if (status === 409)
    return "저장된 내용이나 이전 요청과 달라요. 현재 기록을 확인해 주세요. 입력한 내용은 남아 있어요.";
  if (status === 403 || status === 404)
    return "기록이 없거나 접근 권한이 바뀌었을 수 있어요. 현재 상태를 확인해 주세요.";
  if (status === 400 || status === 422)
    return "금액·날짜·공개 범위를 확인해 주세요. 입력한 내용은 남아 있어요.";
  return "저장됐는지 확인하지 못했어요. 다시 저장하기 전에 현재 기록을 확인해 주세요. 입력한 내용은 남아 있어요.";
}

/** A fresh scoped response or permission loss removes a formerly visible editor. */
export function manualEditorUnavailable(input: {
  error: unknown;
  id: string | null;
  visibleIds: string[];
  succeeded: boolean;
  refreshing: boolean;
  cacheCleared?: boolean;
}): boolean {
  const status =
    input.error && typeof input.error === "object" && "status" in input.error
      ? (input.error as { status: unknown }).status
      : null;
  return (
    status === 403 ||
    status === 404 ||
    Boolean(
      input.id &&
        (input.cacheCleared ||
          (input.succeeded &&
            !input.refreshing &&
            !input.visibleIds.includes(input.id)))
    )
  );
}

/** Reset public read-only details immediately, while a writer's draft waits for a fresh response. */
export function hideManualSharedEditor(input: {
  item: { visibility: "private" | "household"; ownerUserId: string } | null;
  actorUserId: string | null;
  pending: boolean;
  hasData: boolean;
}): boolean {
  return Boolean(
    input.item?.visibility === "household" &&
      input.item.ownerUserId !== input.actorUserId &&
      input.pending &&
      !input.hasData
  );
}

/** A newer observation gates a save; an older list cannot replace a freshly verified editor. */
export function manualRecordVersionChanged(
  current: number | null,
  observed: number | undefined
): boolean {
  return current !== null && observed !== undefined && observed > current;
}

export function manualFinanceCanCreate(
  role: unknown,
  scope: ManualFinanceScope = "household"
): boolean {
  return scope === "household" && (role === "owner" || role === "admin" || role === "member");
}

/** Losing write permission invalidates the editor even if user and family stay the same. */
export function manualFinanceEditorContext(
  userId: string,
  householdId: string,
  scope: ManualFinanceScope,
  role: unknown
): string {
  return `${userId}/${householdId}/${scope}/${
    manualFinanceCanCreate(role) ? "writer" : "readonly"
  }`;
}

/** A synchronously claimed save protects against clicks before React disables a button. */
export function createManualSaveSession() {
  let active: object | null = null;
  let generation = 0;
  return {
    get pending() {
      return active !== null;
    },
    invalidate() {
      generation++;
      active = null;
    },
    async run<T>(
      request: () => Promise<T>,
      saved: (value: T) => void,
      failed: (error: unknown) => void
    ): Promise<"saved" | "failed" | "stale" | "busy"> {
      if (active) return "busy";
      const claim = {};
      const epoch = generation;
      active = claim;
      try {
        const value = await request();
        if (generation !== epoch || active !== claim) return "stale";
        active = null;
        saved(value);
        return "saved";
      } catch (error) {
        if (generation !== epoch || active !== claim) return "stale";
        active = null;
        failed(error);
        return "failed";
      }
    },
  };
}
