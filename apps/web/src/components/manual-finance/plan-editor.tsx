"use client";

import { useId, useState } from "react";
import type {
  ManualHousingPaymentKind,
  ManualHousingPlanResponse,
} from "@family/contracts";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { InlineNotice } from "@/components/widgets/inline-notice";
import { useAuth } from "@/lib/auth-context";
import {
  manualFinanceApi,
  useManualFinanceRefresh,
} from "@/lib/manual-finance-client";
import {
  PAYMENT_LABELS,
  paymentDraft,
  planDraft,
  planRequest,
} from "./model";
import { planFieldError, type PlanPaymentField } from "./field-errors";
import { KrwAmountField } from "./krw-amount-field";
import { PlanDetailSheet } from "./plan-detail-sheet";
import { draftPaymentSummary, mergePlanRead } from "./plan-summary";
import {
  ConfirmAction,
  FieldError,
  NATIVE_SELECT,
  RecordDialog,
} from "./shared";
import { useRecordEditor } from "./use-record-editor";

type PlanEditorProps = {
  householdId: string;
  initial?: ManualHousingPlanResponse;
  observedVersion?: number;
  onClose: () => void;
};

/**
 * 주택 창(2026-11-08 PO 재설계 '보기 먼저'). 저장된 주택은 편집 권한이 있어도 상세 시트가 먼저 열리고,
 * '수정하기'를 누르면 시트를 닫고 입력 폼을 연다(창을 겹치지 않는다). 폼을 저장하거나 그냥 닫으면 상세 시트로
 * 돌아온다 — 수정은 상세의 한 단계라서다. 새 주택은 지금처럼 폼이 바로 열리고, 저장하면 그 주택의 상세 시트가
 * 열려 수자인 연결을 이어서 할 수 있다. 삭제했거나 권한이 바뀌면 둘 다 닫는다.
 */
export function PlanEditor({
  householdId,
  initial,
  observedVersion,
  onClose,
}: PlanEditorProps) {
  const [plan, setPlan] = useState(initial);
  const [editing, setEditing] = useState(!initial);
  if (plan && !(editing && plan.item.canEdit))
    return (
      <PlanDetailSheet
        householdId={householdId}
        plan={plan}
        observedVersion={observedVersion}
        onPlanChange={(update) =>
          setPlan((old) =>
            old ? (typeof update === "function" ? update(old) : update) : old
          )
        }
        onEdit={() => setEditing(true)}
        onClose={onClose}
      />
    );
  return (
    <PlanForm
      householdId={householdId}
      initial={plan}
      observedVersion={observedVersion}
      onSaved={(read) => {
        setPlan((old) => mergePlanRead(old, read));
        setEditing(false);
      }}
      onDismiss={plan ? () => setEditing(false) : onClose}
      onClose={onClose}
    />
  );
}

type PlanFormProps = {
  householdId: string;
  initial?: ManualHousingPlanResponse;
  observedVersion?: number;
  /** 저장(또는 저장된 것을 확인)한 뒤 — 상세 시트로 간다. */
  onSaved: (read: ManualHousingPlanResponse) => void;
  /** 저장하지 않고 닫기(X·뒤로·버리기). */
  onDismiss: () => void;
  /** 삭제했거나 권한·상태가 바뀌어 더 볼 수 없을 때 — 상세 시트까지 닫는다. */
  onClose: () => void;
};

/** 주택 입력 폼. 화면은 PlanEditor 를 거쳐 열고, 여기서 바로 내보내는 것은 서버 렌더 테스트용이다. */
export function PlanForm({
  householdId,
  initial,
  observedVersion,
  onSaved,
  onDismiss,
  onClose,
}: PlanFormProps) {
  const { authedFetch } = useAuth();
  const refresh = useManualFinanceRefresh();
  const formId = useId();
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
    onChanged: onSaved,
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
      onClose={onDismiss}
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
                {/* 한 줄 요약 — 출처·기준 시각·남은 금액 줄은 지웠다(상세 시트가 말한다). */}
                <span className="text-body min-w-0 font-medium break-words">
                  {draftPaymentSummary(payment)}
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
