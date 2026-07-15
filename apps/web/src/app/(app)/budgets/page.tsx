"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 예산 관리 (Phase 5 §6.2 P8)
 *
 * - 예산 목록: UsageBar(스코프 라벨 / 사용 / 한도 / 사용률). 서버가 현재월 순지출을
 *   SQL로 집계·공개범위 반영해 내려준 값을 그대로 표시(JS 합산 없음).
 * - 생성 폼: scopeType + (member/category/card면) 대상 select + 월 예산 금액(KRW 정수).
 * - 수정(이름/금액) / 삭제. 예산 CRUD는 owner/admin만(PRD §7.2, 서버에서도 강제).
 * ------------------------------------------------------------------------- */
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  BudgetCreateRequest,
  BudgetScopeType,
  BudgetSummary,
  BudgetUpdateRequest,
} from "@family/contracts";

import {
  Button,
  Field,
  Modal,
  Select,
  UsageBar,
  type SelectOption,
} from "@/components";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import {
  useBudgets,
  useCardList,
  useCategoryList,
  useHouseholdMembers,
} from "@/lib/queries";
import { formatMonth } from "@/lib/format";

/** 스코프 종류 표시 라벨(목록 meta / 폼 옵션 공용). */
const SCOPE_TYPE_LABEL: Record<BudgetScopeType, string> = {
  household: "가족 전체",
  member: "구성원",
  category: "카테고리",
  card: "카드",
};

const SCOPE_OPTIONS: ReadonlyArray<SelectOption> = (
  ["household", "member", "category", "card"] as const
).map((value) => ({ value, label: SCOPE_TYPE_LABEL[value] }));

