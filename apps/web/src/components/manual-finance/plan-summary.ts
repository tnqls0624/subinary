/**
 * 주택 상세 시트·입력 폼이 쓰는 순수 계산(2026-11-08 PO 재설계 — '보기 먼저').
 * 화면은 여기서 나온 글자를 그리기만 한다. 금액은 문자열/BigInt로 다룬다(20자리 원 금액은 Number로 잃는다).
 * 모름(null)은 0으로 바꾸지 않는다 — 합계는 두 금액을 다 아는 일정만으로 내고, 뺀 일정이 있으면 그렇게 말한다.
 */
import { summarizeManualHousingPlans } from "@family/shared";
import type {
  HousingBrandConnection,
  HousingBrandFetchedItem,
  HousingBrandSyncPreview,
  ManualHousingPayment,
  ManualHousingPaymentKind,
  ManualHousingPlanResponse,
} from "@family/contracts";
import type { ChipTone } from "@/components/widgets/status-chip";
import { formatMonthDay, formatMonthDayTime } from "@/lib/format";
import {
  displayManualKrw,
  parseManualKrwInput,
  PAYMENT_LABELS,
  PAYMENT_STATUS_LABEL,
} from "./model";

const KRW = /^(0|[1-9]\d*)$/;
const krw = (value: string | null | undefined): bigint | null =>
  value != null && KRW.test(value) ? BigInt(value) : null;
const money = (value: string | null | undefined): string | null =>
  krw(value) === null ? null : displayManualKrw(value!);
const day = (value: string | null | undefined, now?: Date): string | null =>
  value ? formatMonthDay(value, now) : null;

/** 옵션 이름 '발코니 확장 외 2 · 계약금' → 계약 제목 '발코니 확장 외 2' + 줄 이름 '계약금'(마지막 ' · ' 기준). */
export function splitOptionLabel(label: string): {
  title: string | null;
  name: string;
} {
  const at = label.lastIndexOf(" · ");
  if (at < 0) return { title: null, name: label };
  const title = label.slice(0, at).trim();
  const name = label.slice(at + 3).trim();
  return title && name ? { title, name } : { title: null, name: label };
}

/**
 * 일정 한 줄 이름: '중도금 3회차', '계약금', 옵션은 '발코니 확장 외 2 계약금'.
 * 회차 표기는 홈·'다음 납부' 카드와 같은 'N회차'다(이름 규칙: 같은 개념은 한 이름).
 * `label`은 옵션 이름일 때만 넘긴다 — 주택 이름을 넘기면 옵션 이름으로 읽힌다.
 */
export function housingPaymentName(payment: {
  kind: ManualHousingPaymentKind;
  installment: number | null;
  label?: string | null;
}): string {
  const label = payment.kind === "option" ? payment.label?.trim() : null;
  if (label) {
    const { title, name } = splitOptionLabel(label);
    return title ? `${title} ${name}` : name;
  }
  return `${PAYMENT_LABELS[payment.kind]}${
    payment.installment ? ` ${payment.installment}회차` : ""
  }`;
}

export type HousingPaymentStatus = keyof typeof PAYMENT_STATUS_LABEL;

/** 서버(remainingAmount·status)와 같은 규칙: 두 금액을 다 알 때만 남은 금액, 0 아래로 내려가지 않는다. */
export function paymentProgress(payment: {
  amount: string | null;
  paidAmount: string | null;
}): { status: HousingPaymentStatus; remaining: string | null } {
  const amount = krw(payment.amount);
  const paid = krw(payment.paidAmount);
  if (amount === null || paid === null)
    return { status: "unknown", remaining: null };
  const left = amount - paid;
  if (left <= 0n) return { status: "paid", remaining: "0" };
  return {
    status: paid > 0n ? "partial" : "unpaid",
    remaining: left.toString(),
  };
}

