"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 예산 (오늘의집 톤)
 *
 * - 예산 목록: 예산 1건 = Card 1장(UsageBar + 상태 해요체 카피 + 주 액션).
 *   서버가 현재월 순지출을 SQL로 집계·공개범위 반영해 내려준 값을 그대로 표시.
 * - 주 액션은 '어디서 썼는지 보기'(→ 그 예산 스코프로 필터된 거래 목록, C-7).
 *   수정/삭제는 `⋯` 메뉴로 내렸다 — 초과를 알린 뒤 '예산을 늘려라/지워라'만
 *   제안하는 건 가계부가 줄 수 있는 최악의 조언이다.
 * - 상태 카피: usageRate 80%↑ 경고(text-warning-strong), 100%↑ 초과(text-destructive).
 * - 생성: 상단 우측 "예산 만들기" 주 CTA → Dialog("얼마까지 쓸까요?").
 *   scopeType + (member/category/card면) 대상 select + 월 예산 금액(KRW 정수).
 * - 수정(이름/금액) Dialog / 삭제 AlertDialog(질문형). CRUD는 owner/admin만
 *   (PRD §7.2, 서버에서도 강제). 조건부 대상 필드가 있어 폼은 useState 유지.
 * ------------------------------------------------------------------------- */
import { Suspense, useCallback, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, Plus, Wallet } from "lucide-react";