/** 사람이 읽을 에러 메시지. */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** '' / 비정수 / 0 이하를 걸러 양의 정수만 반환. */
function parsePositiveInt(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export default function BudgetsPage() {
  const { authedFetch } = useAuth();
  const { householdId, activeMembership } = useHousehold();
  const queryClient = useQueryClient();

  const canManage =
    activeMembership?.role === "owner" || activeMembership?.role === "admin";

  const budgetsQuery = useBudgets();
  const membersQuery = useHouseholdMembers();
  const categoriesQuery = useCategoryList();
  const cardsQuery = useCardList();

  // --- 생성 폼 상태 ---------------------------------------------------------
  const [scopeType, setScopeType] = useState<BudgetScopeType>("household");
  const [scopeRefId, setScopeRefId] = useState("");
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // --- 수정 모달 상태 -------------------------------------------------------
  const [editing, setEditing] = useState<BudgetSummary | null>(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const invalidateBudgets = () =>
    queryClient.invalidateQueries({ queryKey: ["budgets", householdId] });

  const createMutation = useMutation({
    mutationFn: (body: BudgetCreateRequest) =>
      authedFetch((token) => api.budgets.create(token, body)),
    onSuccess: () => {
      void invalidateBudgets();
      setScopeRefId("");
      setAmount("");
      setName("");
      setFormError(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; body: BudgetUpdateRequest }) =>
      authedFetch((token) =>
        api.budgets.update(token, input.id, input.body),
      ),
    onSuccess: () => {
      void invalidateBudgets();
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.budgets.delete(token, id)),
    onSuccess: () => void invalidateBudgets(),
  });

  // 대상(scopeRef) 옵션은 scopeType에 따라 달라진다.
  const scopeRefOptions = useMemo<ReadonlyArray<SelectOption>>(() => {
    switch (scopeType) {
      case "member":
        return (membersQuery.data ?? [])
          .filter((m) => m.status === "active")
          .map((m) => ({ value: m.memberId, label: m.name }));
      case "category":
        return (categoriesQuery.data ?? []).map((c) => ({
          value: c.id,
          label: c.name,
        }));
      case "card":
        return (cardsQuery.data ?? []).map((c) => ({
          value: c.id,
          label: c.alias,
        }));
      default:
        return [];
    }
  }, [scopeType, membersQuery.data, categoriesQuery.data, cardsQuery.data]);

  function onScopeTypeChange(next: BudgetScopeType) {
    setScopeType(next);
    setScopeRefId("");
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!householdId) return;

    const parsedAmount = parsePositiveInt(amount);
    if (parsedAmount === null) {
      setFormError("예산 금액은 1 이상의 정수(원)여야 합니다.");
      return;
    }
    if (scopeType !== "household" && scopeRefId === "") {
      setFormError("예산을 적용할 대상을 선택하세요.");
      return;
    }

    const body: BudgetCreateRequest = {
      householdId,
      scopeType,
      amount: parsedAmount,
      ...(name.trim() !== "" ? { name: name.trim() } : {}),
      ...(scopeType !== "household" ? { scopeRefId } : {}),
    };
    createMutation.mutate(body);
  }

  function openEdit(budget: BudgetSummary) {
    setEditing(budget);
    setEditName(budget.name ?? "");
    setEditAmount(String(budget.amount));
    setEditError(null);
  }

  function onUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setEditError(null);

    const parsedAmount = parsePositiveInt(editAmount);
    if (parsedAmount === null) {
      setEditError("예산 금액은 1 이상의 정수(원)여야 합니다.");
      return;
    }
    const body: BudgetUpdateRequest = {
      amount: parsedAmount,
      ...(editName.trim() !== "" ? { name: editName.trim() } : {}),
    };
    updateMutation.mutate({ id: editing.id, body });
  }

  function onDelete(budget: BudgetSummary) {
    const label = budget.name ?? budget.scopeLabel;
    if (!window.confirm(`'${label}' 예산을 삭제할까요?`)) return;
    deleteMutation.mutate(budget.id);
  }

  const items = budgetsQuery.data?.items ?? [];
  const month = budgetsQuery.data?.month;

  return (
    <div className="stack">
      <h1 className="section-title">예산</h1>

      {/* 목록 ------------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-title">
          예산 사용률{month ? ` · ${formatMonth(month)}` : ""}
        </div>

        {budgetsQuery.isLoading ? (
          <p className="empty">불러오는 중…</p>
        ) : budgetsQuery.isError ? (
          <p className="form-error" role="alert">
            {errorMessage(
              budgetsQuery.error,
              "예산을 불러오지 못했습니다.",
            )}
          </p>
        ) : items.length === 0 ? (
          <p className="empty">등록된 예산이 없습니다.</p>
        ) : (
          <div>
            {items.map((budget) => (
              <UsageBar
                key={budget.id}
                label={budget.scopeLabel}
                spent={budget.spent}
                amount={budget.amount}
                usageRate={budget.usageRate}
                meta={
                  <span className="row" style={{ gap: 8 }}>
                    <span>{SCOPE_TYPE_LABEL[budget.scopeType]}</span>
                    {canManage ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEdit(budget)}
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => onDelete(budget)}
                          disabled={deleteMutation.isPending}
                        >
                          삭제
                        </button>
                      </>
                    ) : null}
                  </span>
                }
              />
            ))}
          </div>
        )}

        {deleteMutation.isError ? (
          <p className="form-error" role="alert" style={{ marginTop: 12 }}>
            {errorMessage(deleteMutation.error, "삭제에 실패했습니다.")}
          </p>
        ) : null}
      </section>

      {/* 생성 폼 ---------------------------------------------------------- */}
      {canManage ? (
        <section className="panel">
          <div className="panel-title">예산 추가</div>
          <form className="stack" onSubmit={onCreate} noValidate>
            <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
              <label className="field">
                <span className="field-label">스코프</span>
                <Select
                  options={SCOPE_OPTIONS}
                  value={scopeType}
                  onChange={(e) =>
                    onScopeTypeChange(e.target.value as BudgetScopeType)
                  }
                />
              </label>

              {scopeType !== "household" ? (
                <label className="field">
                  <span className="field-label">대상</span>
                  <Select
                    options={scopeRefOptions}
                    placeholder="대상 선택"
                    value={scopeRefId}
                    onChange={(e) => setScopeRefId(e.target.value)}
                  />
                </label>
              ) : null}
            </div>

            <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
              <Field
                label="이름 (선택)"
                name="budget-name"
                type="text"
                placeholder="예: 이번 달 식비"
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Field
                label="월 예산 (원)"
                name="budget-amount"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                placeholder="500000"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
            {createMutation.isError ? (
              <p className="form-error" role="alert">
                {errorMessage(
                  createMutation.error,
                  "예산 생성에 실패했습니다.",
                )}
              </p>
            ) : null}

            <div>
              <Button
                type="submit"
                variant="primary"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "추가 중…" : "예산 추가"}
              </Button>
            </div>
          </form>
        </section>
      ) : (
        <p className="text-subtle">
          예산 생성·수정·삭제는 소유자 또는 관리자만 할 수 있습니다.
        </p>
      )}

      {/* 수정 모달 -------------------------------------------------------- */}
      <Modal
        open={editing !== null}
        title="예산 수정"
        onClose={() => setEditing(null)}
      >
        <form className="stack" onSubmit={onUpdate} noValidate>
          <p className="text-muted" style={{ margin: 0 }}>
            {editing ? editing.scopeLabel : ""}
          </p>
          <Field
            label="이름 (선택)"
            name="edit-budget-name"
            type="text"
            maxLength={100}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <Field
            label="월 예산 (원)"
            name="edit-budget-amount"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            required
            value={editAmount}
            onChange={(e) => setEditAmount(e.target.value)}
          />
          {editError ? (
            <p className="form-error" role="alert">
              {editError}
            </p>
          ) : null}
          {updateMutation.isError ? (
            <p className="form-error" role="alert">
              {errorMessage(updateMutation.error, "수정에 실패했습니다.")}
            </p>
          ) : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              취소
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "저장 중…" : "저장"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
