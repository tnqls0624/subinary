"use client";

import { useId } from "react";
import type {
  ManualHousingPaymentKind,
  ManualHousingPlanResponse,
} from "@family/contracts";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import {
  manualFinanceApi,
  useManualFinanceRefresh,
} from "@/lib/manual-finance-client";
import { PAYMENT_LABELS, paymentDraft, planDraft, planRequest } from "./model";
import { ConfirmAction, RecordDialog, VisibilityField } from "./shared";
import { useRecordEditor } from "./use-record-editor";

export function PlanEditor({
  householdId,
  initial,
  observedVersion,
  onChanged,
  onClose,
}: {
  householdId: string;
  initial?: ManualHousingPlanResponse;
  observedVersion?: number;
  onChanged: () => void;
  onClose: () => void;
}) {
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
      payments: old.payments.map((payment) =>
        payment.id === id ? { ...payment, [key]: value } : payment
      ),
    }));
  return (
    <RecordDialog
      title={
        editor.current
          ? editor.canEdit
            ? "주택 계획 수정"
            : editor.current.item.visibility === "private"
              ? "비공개 주택 계획"
              : "공유 주택 계획"
          : "주택 계획 추가"
      }
      description="계약서에서 확인한 납부 일정과 금액을 입력해 주세요."
      dirty={editor.dirty}
      busy={editor.busy}
      pending={editor.pending}
      readRequired={editor.readRequired}
      invalidate={editor.invalidate}
      onClose={onClose}
      footer={
        editor.canEdit ? (
          <>
            <Button
              form={formId}
              type="submit"
              className="min-h-11 w-full"
              disabled={disabled}
            >
              {editor.phase === "saving" ? "저장 중…" : "저장"}
            </Button>
            {editor.current ? (
              <ConfirmAction
                label="계획 삭제"
                title="이 주택 계획을 삭제할까요?"
                description="계획과 납부 일정이 목록에서 제외돼요. 실제 계약과 납부는 취소되지 않아요. 개인정보 전체 삭제와는 달라요."
                destructive
                disabled={disabled}
                onConfirm={() => void editor.remove()}
              />
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            추가한 사람만 내용을 수정할 수 있어요.
          </p>
        )
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void editor.save(event)}
        noValidate
        className="grid min-w-0 gap-4"
        aria-busy={editor.busy}
      >
        <label className="grid gap-2 text-sm font-medium">
          계획 이름
          <Input
            className="h-11"
            value={editor.draft.label}
            disabled={disabled}
            maxLength={100}
            autoComplete="off"
            placeholder="예: 풍무수자인 1차 59B"
            onChange={(e) => set("label", e.target.value)}
          />
          <span className="text-muted-foreground text-xs font-normal">
            알아보기 쉬운 주택 이름을 적어주세요.
          </span>
        </label>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium">
            입주연도 · 선택
            <Input
              className="h-11"
              value={editor.draft.occupancyYear}
              disabled={disabled}
              maxLength={4}
              inputMode="numeric"
              autoComplete="off"
              placeholder="미확인"
              onChange={(e) => set("occupancyYear", e.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            계약 단계 · 선택
            <Input
              className="h-11"
              value={editor.draft.contractStage}
              disabled={disabled}
              maxLength={100}
              autoComplete="off"
              placeholder="확인한 경우만 입력"
              onChange={(e) => set("contractStage", e.target.value)}
            />
          </label>
        </div>
        <VisibilityField
          value={editor.draft.visibility}
          creating={!editor.current}
        />
        <section className="grid min-w-0 gap-3" aria-label="주택 납부 일정">
          <div>
            <h3 className="font-semibold">계약금·중도금·잔금·옵션</h3>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              확인한 금액과 날짜를 적고, 아직 모르는 항목은 비워두세요.
            </p>
          </div>
          {editor.draft.payments.length === 0 ? (
            <p className="bg-muted rounded-lg p-4 text-sm">
              납부 일정을 추가해 주세요.
            </p>
          ) : null}
          {editor.draft.payments.map((payment, index) => (
            <fieldset
              key={payment.id}
              disabled={disabled}
              className="grid min-w-0 gap-3 rounded-xl border p-3"
            >
              <legend className="px-1 text-sm font-semibold">
                납부 일정 {index + 1}
              </legend>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <label className="grid gap-2 text-sm">
                  항목
                  <select
                    aria-label={`납부 일정 ${index + 1} 항목`}
                    className="bg-background h-11 rounded-md border px-3"
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
                </label>
                <label className="grid gap-2 text-sm">
                  회차 · 선택
                  <Input
                    className="h-11"
                    value={payment.installment}
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="미입력"
                    onChange={(e) =>
                      updatePayment(payment.id, "installment", e.target.value)
                    }
                  />
                </label>
              </div>
              <label className="grid gap-2 text-sm">
                예정 금액 · 원
                <Input
                  className="h-11 tabular-nums"
                  value={payment.amount}
                  maxLength={26}
                  inputMode="numeric"
                  placeholder="모르면 비워두세요"
                  onChange={(e) =>
                    updatePayment(payment.id, "amount", e.target.value)
                  }
                />
              </label>
              <label className="grid gap-2 text-sm">
                납부 예정일 · 선택
                <Input
                  type="date"
                  className="h-11 min-w-0"
                  value={payment.dueDate}
                  onChange={(e) =>
                    updatePayment(payment.id, "dueDate", e.target.value)
                  }
                />
              </label>
              <label className="grid gap-2 text-sm">
                이미 납부한 금액 · 원
                <Input
                  className="h-11 tabular-nums"
                  value={payment.paidAmount}
                  maxLength={26}
                  inputMode="numeric"
                  placeholder="미확인이면 비워두세요"
                  onChange={(e) =>
                    updatePayment(payment.id, "paidAmount", e.target.value)
                  }
                />
                <span className="text-muted-foreground text-xs">
                  아직 낸 돈이 없으면 0을, 확인하지 못했다면 빈칸으로 두세요.
                </span>
              </label>
              <label className="grid gap-2 text-sm">
                실제 납부일 · 선택
                <Input
                  type="date"
                  className="h-11 min-w-0"
                  value={payment.paidDate}
                  onChange={(e) =>
                    updatePayment(payment.id, "paidDate", e.target.value)
                  }
                />
              </label>
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
          ))}
          {editor.canEdit ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={disabled || editor.draft.payments.length >= 100}
              onClick={() =>
                set("payments", [
                  ...editor.draft.payments,
                  paymentDraft(crypto.randomUUID()),
                ])
              }
            >
              <Plus className="size-4" />
              납부 일정 추가
            </Button>
          ) : null}
        </section>
        <label className="grid gap-2 text-sm font-medium">
          자금 마련 메모 · 선택
          <textarea
            rows={4}
            maxLength={2000}
            className="bg-background min-h-24 min-w-0 rounded-md border p-3 font-normal"
            value={editor.draft.fundingNote}
            disabled={disabled}
            placeholder="어디서 자금을 마련할지 적어주세요. 전체 계좌번호나 비밀번호는 적지 마세요."
            onChange={(e) => set("fundingNote", e.target.value)}
          />
          <span className="text-muted-foreground text-xs font-normal leading-relaxed">
            가족과 공유한 계획은 이 메모도 함께 보여요.
          </span>
        </label>
        <details className="text-muted-foreground text-xs leading-relaxed">
          <summary className="min-h-11 cursor-pointer py-3">납부 기록 안내</summary>
          <p className="pb-3">이 화면은 일정과 납부 내역을 적는 곳이에요. 실제 이체나 계약 변경은 하지 않아요. 아직 확인하지 못한 금액과 날짜는 비워두세요.</p>
          <p className="pb-3">자금 마련 메모는 참고용이며 자금 배정이나 현금 흐름 예측에 반영되지 않아요. 계약금액과 납부액도 현재 자산 합계에 포함하지 않아요.</p>
        </details>
      </form>
      {editor.error ? (
        <p role="alert" className="text-destructive text-sm break-words">
          {editor.error}
        </p>
      ) : null}
      {editor.notice ? (
        <p role="status" className="text-muted-foreground text-sm break-words">
          {editor.notice}
        </p>
      ) : null}
      {editor.busy ? (
        <p role="status" className="text-muted-foreground text-sm">
          {editor.phase === "reading"
            ? "현재 기록을 확인하고 있어요."
            : editor.phase === "removing"
            ? "삭제 결과를 확인하고 있어요."
            : "주택 계획을 저장하고 있어요."}
        </p>
      ) : null}
      {editor.readRequired ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 h-auto whitespace-normal"
          disabled={editor.busy}
          onClick={() => void editor.read()}
        >
          저장 상태 확인
        </Button>
      ) : null}
      {editor.latest ? (
        <section className="bg-muted grid gap-2 rounded-lg p-3 text-sm">
          <h3 className="font-semibold">현재 저장된 기록</h3>
          <p className="break-words">
            {editor.latest.item.label} · 입주연도{" "}
            {editor.latest.item.occupancyYear ?? "미확인"} · 납부 일정{" "}
            {editor.latest.payments.length}개
          </p>
          <ConfirmAction
            label="저장된 내용 불러오기"
            title="저장된 내용으로 바꿀까요?"
            description="지금 입력한 내용은 사라지고, 최신 계획과 납부 일정으로 바뀌어요."
            disabled={editor.busy}
            onConfirm={editor.resetLatest}
          />
        </section>
      ) : null}
    </RecordDialog>
  );
}