export type PlanMoneySummary = {
  /** 두 금액을 다 아는 일정만의 합. 그런 일정이 없으면 null(0이 아니다). */
  total: string | null;
  paid: string | null;
  remaining: string | null;
  /** 예정 금액이나 낸 금액을 몰라 합계에서 뺀 일정 수(아래 두 수의 합). */
  unknownCount: number;
  /** 예정 금액을 모르는 일정 수. */
  unknownAmountCount: number;
  /** 예정 금액은 알고 낸 금액만 모르는 일정 수 — 직접 만든 주택에서 '이미 낸 금액'을 비워 두면 이렇다. */
  unknownPaidCount: number;
};

export function planMoneySummary(
  payments: readonly { amount: string | null; paidAmount: string | null }[]
): PlanMoneySummary {
  let total = 0n;
  let paid = 0n;
  let remaining = 0n;
  let known = 0;
  let unknownAmountCount = 0;
  let unknownPaidCount = 0;
  for (const payment of payments) {
    const amount = krw(payment.amount);
    const paidAmount = krw(payment.paidAmount);
    if (amount === null) {
      unknownAmountCount++;
      continue;
    }
    if (paidAmount === null) {
      unknownPaidCount++;
      continue;
    }
    known++;
    total += amount;
    paid += paidAmount;
    remaining += amount > paidAmount ? amount - paidAmount : 0n;
  }
  const unknown = {
    unknownCount: unknownAmountCount + unknownPaidCount,
    unknownAmountCount,
    unknownPaidCount,
  };
  return known === 0
    ? { total: null, paid: null, remaining: null, ...unknown }
    : {
        total: total.toString(),
        paid: paid.toString(),
        remaining: remaining.toString(),
        ...unknown,
      };
}

/**
 * 요약의 글자. 남은 금액을 낼 수 있으면 '총 N원 중 N원 냈어요', 뺀 일정이 있으면 '확인된 금액 기준 · …'.
 * 낼 수 없으면 대표 숫자 자리에 무엇을 하면 되는지 한 줄(headline)과 몇 개를 모르는지 한 줄.
 * 무엇을 모르는지(예정 금액/낸 금액)를 따로 말한다 — 줄에 금액이 보이는 일정을 '금액을 모른다'고 하지 않는다.
 */
export function planSummaryLines(
  summary: PlanMoneySummary,
  options: { canEdit?: boolean } = {}
): {
  headline: string | null;
  paidLine: string | null;
  caveat: string | null;
} {
  const { unknownCount, unknownAmountCount, unknownPaidCount } = summary;
  const what =
    unknownAmountCount > 0 && unknownPaidCount > 0
      ? "예정 금액이나 낸 금액"
      : unknownAmountCount > 0
      ? "예정 금액"
      : "낸 금액";
  if (summary.total === null || summary.paid === null) {
    if (unknownCount === 0)
      return { headline: null, paidLine: null, caveat: null };
    const need =
      unknownAmountCount > 0 && unknownPaidCount > 0
        ? "예정 금액과 이미 낸 금액(없으면 0)"
        : unknownAmountCount > 0
        ? "예정 금액"
        : "이미 낸 금액(없으면 0)";
    return {
      headline: options.canEdit
        ? `${need}을 적으면 남은 금액을 계산해요`
        : "남은 금액을 아직 계산할 수 없어요",
      paidLine: null,
      caveat: `${what}을 모르는 일정이 ${unknownCount}개 있어요`,
    };
  }
  return {
    headline: null,
    paidLine: `총 ${displayManualKrw(summary.total)} 중 ${displayManualKrw(
      summary.paid
    )} 냈어요`,
    caveat:
      unknownCount > 0
        ? `확인된 금액 기준 · ${what}을 모르는 일정 ${unknownCount}개는 뺐어요`
        : null,
  };
}

export type PlanNextPayment = {
  paymentId: string;
  dueDate: string;
  remaining: string;
  name: string;
};

