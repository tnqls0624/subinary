"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 예산 (오늘의집 톤)
 *
 * - 예산 목록: 예산 1건 = Card 1장(UsageBar + 상태 해요체 카피 + 수정/삭제).
 *   서버가 현재월 순지출을 SQL로 집계·공개범위 반영해 내려준 값을 그대로 표시.
 * - 상태 카피: usageRate 80%↑ 경고(text-warning), 100%↑ 초과(text-destructive).
 * - 생성: 상단 우측 "예산 만들기" 주 CTA → Dialog("얼마까지 쓸까요?").
 *   scopeType + (member/category/card면) 대상 select + 월 예산 금액(KRW 정수).
 * - 수정(이름/금액) Dialog / 삭제 AlertDialog(질문형). CRUD는 owner/admin만
 *   (PRD §7.2, 서버에서도 강제). 조건부 대상 필드가 있어 폼은 useState 유지.
 * ------------------------------------------------------------------------- */
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Wallet } from "lucide-react";

import type {
  BudgetCreateRequest,
  BudgetScopeType,
  BudgetSummary,
  BudgetUpdateRequest,
} from "@family/contracts";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { UsageBar } from "@/components/widgets";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import {
  useBudgets,
  useCardList,
  useCategoryList,
  useHouseholdMembers,
} from "@/lib/queries";
import { formatMonth, formatWon } from "@/lib/format";

/** select 옵션(로컬 타입). */
type Option = { value: string; label: string };

/** 스코프 종류 표시 라벨(목록 meta / 폼 옵션 공용). */
const SCOPE_TYPE_LABEL: Record<BudgetScopeType, string> = {
  household: "가족 전체",
  member: "구성원",
  category: "카테고리",
  card: "카드",
};

