"use client";

import { useId, useState } from "react";
import type {
  HousingBrandConnection,
  ManualHousingPayment,
  ManualHousingPaymentKind,
  ManualHousingPlanResponse,
} from "@family/contracts";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldList, FieldRow } from "@/components/widgets/field-row";
import { InlineNotice } from "@/components/widgets/inline-notice";
import { useAuth } from "@/lib/auth-context";
import { formatMonthDay } from "@/lib/format";
import {
  manualFinanceApi,
  useManualFinanceRefresh,
} from "@/lib/manual-finance-client";
import { useHouseholdMembers } from "@/lib/queries";
import {
  PAYMENT_LABELS,
  PAYMENT_STATUS_LABEL,
  displayManualKrw,
  paymentDraft,
  paymentSourceLabel,
  planDraft,
  planRequest,
} from "./model";
import { planFieldError, type PlanPaymentField } from "./field-errors";
import { KrwAmountField } from "./krw-amount-field";
import {
  ConfirmAction,
  FieldError,
  NATIVE_SELECT,
  RecordDialog,
  RecordSheet,
} from "./shared";
import { useRecordEditor } from "./use-record-editor";
import { HousingBrandPanel } from "./housing-brand-panel";

type PlanEditorProps = {
  householdId: string;
  initial?: ManualHousingPlanResponse;
  observedVersion?: number;
  onChanged: () => void;
  onClose: () => void;
};

/**
 * 주택 계획 입력 창(2026-11-05 HIG 검수 4단계로 다시 짬).
 * 고칠 수 없는 계획(가족이 등록했거나 지금 권한이 보기뿐)은 칸이 꺼진 폼 대신 읽기 전용 시트로 연다 — 자산 입력 창과 같다.
 */
export function PlanEditor(props: PlanEditorProps) {
  if (props.initial && !props.initial.item.canEdit)
    return <PlanDetailSheet read={props.initial} onClose={props.onClose} />;
  return <PlanForm {...props} />;
}

const paymentTitle = (payment: {
  kind: ManualHousingPaymentKind;
  installment: number | null;
}) =>
  `${PAYMENT_LABELS[payment.kind]}${payment.installment ? ` ${payment.installment}회차` : ""}`;

/** 읽기 전용 줄의 보조 설명: '예정일 11월 20일 · 3,000,000원 냄(11월 3일)'. 모르는 값은 0으로 바꾸지 않는다. */
function paymentCaption(payment: ManualHousingPayment): string {
  const due = payment.dueDate
    ? `예정일 ${formatMonthDay(payment.dueDate)}`
    : "예정일 미입력";
  const paid =
    payment.paidAmount === null
      ? "낸 금액 미확인"
      : payment.paidAmount === "0"
        ? "아직 안 냄"
        : `${displayManualKrw(payment.paidAmount)} 냄${payment.paidDate ? `(${formatMonthDay(payment.paidDate)})` : ""}`;
  return `${due} · ${paid}`;
}

function paymentMetaCaption(payment: {
  amount: string;
  paidAmount: string;
  amountSource: ManualHousingPayment["amountSource"] | null;
  amountAsOfSeoul: string | null;
  paidAmountSource: ManualHousingPayment["paidAmountSource"] | null;
  paidAmountAsOfSeoul: string | null;
  remainingAmount: string | null;
  status: ManualHousingPayment["status"];
}): string {
  const amount = payment.amount.trim() === "" ? null : payment.amount.replaceAll(",", "");
  const paid = payment.paidAmount.trim() === "" ? null : payment.paidAmount.replaceAll(",", "");
  let remaining = payment.remainingAmount;
  let status = payment.status ?? "unknown";
  if (amount !== null && paid !== null && /^(0|[1-9]\d*)$/.test(amount) && /^(0|[1-9]\d*)$/.test(paid)) {
    const left = BigInt(amount) - BigInt(paid);
    remaining = left < 0n ? "0" : left.toString();
    status = left <= 0n ? "paid" : BigInt(paid) > 0n ? "partial" : "unpaid";
  } else if (amount === null || paid === null) {
    remaining = null;
    status = "unknown";
  }
  const paidMeta = paid !== null
    ? [
        `낸 금액 출처 ${paymentSourceLabel(payment.paidAmountSource)}`,
        payment.paidAmountAsOfSeoul || null,
      ].filter(Boolean).join(" · ")
    : null;
  return [
    `출처 ${paymentSourceLabel(payment.amountSource)}`,
    payment.amountAsOfSeoul || null,
    paidMeta,
    `남은 금액 ${remaining != null ? displayManualKrw(remaining) : "미확인"}`,
    PAYMENT_STATUS_LABEL[status ?? "unknown"],
  ].filter(Boolean).join(" · ");
}