/**
 * 이 주택의 다음 납부. /plan '다음 납부' 카드(서버 요약)와 같은 답이 나오도록 서버가 쓰는 바로 그 함수
 * (`@family/shared` summarizeManualHousingPlans)를 이 주택 하나에만 돌린다 — 날짜·금액을 다 아는 미납 일정 중
 * 가장 이른 것, 같은 날이면 id 순.
 */
export function planNextPayment(
  plan: { id: string; label: string },
  payments: readonly ManualHousingPayment[]
): PlanNextPayment | null {
  let next: ReturnType<typeof summarizeManualHousingPlans>["nextPayment"];
  try {
    next = summarizeManualHousingPlans([
      {
        id: plan.id,
        label: plan.label,
        payments: payments.map((payment) => ({
          id: payment.id,
          kind: payment.kind,
          installment: payment.installment,
          dueDate: payment.dueDate,
          amount: payment.amount,
          paidAmount: payment.paidAmount,
          paidDate: payment.paidDate,
        })),
      },
    ]).nextPayment;
  } catch {
    // 서버가 이미 검사한 값이라 보통 던지지 않는다. 기기 시계가 늦어 오늘 납부일이 '미래'로 보이면 던질 수 있어
    // 시트를 깨뜨리지 않고 이 줄만 숨긴다.
    return null;
  }
  if (!next) return null;
  const found = next;
  const payment = payments.find((item) => item.id === found.paymentId);
  return {
    paymentId: found.paymentId,
    dueDate: found.dueDate,
    remaining: found.remainingAmountKrw,
    name: housingPaymentName(
      payment ?? { kind: found.kind, installment: found.installment }
    ),
  };
}

/** '다음 납부 11월 20일 · 중도금 3회차 30,000,000원'. */
export function nextPaymentLine(next: PlanNextPayment, now?: Date): string {
  return `다음 납부 ${formatMonthDay(next.dueDate, now)} · ${
    next.name
  } ${displayManualKrw(next.remaining)}`;
}

type GroupInput = {
  kind: ManualHousingPaymentKind;
  installment: number | null;
  label?: string | null;
  dueDate: string | null;
};
export type PlanPaymentRow<P> = { payment: P; name: string };
export type PlanOptionGroup<P> = {
  title: string | null;
  rows: PlanPaymentRow<P>[];
};

const KIND_ORDER: Record<ManualHousingPaymentKind, number> = {
  contract: 0,
  interim: 1,
  balance: 2,
  option: 3,
};

/**
 * 납부 일정 묶기: '아파트 분양대금'(계약금 → 중도금 → 잔금, 회차 순)과 '옵션'(계약 제목별 소제목).
 * 옵션 이름이 '제목 · 줄 이름' 꼴이 아니면 소제목 없이 그대로 한 줄로 둔다(그런 줄은 한 묶음에 모은다).
 */
export function groupPlanPayments<P extends GroupInput>(
  payments: readonly P[]
): { apartment: PlanPaymentRow<P>[]; options: PlanOptionGroup<P>[] } {
  const apartment = payments
    .map((payment, index) => ({ payment, index }))
    .filter(({ payment }) => payment.kind !== "option")
    .sort(
      (a, b) =>
        KIND_ORDER[a.payment.kind] - KIND_ORDER[b.payment.kind] ||
        (a.payment.installment ?? 0) - (b.payment.installment ?? 0) ||
        (a.payment.dueDate ?? "9999-99-99").localeCompare(
          b.payment.dueDate ?? "9999-99-99"
        ) ||
        a.index - b.index
    )
    .map(({ payment }) => ({ payment, name: housingPaymentName(payment) }));
  const options: PlanOptionGroup<P>[] = [];
  const titled = new Map<string, PlanOptionGroup<P>>();
  let loose: PlanOptionGroup<P> | null = null;
  for (const payment of payments) {
    if (payment.kind !== "option") continue;
    const label = payment.label?.trim();
    const split = label ? splitOptionLabel(label) : null;
    if (split?.title) {
      let group = titled.get(split.title);
      if (!group) {
        group = { title: split.title, rows: [] };
        titled.set(split.title, group);
        options.push(group);
      }
      group.rows.push({ payment, name: split.name });
    } else {
      if (!loose) {
        loose = { title: null, rows: [] };
        options.push(loose);
      }
      loose.rows.push({ payment, name: housingPaymentName(payment) });
    }
  }
  return { apartment, options };
}