import type {
  BudgetCreateRequest,
  BudgetCopyRequest,
  BudgetCopyResponse,
  BudgetScopeType,
  BudgetSummary,
  BudgetUpdateRequest,
} from "@family/contracts";
import { budgetCopyResponseSchema } from "@family/contracts";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { EmptyState, MonthSwitcher, UsageBar } from "@/components/widgets";
import { API_BASE_URL, ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { budgetTransactionsHref } from "@/lib/deep-link";
import { useHousehold } from "@/lib/household-context";
import { addMonths, isMonthKey } from "@/lib/month";
import {
  useAnalyticsMonths,
  useBudgets,
  useCardList,
  useCategoryList,
  useHouseholdMembers,
} from "@/lib/queries";
import { currentMonth, formatMoney, formatMonth } from "@/lib/format";

/** select 옵션(로컬 타입). */
type Option = { value: string; label: string };

/** 스코프 종류 표시 라벨(목록 meta / 폼 옵션 공용). */
const SCOPE_TYPE_LABEL: Record<BudgetScopeType, string> = {
  household: "가족 전체",
  member: "구성원",
  category: "카테고리",
  card: "카드",
};

/**
 * 월 계획 복사는 일반 JSON 요청과 달리 `Idempotency-Key` 헤더가 계약의
 * 일부다. 성공 응답도 계약 스키마로 다시 검증해 잘못된 복사 결과를 화면에
 * 확정처럼 보이지 않는다.
 */
async function copyBudgetPlan(
  accessToken: string | null,
  body: BudgetCopyRequest,
  idempotencyKey: string
): Promise<BudgetCopyResponse> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/budgets/copy`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    /**
     * fetch 자체가 거부된 경우다. 네이티브 앱에서 이 요청은 cross-origin이므로
     * preflight를 타는데, 서버 `allowedHeaders`에 `Idempotency-Key`가 없으면 WebView가
     * **본 요청을 보내지도 않고** 취소한다 — 서버 로그에는 아무것도 남지 않는다.
     * 2026-08-20에 폰에서만 이 기능이 죽은 이유이고, 그때는 이 실패가 status 없는
     * TypeError라 `ApiError`도 아니어서 아래 status 분기에 닿지도 못했다.
     */
    throw new ApiError(
      0,
      "서버에 연결하지 못했어요. 앱을 최신으로 업데이트한 뒤 다시 시도해 주세요.",
      undefined
    );
  }
  const responseBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(response.status, copyFailureMessage(response.status), responseBody);
  }
  return budgetCopyResponseSchema.parse(responseBody);
}

/**
 * 실패 사유를 사람 말로 가른다.
 *
 * 전부 "잠시 후 다시 시도해 주세요"로 수렴시켜 두었더니, **재시도가 절대 성공하지 않는
 * 상태에서도 재시도를 권하는** 안내가 나왔다(409는 이미 계획이 있다는 뜻이다). 2026-08-20에
 * 사용자가 원인을 짚지 못한 것도 그래서였다 — 화면 문구가 서버가 말한 것을 지우고 있었다.
 */
function copyFailureMessage(status: number): string {
  switch (status) {
    case 404:
      return "복사할 계획이 없어요. 이번 달 예산을 먼저 만들어 주세요.";
    case 409:
      // 재시도는 영원히 성공하지 않는다. 다음 행동을 알려줘야 한다.
      return "다음 달에 이미 계획이 있어요. 그 달로 이동해 확인해 주세요.";
    case 400:
      return "요청이 올바르지 않아요. 앱을 최신으로 업데이트한 뒤 다시 시도해 주세요.";
    case 401:
      return "로그인이 필요해요.";
    default:
      return "다음 달 계획을 만들지 못했어요. 잠시 후 다시 시도해 주세요.";
  }
}

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
          ? `예산을 ${formatMoney(overBy, budget.currency)} 넘었어요`
          : "예산을 모두 썼어요"}
      </p>
    );
  }
  if (budget.usageRate >= 0.8) {
    return (
      <p className="text-warning-strong text-[13px] font-medium">
        예산이 얼마 안 남았어요
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-[13px]">
      {formatMoney(budget.amount - budget.spent, budget.currency)} 더 쓸 수
      있어요
    </p>
  );
}

/**
 * `useSearchParams`는 Suspense 경계를 요구한다(정적 export 포함) — 예산 화면의
 * 달·필터는 URL이 소유하므로 여기서 경계를 친다. `/login`·`/join`·`/register`가
 * 쓰던 것과 같은 형태로 맞춰, 어떤 화면은 감싸고 어떤 화면은 아닌 상태를 없앤다.
 */
export default function BudgetsPage() {
  return (
    <Suspense fallback={null}>
      <BudgetsView />
    </Suspense>
  );
}

function BudgetsView() {
  const { authedFetch } = useAuth();
  const { householdId, activeMembership } = useHousehold();
  const queryClient = useQueryClient();

  const canManage =
    activeMembership?.role === "owner" || activeMembership?.role === "admin";

  const thisMonth = currentMonth();
  // 보고 있는 달은 URL(`?month=YYYY-MM`)이 소유한다 — 홈·거래와 같은 규칙이다.
  //
  // 예전에는 로컬 state였다. "탭으로 돌아오면 이번 달로 리셋되는 게 낫다"는 판단이
  // 었는데, 사용자에게는 그냥 버그로 읽혔다: 홈에서 7월을 보다가 예산 탭을 누르면
  // 8월이 나온다. C-4가 월 원장을 넣어 "어느 달의 계획인가"가 화면의 주제가 된
  // 뒤로는 더 어긋난다. 무효한 값은 조용히 이번 달로 되돌린다.
  const searchParams = useSearchParams();
  const router = useRouter();
  const monthParam = searchParams.get("month");
  const month = monthParam && isMonthKey(monthParam) ? monthParam : thisMonth;
  // 이번 달이면 쿼리스트링을 없애 링크를 짧게 유지한다(기본 상태 = 파라미터 없음).
  // replace: 달을 5번 넘겼다고 뒤로가기를 5번 눌러야 하면 안 된다.
  const setMonth = useCallback(
    (next: string) => {
      router.replace(
        next === thisMonth
          ? "/budgets"
          : `/budgets?month=${encodeURIComponent(next)}`,
        { scroll: false },
      );
    },
    [router, thisMonth],
  );
  const isCurrentMonth = month === thisMonth;
  const isPastMonth = month < thisMonth;
  const isFutureMonth = month > thisMonth;
  // 과거월 예산은 **읽기 전용**이다. 예산액을 지금 바꾸면 그 달 달성률이 소급해서
  // 달라지는데, 그건 기록이 아니라 조작이다(ADR-0026).
  const canEdit = canManage && !isPastMonth;

  const budgetsQuery = useBudgets(month);
  const monthsQuery = useAnalyticsMonths();
  const availableMonths = useMemo(
    () =>
      monthsQuery.data
        ? [
            ...new Set([
              ...monthsQuery.data.items.map((i) => i.month),
              thisMonth,
              addMonths(thisMonth, 1),
            ]),
          ].sort()
        : undefined,
    [monthsQuery.data, thisMonth]
  );
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

  // --- 다음 달 명시적 복사 -------------------------------------------------
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyIdempotencyKey, setCopyIdempotencyKey] = useState<string | null>(
    null
  );

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
      authedFetch((token) => api.budgets.update(token, input.id, input.body)),
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

  const copyMutation = useMutation({
    mutationFn: (input: { body: BudgetCopyRequest; idempotencyKey: string }) =>
      authedFetch((token) =>
        copyBudgetPlan(token, input.body, input.idempotencyKey)
      ),
    onSuccess: (result) => {
      void invalidateBudgets();
      setCopyOpen(false);
      setCopyIdempotencyKey(null);
      setMonth(result.targetMonth);
    },
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
      effectiveMonth: month,
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

  function openCopy() {
    setCopyIdempotencyKey(crypto.randomUUID());
    copyMutation.reset();
    setCopyOpen(true);
  }

  function confirmCopy() {
    if (!householdId || !copyIdempotencyKey) return;
    copyMutation.mutate({
      body: {
        householdId,
        sourceMonth: month,
        targetMonth: addMonths(month, 1),
      },
      idempotencyKey: copyIdempotencyKey,
    });
  }

  const items = budgetsQuery.data?.items ?? [];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* 페이지 헤더 + 월 스위처 + 주 CTA ---------------------------------
          좁은 화면에서는 세로로 쌓는다. 한 줄에 두면 월 스위처(~172px)와
          '예산 만들기'(~110px)가 `shrink-0`라 360px 기기에서 가로 오버플로가 나고,
          그러면 `fixed`인 하단 탭바와 `sticky`인 상단 헤더가 가로 스크롤을 따라
          흔들려 화면 전체가 깨져 보인다. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="sr-only">예산</h1>
          <p className="text-muted-foreground text-sm">
            {isCurrentMonth
              ? "이번 달 얼마나 썼는지 한눈에 확인해요"
              : isFutureMonth
              ? "앞으로 쓸 계획을 미리 세워요"
              : "그 달에 세운 계획을 그대로 확인해요"}
          </p>
        </div>
        <div className="flex items-center justify-between gap-1 sm:shrink-0">
          <MonthSwitcher
            month={month}
            months={availableMonths}
            onChange={setMonth}
          />
          {canEdit && items.length > 0 ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <Plus />
              예산 만들기
            </Button>
          ) : null}
        </div>
      </div>

      {/* 목록 ------------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-foreground text-[13px] font-semibold">
          {isCurrentMonth ? "이번 달 예산" : `${formatMonth(month)} 예산`}
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
                  "예산을 불러오지 못했어요. 잠시 후 다시 시도해 주세요."
                )}
              </p>
            </CardContent>
          </Card>
        ) : items.length === 0 ? (
          <Card>
            {/* 과거월에서는 CTA도 권한 안내도 띄우지 않는다 — 그 달에 예산이
                없었다는 사실만 남기면 되고, 지금 만들 수 있는 것은 이번 달 예산이다. */}
            <CardContent>
              <EmptyState
                icon={<Wallet />}
                iconClassName="bg-accent text-accent-foreground"
                title={isPastMonth ? "예산 기록이 없어요" : "아직 예산이 없어요"}
                description={
                  isPastMonth
                    ? "월 원장을 도입하기 전이거나 그 달에 만든 계획이 없어요"
                    : isCurrentMonth
                    ? "예산을 만들어 두면 넘치기 전에 미리 알 수 있어요"
                    : "다음 달 계획을 미리 만들어 둘 수 있어요"
                }
                action={
                  canEdit ? (
                    <Button
                      type="button"
                      size="lg"
                      className="w-full"
                      onClick={() => setCreateOpen(true)}
                    >
                      예산 만들기
                    </Button>
                  ) : !canManage && isCurrentMonth ? (
                    <p className="text-muted-foreground text-[13px]">
                      예산은 가족의 소유자나 관리자가 만들 수 있어요
                    </p>
                  ) : null
                }
              />
            </CardContent>
          </Card>
        ) : (
          items.map((budget) => {
            const spentHref = budgetTransactionsHref(
              budget.scopeType,
              budget.scopeRefId,
              month
            );
            return (
              <Card key={budget.id}>
                <CardContent className="flex flex-col gap-3">
                  <UsageBar
                    label={budget.name ?? budget.scopeLabel}
                    spent={budget.spent}
                    amount={budget.amount}
                    currency={budget.currency}
                    usageRate={budget.usageRate}
                    meta={
                      budget.name
                        ? `${SCOPE_TYPE_LABEL[budget.scopeType]} · ${
                            budget.scopeLabel
                          }`
                        : SCOPE_TYPE_LABEL[budget.scopeType]
                    }
                  />
                  <BudgetStatusLine budget={budget} />
                  {/* 주 액션은 '어디서 썼는지 보기'다. 예산을 넘었다고 알린 뒤
                    줄 수 있는 게 '예산 늘리기'와 '예산 삭제'뿐이면 가계부가
                    최악의 조언을 하는 셈이다 — 수정·삭제는 ⋯로 내린다.
                    딥링크에는 지금 보고 있는 달을 함께 싣는다(이 화면의 월은
                    URL이 아니라 로컬 state라 그냥 두면 거래 화면이 이번 달을 연다). */}
                  <div className="flex items-center gap-2">
                    {spentHref ? (
                      <Button
                        asChild
                        variant="tint"
                        size="sm"
                        className="h-11 flex-1"
                      >
                        <Link href={spentHref}>어디서 썼는지 보기</Link>
                      </Button>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {canEdit ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-11 shrink-0"
                            aria-label={`${
                              budget.name ?? budget.scopeLabel
                            } 예산 관리 메뉴`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => openEdit(budget)}>
                            예산 수정
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={deleteMutation.isPending}
                            onSelect={() => setDeleteTarget(budget)}
                          >
                            예산 삭제
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}

        {deleteMutation.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {errorMessage(
              deleteMutation.error,
              "예산을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요."
            )}
          </p>
        ) : null}

        {!canManage && items.length > 0 ? (
          <p className="text-muted-foreground text-[13px]">
            예산 만들기와 수정은 가족의 소유자나 관리자가 할 수 있어요
          </p>
        ) : null}

        {canManage && !isPastMonth && items.length > 0 ? (
          <Card>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">
                  {formatMonth(addMonths(month, 1))} 계획을 만들까요?
                </p>
                <p className="text-muted-foreground text-[13px]">
                  지금 계획을 복사한 뒤 다음 달 금액을 따로 조정할 수 있어요
                </p>
              </div>
              <Button type="button" variant="tint" onClick={openCopy}>
                다음 달 계획 만들기
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </section>

      {/* 다음 달 복사 확인 -------------------------------------------------- */}
      <Dialog
        open={copyOpen}
        onOpenChange={(open) => {
          if (!open && !copyMutation.isPending) {
            setCopyOpen(false);
            setCopyIdempotencyKey(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>다음 달 계획을 만들까요?</DialogTitle>
            <DialogDescription>
              {formatMonth(month)} 계획 {items.length}개를{" "}
              {formatMonth(addMonths(month, 1))}로 복사해요. 자동 이월되지는
              않아요.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {items.map((budget) => (
              <div
                key={budget.id}
                className="border-border flex items-start justify-between gap-4 rounded-xl border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {budget.name ?? budget.scopeLabel}
                  </p>
                  <p className="text-muted-foreground text-[12px]">
                    {formatMonth(month)} 실지출{" "}
                    {formatMoney(budget.spent, budget.currency)} · 최근 3개월
                    평균{" "}
                    {formatMoney(
                      budget.threeMonthAverageSpent,
                      budget.currency
                    )}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums">
                  {formatMoney(budget.amount, budget.currency)}
                </p>
              </div>
            ))}
          </div>
          {copyMutation.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {errorMessage(
                copyMutation.error,
                "다음 달 계획을 만들지 못했어요. 잠시 후 다시 시도해 주세요."
              )}
            </p>
          ) : null}
          <DialogFooter className="flex-col sm:flex-col">
            <Button
              type="button"
              size="lg"
              className="w-full"
              disabled={copyMutation.isPending}
              onClick={confirmCopy}
            >
              {copyMutation.isPending ? "복사하는 중…" : "계획 복사하기"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={copyMutation.isPending}
              onClick={() => setCopyOpen(false)}
            >
              취소
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                  "예산을 만들지 못했어요. 잠시 후 다시 시도해 주세요."
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
          <form className="flex flex-col gap-4" onSubmit={onUpdate} noValidate>
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
              {/* 실지출 평균은 거래에서 다시 계산한 참고값이다. 계획 금액을 자동으로
                  바꾸지 않는다 — 과거 소비가 다음 계획의 의도라는 근거는 없다. */}
              {editing ? (
                <p className="text-muted-foreground text-[13px]">
                  최근 3개월 실지출 평균은{" "}
                  {formatMoney(
                    editing.threeMonthAverageSpent,
                    editing.currency
                  )}
                  이에요
                </p>
              ) : null}
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
                  "수정 내용을 저장하지 못했어요. 잠시 후 다시 시도해 주세요."
                )}
              </p>
            ) : null}
            <DialogFooter className="flex-col sm:flex-col">
              <Button
                type="submit"
                className="h-11 w-full"
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? "저장 중…" : "저장하기"}
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
                ? `'${
                    deleteTarget.name ?? deleteTarget.scopeLabel
                  }' 예산이 목록에서 사라져요. 기록된 거래 내역은 그대로 남아요.`
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