const SCOPE_OPTIONS: ReadonlyArray<Option> = (
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

/** 사용률 기반 상태 카피(해요체). 기존 usageRate 데이터로만 계산. */
function BudgetStatusLine({ budget }: { budget: BudgetSummary }) {
  if (budget.usageRate >= 1) {
    const overBy = budget.spent - budget.amount;
    return (
      <p className="text-destructive text-[13px] font-medium">
        {overBy > 0
          ? `예산을 ${formatWon(overBy)} 넘었어요`
          : "예산을 모두 썼어요"}
      </p>
    );
  }
  if (budget.usageRate >= 0.8) {
    return (
      <p className="text-warning text-[13px] font-medium">
        예산이 얼마 안 남았어요
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-[13px]">
      {formatWon(budget.amount - budget.spent)} 더 쓸 수 있어요
    </p>
  );
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

  // --- 생성 다이얼로그 상태 ---------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
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

  // --- 삭제 확인 상태 -------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = useState<BudgetSummary | null>(null);

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
      setCreateOpen(false);
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
  const scopeRefOptions = useMemo<ReadonlyArray<Option>>(() => {
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
      setFormError("예산 금액은 1원 이상의 정수로 입력해 주세요.");
      return;
    }
    if (scopeType !== "household" && scopeRefId === "") {
      setFormError("예산을 적용할 대상을 선택해 주세요.");
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
      setEditError("예산 금액은 1원 이상의 정수로 입력해 주세요.");
      return;
    }
    const body: BudgetUpdateRequest = {
      amount: parsedAmount,
      ...(editName.trim() !== "" ? { name: editName.trim() } : {}),
    };
    updateMutation.mutate({ id: editing.id, body });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id);
    setDeleteTarget(null);
  }

  const items = budgetsQuery.data?.items ?? [];
  const month = budgetsQuery.data?.month;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* 페이지 헤더 + 주 CTA(상단 우측) ----------------------------------- */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">예산</h1>
          <p className="text-muted-foreground text-sm">
            이번 달 얼마나 썼는지 한눈에 확인해요
          </p>
        </div>
        {canManage && items.length > 0 ? (
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus />
            예산 만들기
          </Button>
        ) : null}
      </div>

      {/* 목록 ------------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-foreground text-[13px] font-semibold">
          이번 달 예산{month ? ` · ${formatMonth(month)}` : ""}
        </h2>

        {budgetsQuery.isLoading ? (
          [0, 1].map((i) => (
            <Card key={i}>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-2 w-full rounded-full" />
                <Skeleton className="h-4 w-44" />
              </CardContent>
            </Card>
          ))
        ) : budgetsQuery.isError ? (
          <Card>
            <CardContent>
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(
                  budgetsQuery.error,
                  "예산을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
                )}
              </p>
            </CardContent>
          </Card>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="bg-accent text-accent-foreground flex size-12 items-center justify-center rounded-full">
                <Wallet className="size-6" aria-hidden="true" />
              </span>
              <p className="mt-1 text-[15px] font-semibold">
                아직 예산이 없어요
              </p>
              <p className="text-muted-foreground text-sm">
                예산을 만들어 두면 넘치기 전에 미리 알 수 있어요
              </p>
              {canManage ? (
                <Button
                  type="button"
                  size="lg"
                  className="mt-3"
                  onClick={() => setCreateOpen(true)}
                >
                  예산 만들기
                </Button>
              ) : (
                <p className="text-muted-foreground text-[13px]">
                  예산은 가족의 소유자나 관리자가 만들 수 있어요
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          items.map((budget) => (
            <Card key={budget.id}>
              <CardContent className="flex flex-col gap-3">
                <UsageBar
                  label={budget.name ?? budget.scopeLabel}
                  spent={budget.spent}
                  amount={budget.amount}
                  usageRate={budget.usageRate}
                  meta={
                    budget.name
                      ? `${SCOPE_TYPE_LABEL[budget.scopeType]} · ${budget.scopeLabel}`
                      : SCOPE_TYPE_LABEL[budget.scopeType]
                  }
                />
                <div className="flex items-center justify-between gap-2">
                  <BudgetStatusLine budget={budget} />
                  {canManage ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(budget)}
                      >
                        수정
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(budget)}
                        disabled={deleteMutation.isPending}
                      >
                        삭제
                      </Button>
                    </span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))
        )}

        {deleteMutation.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {errorMessage(
              deleteMutation.error,
              "예산을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.",
            )}
          </p>
        ) : null}

        {!canManage && items.length > 0 ? (
          <p className="text-muted-foreground text-[13px]">
            예산 만들기와 수정은 가족의 소유자나 관리자가 할 수 있어요
          </p>
        ) : null}
      </section>

      {/* 생성 다이얼로그 ---------------------------------------------------- */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          if (!o) setFormError(null);
          setCreateOpen(o);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>얼마까지 쓸까요?</DialogTitle>
            <DialogDescription>
              한 달 예산을 정해 두면 사용률을 함께 지켜봐 드려요
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={onCreate} noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="budget-scope">적용 범위</Label>
              <Select
                value={scopeType}
                onValueChange={(v) => onScopeTypeChange(v as BudgetScopeType)}
              >
                <SelectTrigger id="budget-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {scopeType !== "household" ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="budget-scope-ref">대상</Label>
                <Select value={scopeRefId} onValueChange={setScopeRefId}>
                  <SelectTrigger id="budget-scope-ref" className="w-full">
                    <SelectValue placeholder="누구(무엇)의 예산인지 골라 주세요" />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeRefOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="budget-name">예산 이름 (선택)</Label>
              <Input
                id="budget-name"
                name="budget-name"
                type="text"
                placeholder="예: 이번 달 식비"
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="budget-amount">한 달 예산 (원)</Label>
              <Input
                id="budget-amount"
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
              <p className="text-destructive text-sm" role="alert">
                {formError}
              </p>
            ) : null}
            {createMutation.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(
                  createMutation.error,
                  "예산을 만들지 못했어요. 잠시 후 다시 시도해 주세요.",
                )}
              </p>
            ) : null}

            <DialogFooter className="flex-col sm:flex-col">
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "만드는 중…" : "예산 만들기"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setCreateOpen(false)}
              >
                취소
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 수정 모달 -------------------------------------------------------- */}
      <Dialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>예산을 수정해요</DialogTitle>
            <DialogDescription>
              {editing
                ? `'${editing.scopeLabel}' 예산의 이름과 금액을 바꿀 수 있어요`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={onUpdate}
            noValidate
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-budget-name">예산 이름 (선택)</Label>
              <Input
                id="edit-budget-name"
                name="edit-budget-name"
                type="text"
                maxLength={100}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-budget-amount">한 달 예산 (원)</Label>
              <Input
                id="edit-budget-amount"
                name="edit-budget-amount"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                required
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
              />
            </div>
            {editError ? (
              <p className="text-destructive text-sm" role="alert">
                {editError}
              </p>
            ) : null}
            {updateMutation.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {errorMessage(
                  updateMutation.error,
                  "수정 내용을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
                )}
              </p>
            ) : null}
            <DialogFooter className="flex-col sm:flex-col">
              <Button
                type="submit"
                className="h-11 w-full"
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? "저장하는 중…" : "저장하기"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setEditing(null)}
              >
                취소
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 삭제 확인 -------------------------------------------------------- */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>이 예산을 삭제할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `'${deleteTarget.name ?? deleteTarget.scopeLabel}' 예산이 목록에서 사라져요. 기록된 거래 내역은 그대로 남아요.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-col">
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-11 w-full"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "삭제하기"
              )}
            </AlertDialogAction>
            <AlertDialogCancel className="h-11 w-full border-0 bg-transparent">
              취소
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