/**
 * 일정 줄 아래 한 줄: '11월 20일 예정', '11월 3일 납부', 일부 납부면 '11월 20일 예정 · 남은 1,000,000원'.
 * 할 말이 상태 칩뿐이면 null.
 */
export function paymentRowCaption(
  payment: {
    amount: string | null;
    paidAmount: string | null;
    dueDate: string | null;
    paidDate: string | null;
  },
  now?: Date
): string | null {
  const { status, remaining } = paymentProgress(payment);
  const due = payment.dueDate
    ? `${formatMonthDay(payment.dueDate, now)} 예정`
    : null;
  if (status === "paid")
    return payment.paidDate
      ? `${formatMonthDay(payment.paidDate, now)} 납부`
      : due;
  if (status === "partial")
    return [due, `남은 ${displayManualKrw(remaining)}`]
      .filter(Boolean)
      .join(" · ");
  const parts = [due ?? "예정일 미입력"];
  if (paidAmountMissing(payment)) parts.push("낸 금액 미확인");
  return parts.join(" · ");
}

/** 예정 금액은 알고 낸 금액만 모른다 — 줄 아래에 '낸 금액 미확인'이라고 쓰는 경우. */
function paidAmountMissing(payment: {
  amount: string | null;
  paidAmount: string | null;
}): boolean {
  return krw(payment.amount) !== null && krw(payment.paidAmount) === null;
}

/**
 * 상태 칩. 기본 상태(예정)는 그리지 않는다 — §8 '기본 상태는 배지를 그리지 않는다'와 같고,
 * 줄 아래 '11월 20일 예정'이 이미 말한다. 일정 15~19줄마다 같은 칩이 붙으면 다시 복잡해진다.
 */
export function paymentStatusChip(
  status: HousingPaymentStatus
): { label: string; tone: ChipTone } | null {
  if (status === "paid")
    return { label: PAYMENT_STATUS_LABEL.paid, tone: "ok" };
  if (status === "partial")
    return { label: PAYMENT_STATUS_LABEL.partial, tone: "pending" };
  if (status === "unknown")
    return { label: PAYMENT_STATUS_LABEL.unknown, tone: "attention" };
  return null;
}

/**
 * 일정 한 줄의 아래 문장과 상태 칩. 줄 아래에 '낸 금액 미확인'이 이미 있으면 '확인 필요' 칩은 그리지 않는다
 * — 같은 말을 두 번 하지 않는다(예정 금액을 모르는 줄은 값 자리가 '금액 미입력'이라 칩이 상태를 말한다).
 */
export function paymentRowView(
  payment: {
    amount: string | null;
    paidAmount: string | null;
    dueDate: string | null;
    paidDate: string | null;
  },
  now?: Date
): { caption: string | null; chip: { label: string; tone: ChipTone } | null } {
  const caption = paymentRowCaption(payment, now);
  const chip = paidAmountMissing(payment)
    ? null
    : paymentStatusChip(paymentProgress(payment).status);
  return { caption, chip };
}

/** 수자인 줄: '수자인 · 11월 8일 오후 11:27 기준'. 한 번도 못 가져왔으면 그렇게 말한다. */
export function brandSourceLine(
  brandLabel: string,
  lastSuccessAt: string | null,
  now?: Date
): string {
  return lastSuccessAt
    ? `${brandLabel} · ${formatMonthDayTime(lastSuccessAt, now)} 기준`
    : `${brandLabel} · 아직 가져오지 않았어요`;
}