function PlanDetailSheet({
  read,
  onClose,
}: {
  read: ManualHousingPlanResponse;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const members = useHouseholdMembers();
  const { item, payments } = read;
  const owner =
    members.data?.find((member) => member.userId === item.ownerUserId)?.name ??
    "가족 구성원";
  return (
    <RecordSheet title={item.label} onClose={onClose}>
      <FieldList>
        <FieldRow
          label="입주연도"
          value={item.occupancyYear ? `${item.occupancyYear}년` : "미입력"}
          muted={!item.occupancyYear}
        />
        <FieldRow
          label="계약 단계"
          value={item.contractStage ?? "미입력"}
          muted={!item.contractStage}
        />
        <FieldRow label="등록한 사람" value={owner} />
      </FieldList>
      <section aria-label="납부 일정" className="grid gap-1">
        <h3 className="text-caption text-muted-foreground">납부 일정</h3>
        {payments.length ? (
          <FieldList>
            {payments.map((payment) => (
              <FieldRow
                key={payment.id}
                label={paymentTitle(payment)}
                value={
                  payment.amount === null ? (
                    "금액 미입력"
                  ) : (
                    <span className="tabular-nums">
                      {displayManualKrw(payment.amount)}
                    </span>
                  )
                }
                muted={payment.amount === null}
              >
                {paymentCaption(payment)}
                <span className="text-caption text-muted-foreground mt-1 block">
                  출처 {paymentSourceLabel(payment.amountSource)}
                  {payment.amountAsOfSeoul ? ` · ${payment.amountAsOfSeoul}` : ""}
                  {payment.paidAmount != null ? (
                    <>
                      {" · "}
                      낸 금액 출처 {paymentSourceLabel(payment.paidAmountSource)}
                      {payment.paidAmountAsOfSeoul ? ` · ${payment.paidAmountAsOfSeoul}` : ""}
                    </>
                  ) : null}
                  {" · "}
                  남은 금액 {payment.remainingAmount != null ? displayManualKrw(payment.remainingAmount) : "미확인"}
                  {" · "}
                  {PAYMENT_STATUS_LABEL[payment.status ?? "unknown"]}
                </span>
              </FieldRow>
            ))}
          </FieldList>
        ) : (
          <p className="text-body text-muted-foreground">
            적어 둔 납부 일정이 없어요.
          </p>
        )}
      </section>
      {item.fundingNote ? (
        <section aria-label="자금 마련 메모" className="grid gap-1">
          <h3 className="text-caption text-muted-foreground">자금 마련 메모</h3>
          <p className="text-body break-words whitespace-pre-wrap">
            {item.fundingNote}
          </p>
        </section>
      ) : null}
      <p className="text-caption text-muted-foreground">
        {item.ownerUserId === user?.id
          ? "지금 가족 권한으로는 고칠 수 없어요."
          : "등록한 사람만 고칠 수 있어요."}
      </p>
    </RecordSheet>
  );
}

function PlanForm({
  householdId,
  initial,
  observedVersion,
  onChanged,
  onClose,
}: PlanEditorProps) {
  const { authedFetch } = useAuth();
  const refresh = useManualFinanceRefresh();
  const formId = useId();
  const [brandConnection, setBrandConnection] = useState<HousingBrandConnection | null>(
    initial?.brandConnection ?? null
  );
  const editor = useRecordEditor({
    initial: initial ?? null,
    observedVersion,
    emptyDraft: () => planDraft(),
    toDraft: (read: ManualHousingPlanResponse) =>
      planDraft(read.item, read.payments),
    validate: (draft, id) => planRequest(draft, id, householdId),
    save: (body, current) =>
      authedFetch((token) => {
        if (!current) return manualFinanceApi.createPlan(token, body);
        const { id: _id, householdId: _householdId, ...fields } = body;
        return manualFinanceApi.updatePlan(
          token,
          householdId,
          current.item.id,
          { ...fields, expectedVersion: current.item.version }
        );
      }),
    read: (id) =>
      authedFetch((token) => manualFinanceApi.plan(token, householdId, id)),
    remove: (current) =>
      authedFetch((token) =>
        manualFinanceApi.removePlan(
          token,
          householdId,
          current.item.id,
          current.item.version
        )
      ),
    onChanged,
    onClose,
    changed: (clear) => {
      void refresh(clear);
    },
  });
  const disabled = editor.busy || editor.readRequired || !editor.canEdit;
  const set = <K extends keyof typeof editor.draft>(
    key: K,
    value: (typeof editor.draft)[K]
  ) => editor.setDraft((old) => ({ ...old, [key]: value }));
  const existingPayments = new Set(
    editor.current?.payments.map((p) => p.id) ?? []
  );
  const updatePayment = (id: string, key: string, value: string) =>
    editor.setDraft((old) => ({
      ...old,
      payments: old.payments.map((payment) => {
        if (payment.id !== id) return payment;
        const next = { ...payment, [key]: value };
        // 금액을 고치면 출처를 비워 서버가 직접 입력으로 두거나, 값이 같으면 기존 출처를 유지하게 한다.
        if (key === "amount") {
          next.amountSource = null;
          next.amountAsOfAt = null;
          next.amountAsOfSeoul = null;
        }
        if (key === "paidAmount") {
          next.paidAmountSource = null;
          next.paidAmountAsOfAt = null;
          next.paidAmountAsOfSeoul = null;
        }
        return next;
      }),
    }));
  const invalid = planFieldError(editor.invalid, editor.draft.payments);
  // 칸을 모르는 검사 오류와 서버 오류는 창 아래(저장 버튼 위) 한 줄로 남는다.
  const formError =
    (editor.invalid && !invalid ? editor.invalid : null) ?? editor.error;
  const errorId = (key: string) => `${formId}-${key}-error`;
  const planError = (field: "label" | "occupancyYear") =>
    invalid && invalid.field === field ? invalid.message : null;
  const paymentError = (paymentId: string, field: PlanPaymentField) =>
    invalid &&
    "paymentId" in invalid &&
    invalid.paymentId === paymentId &&
    invalid.field === field
      ? invalid.message
      : null;
  const invalidProps = (message: string | null, key: string) =>
    message ? { "aria-invalid": true, "aria-describedby": errorId(key) } : {};
  return (
    <RecordDialog
      title={editor.current ? "주택 수정" : "주택 추가"}
      description="계약서에서 확인한 납부 일정과 금액을 적어 주세요."
      dirty={editor.dirty}
      busy={editor.busy}
      pending={editor.pending}
      readRequired={editor.readRequired}
      invalidate={editor.invalidate}
      onClose={onClose}
      footer={
        <>
          {formError ? (
            <InlineNotice tone="error">{formError}</InlineNotice>
          ) : null}
          {editor.notice ? <InlineNotice>{editor.notice}</InlineNotice> : null}
          {editor.busy ? (
            <p role="status" className="text-body text-muted-foreground w-full">
              {editor.phase === "reading"
                ? "현재 기록을 확인하고 있어요."
                : editor.phase === "removing"
                ? "삭제 결과를 확인하고 있어요."
                : "주택을 저장하고 있어요."}
            </p>
          ) : null}
          {editor.readRequired ? (
            <div className="w-full">
              <Button
                type="button"
                variant="weak"
                className="min-h-11 h-auto w-full whitespace-normal"
                disabled={editor.busy}
                onClick={() => void editor.read()}
              >
                저장 상태 확인하기
              </Button>
            </div>
          ) : null}
          {editor.canEdit ? (
            <Button
              form={formId}
              type="submit"
              className="min-h-11 w-full"
              disabled={disabled}
            >
              {editor.phase === "saving" ? "저장 중…" : "저장하기"}
            </Button>
          ) : (
            <p className="text-body text-muted-foreground w-full">
              등록한 사람만 고칠 수 있어요.
            </p>
          )}
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void editor.save(event)}
        onSubmitCapture={(event) => {
          // 칸을 모르는 오류로 다시 제출해도 접은 입력란을 다시 찾을 수 있게 한다.
          if (formError) {
            event.currentTarget
              .querySelectorAll<HTMLDetailsElement>("[data-plan-inputs]")
              .forEach((details) => {
                details.open = true;
              });
          }
        }}
        noValidate
        className="grid min-w-0 gap-4"
        aria-busy={editor.busy}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={`${formId}-label`}>주택 이름</Label>
          <Input
            id={`${formId}-label`}
            value={editor.draft.label}
            disabled={disabled}
            maxLength={100}
            autoComplete="off"
            placeholder="예: 풍무수자인 1차 59B"
            {...invalidProps(planError("label"), "label")}
            onChange={(e) => set("label", e.target.value)}
          />
          {planError("label") ? (
            <FieldError id={errorId("label")}>{planError("label")}</FieldError>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${formId}-year`}>입주연도 · 선택</Label>
            <Input
              id={`${formId}-year`}
              value={editor.draft.occupancyYear}
              disabled={disabled}
              maxLength={4}
              inputMode="numeric"
              autoComplete="off"
              placeholder="예: 2028"
              {...invalidProps(planError("occupancyYear"), "occupancyYear")}
              onChange={(e) => set("occupancyYear", e.target.value)}
            />
            {planError("occupancyYear") ? (
              <FieldError id={errorId("occupancyYear")}>
                {planError("occupancyYear")}
              </FieldError>
            ) : null}
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${formId}-stage`}>계약 단계 · 선택</Label>
            <Input
              id={`${formId}-stage`}
              value={editor.draft.contractStage}
              disabled={disabled}
              maxLength={100}
              autoComplete="off"
              placeholder="예: 중도금 내는 중"
              onChange={(e) => set("contractStage", e.target.value)}
            />
          </div>
        </div>
        <HousingBrandPanel
          householdId={householdId}
          planId={editor.current?.item.id ?? null}
          planVersion={editor.current?.item.version ?? null}
          connection={brandConnection}
          canEdit={editor.canEdit && !disabled}
          requiresSavedPlan={!editor.current}
          onConnectionChange={setBrandConnection}
          onApplied={(plan) => {
            setBrandConnection(plan.brandConnection ?? null);
            void refresh(false);
            onChanged();
          }}
        />
        <section className="grid min-w-0 gap-3" aria-label="주택 납부 일정">
          <div>
            <h3 className="text-body font-semibold">계약금·중도금·잔금·옵션</h3>
            <p className="text-caption text-muted-foreground mt-1">
              확인한 금액과 날짜만 적고, 아직 모르는 칸은 비워 두세요.
            </p>
          </div>
          {editor.draft.payments.length === 0 ? (
            <p className="text-body bg-muted rounded-control p-4">
              납부 일정을 추가해 주세요.
            </p>
          ) : null}
          {editor.draft.payments.map((payment, index) => {
            const key = (field: PlanPaymentField) => `p${index}-${field}`;
            const fieldId = (field: PlanPaymentField) => `${formId}-${key(field)}`;
            const hasError = Boolean(
              invalid && "paymentId" in invalid && invalid.paymentId === payment.id
            );
            return (
            <details
              key={payment.id}
              data-plan-inputs="true"
              open={Boolean(formError) || hasError || !existingPayments.has(payment.id)}
              className="group rounded-card min-w-0 border"
            >
              <summary className="focus-visible:outline-ring rounded-card flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 p-3 focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">
                  <span className="text-body block font-semibold">납부 일정 {index + 1} · {PAYMENT_LABELS[payment.kind]}{payment.installment ? ` ${payment.installment}회차` : ""}</span>
                  <span className="text-caption text-muted-foreground mt-1 block">{payment.dueDate ? `예정일 ${formatMonthDay(payment.dueDate)}` : "예정일 미입력"}</span>
                  <span className="text-caption text-muted-foreground mt-1 block">
                    {paymentMetaCaption(payment)}
                  </span>
                </span>
                <ChevronDown className="text-muted-foreground size-5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <fieldset disabled={disabled} className="grid min-w-0 gap-3 border-t p-3">
                <legend className="sr-only">납부 일정 {index + 1} 입력</legend>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="grid content-start gap-1.5">
                    <Label htmlFor={`${formId}-p${index}-kind`}>항목</Label>
                    <select
                      id={`${formId}-p${index}-kind`}
                      className={NATIVE_SELECT}
                      value={payment.kind}
                      onChange={(e) =>
                        updatePayment(
                          payment.id,
                          "kind",
                          e.target.value as ManualHousingPaymentKind
                        )
                      }
                    >
                      {Object.entries(PAYMENT_LABELS).map(([kind, label]) => (
                        <option key={kind} value={kind}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid content-start gap-1.5">
                    <Label htmlFor={fieldId("installment")}>회차 · 선택</Label>
                    <Input
                      id={fieldId("installment")}
                      value={payment.installment}
                      maxLength={4}
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="예: 1"
                      {...invalidProps(paymentError(payment.id, "installment"), key("installment"))}
                      onChange={(e) =>
                        updatePayment(payment.id, "installment", e.target.value)
                      }
                    />
                    {paymentError(payment.id, "installment") ? (
                      <FieldError id={errorId(key("installment"))}>
                        {paymentError(payment.id, "installment")}
                      </FieldError>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={fieldId("amount")}>예정 금액</Label>
                  <KrwAmountField
                    id={fieldId("amount")}
                    value={payment.amount}
                    placeholder="모르면 비워 두세요"
                    {...invalidProps(paymentError(payment.id, "amount"), key("amount"))}
                    onValueChange={(raw) =>
                      updatePayment(payment.id, "amount", raw)
                    }
                  />
                  {paymentError(payment.id, "amount") ? (
                    <FieldError id={errorId(key("amount"))}>
                      {paymentError(payment.id, "amount")}
                    </FieldError>
                  ) : null}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={fieldId("dueDate")}>납부 예정일 · 선택</Label>
                  <Input
                    id={fieldId("dueDate")}
                    type="date"
                    className="min-w-0"
                    value={payment.dueDate}
                    {...invalidProps(paymentError(payment.id, "dueDate"), key("dueDate"))}
                    onChange={(e) =>
                      updatePayment(payment.id, "dueDate", e.target.value)
                    }
                  />
                  {paymentError(payment.id, "dueDate") ? (
                    <FieldError id={errorId(key("dueDate"))}>
                      {paymentError(payment.id, "dueDate")}
                    </FieldError>
                  ) : null}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={fieldId("paidAmount")}>이미 낸 금액</Label>
                  <KrwAmountField
                    id={fieldId("paidAmount")}
                    value={payment.paidAmount}
                    aria-invalid={paymentError(payment.id, "paidAmount") ? true : undefined}
                    aria-describedby={
                      paymentError(payment.id, "paidAmount")
                        ? `${errorId(key("paidAmount"))} ${fieldId("paidAmount")}-help`
                        : `${fieldId("paidAmount")}-help`
                    }
                    onValueChange={(raw) =>
                      updatePayment(payment.id, "paidAmount", raw)
                    }
                  />
                  {paymentError(payment.id, "paidAmount") ? (
                    <FieldError id={errorId(key("paidAmount"))}>
                      {paymentError(payment.id, "paidAmount")}
                    </FieldError>
                  ) : null}
                  <p
                    id={`${fieldId("paidAmount")}-help`}
                    className="text-caption text-muted-foreground"
                  >
                    아직 낸 돈이 없으면 0을, 확인하지 못했다면 빈칸으로 두세요.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={fieldId("paidDate")}>실제 납부일 · 선택</Label>
                  <Input
                    id={fieldId("paidDate")}
                    type="date"
                    className="min-w-0"
                    value={payment.paidDate}
                    {...invalidProps(paymentError(payment.id, "paidDate"), key("paidDate"))}
                    onChange={(e) =>
                      updatePayment(payment.id, "paidDate", e.target.value)
                    }
                  />
                  {paymentError(payment.id, "paidDate") ? (
                    <FieldError id={errorId(key("paidDate"))}>
                      {paymentError(payment.id, "paidDate")}
                    </FieldError>
                  ) : null}
                </div>
                {!existingPayments.has(payment.id) && editor.canEdit ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 whitespace-normal"
                    onClick={() =>
                      set(
                        "payments",
                        editor.draft.payments.filter((p) => p.id !== payment.id)
                      )
                    }
                  >
                    이 일정 빼기
                  </Button>
                ) : null}
              </fieldset>
            </details>
            );
          })}
          {editor.canEdit ? (
            <Button
              type="button"
              variant="weak"
              className="min-h-11"
              disabled={disabled || editor.draft.payments.length >= 100}
              onClick={() =>
                set("payments", [
                  ...editor.draft.payments,
                  paymentDraft(crypto.randomUUID()),
                ])
              }
            >
              <Plus className="size-5" aria-hidden="true" />
              납부 일정 추가하기
            </Button>
          ) : null}
        </section>
        <details
          data-plan-inputs="true"
          open={Boolean(formError) || Boolean(editor.current?.item.fundingNote?.trim())}
          className="group rounded-card min-w-0 border"
        >
          <summary className="text-body focus-visible:outline-ring rounded-card flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 p-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
            자금 마련 메모 · 선택
            <ChevronDown className="text-muted-foreground size-5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="grid min-w-0 gap-1.5 border-t p-3">
            <Label htmlFor={`${formId}-note`} className="sr-only">
              자금 마련 메모
            </Label>
            <Textarea
              id={`${formId}-note`}
              rows={4}
              maxLength={2000}
              value={editor.draft.fundingNote}
              disabled={disabled}
              placeholder="예: 적금 만기분과 중도금 대출"
              aria-describedby={`${formId}-note-help`}
              onChange={(e) => set("fundingNote", e.target.value)}
            />
            <p
              id={`${formId}-note-help`}
              className="text-caption text-muted-foreground"
            >
              가족 모두에게 보여요. 전체 계좌번호나 비밀번호는 적지 마세요.
            </p>
          </div>
        </details>
        <p className="text-caption text-muted-foreground">
          일정과 낸 금액을 적어 두는 곳이에요. 실제 이체나 계약은 바뀌지 않고,
          자산 합계나 자금 예측에도 넣지 않아요.
        </p>
      </form>
      {editor.latest ? (
        <section className="bg-muted rounded-card grid gap-2 p-3">
          <h3 className="text-body font-semibold">현재 저장된 기록</h3>
          <p className="text-body break-words">
            {editor.latest.item.label} · 입주연도{" "}
            {editor.latest.item.occupancyYear ?? "미입력"} · 납부 일정{" "}
            {editor.latest.payments.length}개
          </p>
          <ConfirmAction
            label="저장된 내용 불러오기"
            title="저장된 내용으로 바꿀까요?"
            description="지금 입력한 내용은 사라지고, 최신 내용과 납부 일정으로 바뀌어요."
            disabled={editor.busy}
            onConfirm={editor.resetLatest}
          />
        </section>
      ) : null}
      {editor.current && editor.canEdit ? (
        <ConfirmAction
          appearance="text"
          label="삭제하기"
          title="이 주택을 삭제할까요?"
          description="주택과 납부 일정이 목록에서 빠져요. 실제 계약과 납부는 그대로예요."
          destructive
          disabled={disabled}
          onConfirm={() => void editor.remove()}
        />
      ) : null}
    </RecordDialog>
  );
}