/**
 * 수자인 연결의 화면 상태. 서버의 needs_confirmation 은 두 가지라 갈라 본다.
 * - 가져오기는 됐는데 아직 반영 안 함(서버가 lastFetchAt·lastSuccessAt 을 같은 시각으로 남긴다) → 'pending'.
 *   서버 문구('…골라 주세요')는 그리지 않는다 — 고를 목록은 이 화면의 상태라 시트를 닫으면 없어지고,
 *   열려 있으면 목록이 그 말을 한다.
 * - 추가 인증 때문에 못 가져옴(실패 기록이라 lastFetchAt 이 lastSuccessAt 보다 늦다) → 'failed'와 같이 보인다.
 */
export function brandConnectionState(
  connection: Pick<
    HousingBrandConnection,
    "status" | "lastFetchAt" | "lastSuccessAt"
  >
): "ok" | "pending" | "failed" {
  if (connection.status === "connected") return "ok";
  if (connection.status === "failed") return "failed";
  return connection.lastSuccessAt !== null &&
    connection.lastFetchAt === connection.lastSuccessAt
    ? "pending"
    : "failed";
}

/** 'pending'이고 고를 목록이 화면에 없을 때 수자인 줄 아래 한 줄. */
export const BRAND_PENDING_LINE = "가져온 내용을 아직 반영하지 않았어요";

export type PreviewChange = {
  /** 반영할 때 보내는 확인 목록 키. */
  key: string;
  isNew: boolean;
  /** '중도금 3회차' 또는 '새 일정'. */
  title: string;
  /** '예정 금액 3,000,000원 → 3,100,000원' 또는 '발코니 확장 외 2 계약금 1,000,000원 · 11월 20일'. */
  detail: string;
};

type ChangedField = HousingBrandFetchedItem["changedFields"][number];

function fieldChanges(
  item: HousingBrandFetchedItem,
  before: ManualHousingPayment | null,
  now?: Date
): string[] {
  const changed = new Set<ChangedField>(item.changedFields);
  const parts: string[] = [];
  // 지금 일정을 못 찾으면(목록이 바뀐 사이) 전 값을 지어내지 않고 새 값만 쓴다.
  const pair = (label: string, from: string | null, to: string | null) =>
    before
      ? `${label} ${from ?? "미입력"} → ${to ?? "미입력"}`
      : `${label} ${to ?? "미입력"}`;
  const optionName = (label: string | null | undefined) =>
    label
      ? housingPaymentName({ kind: "option", installment: null, label })
      : null;
  if (changed.has("scheduledAmount"))
    parts.push(
      pair("예정 금액", money(before?.amount), money(item.scheduledAmount))
    );
  if (changed.has("dueDate"))
    parts.push(
      pair("예정일", day(before?.dueDate, now), day(item.dueDate, now))
    );
  if (changed.has("paidAmount"))
    parts.push(
      pair("낸 금액", money(before?.paidAmount), money(item.paidAmount))
    );
  // 서버는 사이트의 실제 납부일(없으면 납부일)을 일정의 납부일 한 칸에 넣는다 — 두 칸이어도 한 번만 쓴다.
  if (changed.has("paidDate") || changed.has("actualPaidDate"))
    parts.push(
      pair(
        "납부일",
        day(before?.paidDate, now),
        day(item.actualPaidDate ?? item.paidDate, now)
      )
    );
  if (changed.has("label"))
    parts.push(
      pair(
        "이름",
        item.kind === "option"
          ? optionName(before?.label)
          : before?.label ?? null,
        item.kind === "option" ? optionName(item.label) : item.label
      )
    );
  if (changed.has("installment"))
    parts.push(
      pair(
        "회차",
        before?.installment ? `${before.installment}회차` : null,
        item.installment ? `${item.installment}회차` : null
      )
    );
  if (changed.has("kind"))
    parts.push(
      pair(
        "항목",
        before ? PAYMENT_LABELS[before.kind] : null,
        PAYMENT_LABELS[item.kind]
      )
    );
  return parts;
}

/**
 * 가져온 확인 목록을 사람 말로: 기존 일정과 맞춰진 항목은 바뀐 칸마다 '예정 금액 A → B',
 * 새 항목은 '새 일정 · 이름 금액 · 날짜'. 값은 같고 못 읽은 칸만 있는 항목은 '달라진 내용'이 아니라 빼고,
 * 아래 '읽지 못한 칸' 한 줄이 말한다.
 */
export function previewChanges(
  items: readonly HousingBrandFetchedItem[],
  payments: readonly ManualHousingPayment[],
  now?: Date
): PreviewChange[] {
  const changes: PreviewChange[] = [];
  for (const item of items) {
    if (item.matchedPaymentId === null) {
      const name = housingPaymentName(item);
      const amount = money(item.scheduledAmount);
      const parts = [amount ? `${name} ${amount}` : name];
      const due = day(item.dueDate, now);
      if (due) parts.push(due);
      const paid = krw(item.paidAmount);
      if (paid !== null && paid > 0n)
        parts.push(`낸 금액 ${displayManualKrw(item.paidAmount)}`);
      changes.push({
        key: item.key,
        isNew: true,
        title: "새 일정",
        detail: parts.join(" · "),
      });
      continue;
    }
    const before =
      payments.find((payment) => payment.id === item.matchedPaymentId) ?? null;
    const parts = fieldChanges(item, before, now);
    if (parts.length === 0) continue;
    changes.push({
      key: item.key,
      isNew: false,
      title: housingPaymentName(before ?? item),
      detail: parts.join(" · "),
    });
  }
  return changes;
}

/** 목록 아래 회색 한 줄: '읽지 못한 칸이 2개 있어요 · 옵션 금액 칸을 읽지 못했어요.' */
export function previewUnreadLine(
  preview: Pick<HousingBrandSyncPreview, "unreadCount" | "unreadReasons">
): string | null {
  if (preview.unreadCount <= 0) return null;
  const reason = preview.unreadReasons[0];
  return `읽지 못한 칸이 ${preview.unreadCount}개 있어요${
    reason ? ` · ${reason}` : ""
  }`;
}

/**
 * 새로 읽은 주택을 화면 상태에 합친다. 응답에 brandConnection 칸이 없으면(undefined) 전 연결을 지키고,
 * null 이면 '연결 없음'으로 받아들인다 — 저장·반영·다시 읽기가 같은 규칙을 쓴다.
 */
export function mergePlanRead(
  old: ManualHousingPlanResponse | undefined,
  read: ManualHousingPlanResponse
): ManualHousingPlanResponse {
  return {
    ...read,
    brandConnection:
      read.brandConnection === undefined
        ? old?.brandConnection
        : read.brandConnection,
  };
}

/** 입력 폼의 접힌 일정 한 줄: '중도금 3회차 · 3,000,000원 · 11월 20일'. */
export function draftPaymentSummary(
  draft: {
    kind: ManualHousingPaymentKind;
    installment: string;
    label: string;
    amount: string;
    dueDate: string;
  },
  now?: Date
): string {
  const installment = /^[1-9]\d{0,3}$/.test(draft.installment)
    ? Number(draft.installment)
    : null;
  const name = housingPaymentName({
    kind: draft.kind,
    installment,
    label: draft.label,
  });
  const parsed = parseManualKrwInput(draft.amount);
  const amount =
    parsed === null
      ? "금액 미입력"
      : parsed === undefined
      ? "금액 확인 필요"
      : displayManualKrw(parsed);
  const due = draft.dueDate
    ? formatMonthDay(draft.dueDate, now)
    : "예정일 미입력";
  return `${name} · ${amount} · ${due}`;
}
