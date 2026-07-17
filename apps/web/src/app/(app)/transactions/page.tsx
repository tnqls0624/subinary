"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 거래 내역 페이지 (오늘의집 디자인 언어)
 *
 * 상단 필터 칩 행(기간/카테고리/카드/구성원/유형/상태) + cursor 페이지네이션.
 * 목록은 날짜별 그룹("7월 17일" 헤더) + ListRow(카테고리 아이콘 · 가맹점 ·
 * 카드/구성원/카테고리 · 금액 · 상태 배지). 행 클릭 → 상세 Dialog에서
 * 카테고리 변경(applyRule)/공개 범위/메모/정상·중복 표시/취소연결을 처리한다.
 *
 * - 모든 계산/집계는 서버(SQL)에서 끝났다고 가정 — 여기선 표시/편집만 담당한다.
 * - 타인 summary_only(masked) 항목은 가맹점을 '(비공개)'로 표기하고 편집을 막는다.
 * - 권한은 서버(서비스 계층)가 강제하며, 실패 시 배너로 메시지를 노출한다.
 * ------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Bus,
  Clapperboard,
  Coffee,
  CreditCard,
  GraduationCap,
  HeartPulse,
  Home,
  Plane,
  Repeat,
  ShoppingBag,
  Utensils,
  type LucideIcon,
} from "lucide-react";

import type {
  CardVisibility,
  TransactionSummary,
  TransactionUpdateRequest,
} from "@family/contracts";
import { DEFAULT_TIMEZONE } from "@family/shared";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ListRow, Money, StatusBadge } from "@/components/widgets";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { formatDate, formatMonth, formatWon, currentMonth } from "@/lib/format";
import { useHousehold } from "@/lib/household-context";
import {
  useCardList,
  useCategoryList,
  useHouseholdMembers,
  useTransactions,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Local types                                                                */
/* -------------------------------------------------------------------------- */

/** select 옵션(값/라벨). */
type Option = { value: string; label: string };

/** 날짜별 그룹(헤더 라벨 + 해당 날짜 거래 + 승인 순지출 합계). */
type DayGroup = {
  key: string;
  label: string;
  total: number;
  items: TransactionSummary[];
};

/* -------------------------------------------------------------------------- */
/* Constants / labels                                                         */
/* -------------------------------------------------------------------------- */

const PAGE_SIZE = 20;

/** 전체(필터 없음) sentinel — SelectItem은 빈 문자열 value 금지. */
const ALL = "all";

/** 거래 유형 라벨(승인/취소). */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  approval: "승인",
  cancellation: "취소",
};

/** 공개범위 라벨. */
const VISIBILITY_LABELS: Readonly<Record<CardVisibility, string>> = {
  private: "비공개",
  household: "가족 공개",
  summary_only: "요약만",
};

/** 유형 필터 옵션. */
const TYPE_OPTIONS: ReadonlyArray<Option> = [
  { value: "approval", label: "승인" },
  { value: "cancellation", label: "취소" },
];

/** 상태 필터 옵션(DB txnStatus 5종). */
const STATUS_OPTIONS: ReadonlyArray<Option> = [
  { value: "approved", label: "승인" },
  { value: "partially_cancelled", label: "부분취소" },
  { value: "cancelled", label: "취소" },
  { value: "pending_review", label: "확인필요" },
  { value: "duplicate_suspected", label: "중복의심" },
];

/** 공개범위 편집 옵션. */
const VISIBILITY_OPTIONS: ReadonlyArray<Option> = (
  ["private", "household", "summary_only"] as const
).map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }));

/** 카테고리 이름 → lucide 아이콘(부분일치 규칙, 위에서부터 우선). */
const CATEGORY_ICON_RULES: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["식비", Utensils],
  ["카페", Coffee],
  ["간식", Coffee],
  ["교통", Bus],
  ["쇼핑", ShoppingBag],
  ["생활", Home],
  ["의료", HeartPulse],
  ["건강", HeartPulse],
  ["교육", GraduationCap],
  ["문화", Clapperboard],
  ["여가", Clapperboard],
  ["여행", Plane],
  ["구독", Repeat],
];

/* -------------------------------------------------------------------------- */
/* Row mutation dispatch                                                      */
/* -------------------------------------------------------------------------- */

/** 행 단위 뮤테이션 액션(단일 useMutation으로 분기 처리). */
type RowAction =
  | { kind: "update"; id: string; body: TransactionUpdateRequest }
  | { kind: "markDuplicate"; id: string }
  | { kind: "markValid"; id: string }
  | { kind: "linkCancellation"; id: string; approvalTransactionId: string };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM` → Asia/Seoul 월 경계 [월초, 다음달초)의 ISO 문자열. */
function monthRange(month: string): { from?: string; to?: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return {};
  const year = Number(match[1]);
  const mon = Number(match[2]);
  // Asia/Seoul은 DST 없는 고정 +09:00 → 오프셋을 명시해 안전하게 경계를 만든다.
  const from = `${match[1]}-${match[2]}-01T00:00:00+09:00`;
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const to = `${nextYear}-${String(nextMon).padStart(2, "0")}-01T00:00:00+09:00`;
  return { from, to };
}

/** 현재월부터 과거로 `count`개월(YYYY-MM) 목록. */
function recentMonths(count: number): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(currentMonth());
  if (!match) return [];
  let year = Number(match[1]);
  let mon = Number(match[2]);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${year}-${String(mon).padStart(2, "0")}`);
    mon -= 1;
    if (mon === 0) {
      mon = 12;
      year -= 1;
    }
  }
  return out;
}

/** 가맹점 표시명(masked → '(비공개)', 미확인 → '미확인 가맹점'). */
function merchantLabel(txn: TransactionSummary): string {
  if (txn.masked) return "(비공개)";
  return txn.merchantNormalized ?? txn.merchantRaw ?? "미확인 가맹점";
}

/** ApiError면 서버 메시지를, 아니면 일반 메시지를 반환한다. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "작업에 실패했어요. 잠시 후 다시 시도해 주세요.";
}

/** 거래 발생 시각(승인 → 취소 → 수신 순 fallback). */
function occurredAt(txn: TransactionSummary): string {
  return txn.approvedAt ?? txn.cancelledAt ?? txn.createdAt;
}

/** 카테고리 이름 → lucide 아이콘(이름 부분일치, 미지정/미매칭 → CreditCard). */
function categoryIcon(name: string | null | undefined): LucideIcon {
  if (!name) return CreditCard;
  for (const [keyword, icon] of CATEGORY_ICON_RULES) {
    if (name.includes(keyword)) return icon;
  }
  return CreditCard;
}

/** Asia/Seoul 기준 날짜 키(YYYY-MM-DD) 포맷터. */
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "7월 17일" 형태의 그룹 헤더 포맷터. */
const dayLabelFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: DEFAULT_TIMEZONE,
  month: "long",
  day: "numeric",
});

/** 올해가 아닌 날짜용 "2025년 12월 3일" 포맷터. */
const dayLabelWithYearFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** 필터 칩 클래스(기본 = 화이트 칩, 활성 = 오늘의집 검정 칩). */
function chipClass(active: boolean): string {
  return cn(
    "h-8 rounded-full border bg-card px-3 text-[13px] font-medium shadow-none",
    active && "border-foreground bg-foreground text-background",
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function TransactionsPage() {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const queryClient = useQueryClient();

  // --- 필터 상태 ---
  const [month, setMonth] = useState<string>(currentMonth());
  const [memberId, setMemberId] = useState("");
  const [cardId, setCardId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  /** 인라인 카테고리 변경 시 merchant_category_rules로 저장할지(applyRule). */
  const [applyRule, setApplyRule] = useState(false);

  // --- cursor 페이지네이션(커서 히스토리 + 현재 인덱스) ---
  const [pageStack, setPageStack] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursor = pageStack[pageIndex];

  const resetPage = () => {
    setPageStack([undefined]);
    setPageIndex(0);
  };

  // 필터 변경 시 항상 첫 페이지로 되돌린다. (Radix Select는 문자열 값을 직접 준다)
  const bindFilter =
    (setter: (value: string) => void) => (value: string) => {
      setter(value);
      resetPage();
    };

  /** 모든 필터를 기본값(이번 달·전체)으로 되돌린다(빈 상태 CTA). */
  const resetFilters = () => {
    setMonth(currentMonth());
    setMemberId("");
    setCardId("");
    setCategoryId("");
    setType("");
    setStatus("");
    resetPage();
  };

  const hasActiveFilter =
    memberId !== "" ||
    cardId !== "" ||
    categoryId !== "" ||
    type !== "" ||
    status !== "" ||
    month !== currentMonth();

  // --- 참조 목록(필터/표시용) ---
  const membersQuery = useHouseholdMembers();
  const cardsQuery = useCardList();
  const categoriesQuery = useCategoryList();

  const members = membersQuery.data ?? [];
  const cards = cardsQuery.data ?? [];
  const categories = categoriesQuery.data ?? [];

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.memberId, m.name);
    return map;
  }, [members]);

  const cardById = useMemo(() => {
    const map = new Map<string, { alias: string; issuer: string }>();
    for (const c of cards) map.set(c.id, { alias: c.alias, issuer: c.issuer });
    return map;
  }, [cards]);

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  const memberOptions: Option[] = members
    .filter((m) => m.status === "active")
    .map((m) => ({ value: m.memberId, label: m.name }));
  const cardOptions: Option[] = cards.map((c) => ({
    value: c.id,
    label: `${c.alias} · ${c.issuer}`,
  }));
  const categoryFilterOptions: Option[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
  }));
  const monthOptions: Option[] = recentMonths(12).map((m) => ({
    value: m,
    label: formatMonth(m),
  }));

  // --- 목록 쿼리 ---
  const { from, to } = useMemo(() => monthRange(month), [month]);
  const filters = useMemo(
    () => ({
      memberId: memberId || undefined,
      cardId: cardId || undefined,
      categoryId: categoryId || undefined,
      type: type || undefined,
      status: status || undefined,
      from,
      to,
      limit: PAGE_SIZE,
      cursor: cursor || undefined,
    }),
    [memberId, cardId, categoryId, type, status, from, to, cursor],
  );
  const listQuery = useTransactions(filters);

  const items = listQuery.data?.items ?? [];
  const nextCursor = listQuery.data?.nextCursor ?? null;
  const canPrev = pageIndex > 0;
  const canNext = nextCursor != null;

  const goNext = () => {
    if (nextCursor == null) return;
    setPageStack((prev) => [...prev.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((i) => i + 1);
  };
  const goPrev = () => setPageIndex((i) => Math.max(0, i - 1));

  // --- 날짜별 그룹(발생일 기준, 서버 정렬 순서 유지) ---
  const groups = useMemo<DayGroup[]>(() => {
    const currentYear = currentMonth().slice(0, 4);
    const map = new Map<string, DayGroup>();
    for (const txn of items) {
      const date = new Date(occurredAt(txn));
      const valid = !Number.isNaN(date.getTime());
      const key = valid ? dayKeyFormatter.format(date) : "unknown";
      let group = map.get(key);
      if (!group) {
        const label = !valid
          ? "날짜 미확인"
          : key.startsWith(currentYear)
            ? dayLabelFormatter.format(date)
            : dayLabelWithYearFormatter.format(date);
        group = { key, label, total: 0, items: [] };
        map.set(key, group);
      }
      group.items.push(txn);
      if (txn.transactionType === "approval") group.total += txn.netAmount;
    }
    return [...map.values()];
  }, [items]);

  // --- 뮤테이션(행 작업) ---
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [memoTarget, setMemoTarget] = useState<TransactionSummary | null>(null);
  const [linkTarget, setLinkTarget] = useState<TransactionSummary | null>(null);

  // 상세 Dialog는 항상 최신 목록의 행을 바라본다(뮤테이션 후 refetch 반영).
  const detailTxn = detailId
    ? (items.find((t) => t.id === detailId) ?? null)
    : null;

  const mutation = useMutation({
    mutationFn: (action: RowAction): Promise<TransactionSummary> =>
      authedFetch((token) => {
        switch (action.kind) {
          case "update":
            return api.transactions.update(token, action.id, action.body);
          case "markDuplicate":
            return api.transactions.markDuplicate(token, action.id);
          case "markValid":
            return api.transactions.markValid(token, action.id);
          case "linkCancellation":
            return api.transactions.linkCancellation(token, action.id, {
              approvalTransactionId: action.approvalTransactionId,
            });
          default: {
            const exhaustive: never = action;
            throw new Error(`unknown action: ${JSON.stringify(exhaustive)}`);
          }
        }
      }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const busyId = mutation.isPending ? (mutation.variables?.id ?? null) : null;

  const changeCategory = (txn: TransactionSummary, nextCategoryId: string) => {
    if (nextCategoryId === "" || nextCategoryId === txn.categoryId) return;
    mutation.mutate({
      kind: "update",
      id: txn.id,
      body: { categoryId: nextCategoryId, applyRule },
    });
  };

  const changeVisibility = (
    txn: TransactionSummary,
    nextVisibility: string,
  ) => {
    if (nextVisibility === txn.visibility) return;
    mutation.mutate({
      kind: "update",
      id: txn.id,
      body: { visibility: nextVisibility as CardVisibility },
    });
  };

  const saveMemo = (txn: TransactionSummary, memo: string) => {
    mutation.mutate(
      { kind: "update", id: txn.id, body: { memo } },
      { onSuccess: () => setMemoTarget(null) },
    );
  };

  const confirmLink = (txn: TransactionSummary, approvalId: string) => {
    mutation.mutate(
      {
        kind: "linkCancellation",
        id: txn.id,
        approvalTransactionId: approvalId,
      },
      { onSuccess: () => setLinkTarget(null) },
    );
  };

  // --- 행 표시용 파생 ---
  const categoryNameOf = (txn: TransactionSummary): string | null =>
    txn.categoryId ? (categoryNameById.get(txn.categoryId) ?? null) : null;

  const cardLabelOf = (txn: TransactionSummary): string => {
    if (!txn.cardId) return "카드 미연결";
    return cardById.get(txn.cardId)?.alias ?? "카드";
  };

  const memberNameOf = (txn: TransactionSummary): string =>
    memberNameById.get(txn.memberId) ?? "구성원";

  const subtitleOf = (txn: TransactionSummary): string => {
    const parts = [
      cardLabelOf(txn),
      memberNameOf(txn),
      categoryNameOf(txn) ?? "미분류",
    ];
    if (txn.installmentMonths) parts.push(`${txn.installmentMonths}개월 할부`);
    return parts.join(" · ");
  };

  const showLoading = householdId != null && listQuery.isLoading;
  const showError = listQuery.isError;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">거래 내역</h1>
        <p className="text-muted-foreground text-sm">
          우리 가족의 카드 소비를 한곳에서 볼 수 있어요
        </p>
      </div>

      {/* 필터 칩 행 — Select 로직/sentinel 매핑은 그대로, 트리거만 칩 스타일 */}
      <div className="flex flex-wrap gap-2">
        <Select
          value={month || ALL}
          onValueChange={(v) => bindFilter(setMonth)(v === ALL ? "" : v)}
        >
          <SelectTrigger
            size="sm"
            aria-label="기간 필터"
            className={chipClass(month !== "")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체 기간</SelectItem>
            {monthOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={categoryId || ALL}
          onValueChange={(v) => bindFilter(setCategoryId)(v === ALL ? "" : v)}
        >
          <SelectTrigger
            size="sm"
            aria-label="카테고리 필터"
            className={chipClass(categoryId !== "")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체 카테고리</SelectItem>
            {categoryFilterOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={cardId || ALL}
          onValueChange={(v) => bindFilter(setCardId)(v === ALL ? "" : v)}
        >
          <SelectTrigger
            size="sm"
            aria-label="카드 필터"
            className={chipClass(cardId !== "")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체 카드</SelectItem>
            {cardOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={memberId || ALL}
          onValueChange={(v) => bindFilter(setMemberId)(v === ALL ? "" : v)}
        >
          <SelectTrigger
            size="sm"
            aria-label="구성원 필터"
            className={chipClass(memberId !== "")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체 구성원</SelectItem>
            {memberOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={type || ALL}
          onValueChange={(v) => bindFilter(setType)(v === ALL ? "" : v)}
        >
          <SelectTrigger
            size="sm"
            aria-label="유형 필터"
            className={chipClass(type !== "")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체 유형</SelectItem>
            {TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={status || ALL}
          onValueChange={(v) => bindFilter(setStatus)(v === ALL ? "" : v)}
        >
          <SelectTrigger
            size="sm"
            aria-label="상태 필터"
            className={chipClass(status !== "")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체 상태</SelectItem>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {actionError ? (
        <div
          role="alert"
          className="bg-destructive/10 text-destructive rounded-lg px-4 py-3 text-sm"
        >
          {actionError}
        </div>
      ) : null}

      {/* 목록 — 날짜별 그룹 + ListRow */}
      <Card>
        <CardContent className="flex flex-col gap-5">
          {showLoading ? (
            <div className="flex flex-col gap-1" role="status" aria-live="polite">
              <span className="sr-only">거래를 불러오고 있어요</span>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-3">
                  <Skeleton className="size-10 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-44" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : showError ? (
            <p className="text-destructive py-6 text-center text-sm" role="alert">
              거래를 불러오지 못했어요: {errorMessage(listQuery.error)}
            </p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <span className="text-4xl" aria-hidden>
                🧾
              </span>
              {hasActiveFilter ? (
                <>
                  <p className="pt-1 text-[15px] font-semibold">
                    조건에 맞는 거래가 없어요
                  </p>
                  <p className="text-muted-foreground text-sm">
                    필터를 바꿔서 다시 찾아볼까요?
                  </p>
                  <Button variant="tint" className="mt-3" onClick={resetFilters}>
                    필터 초기화하기
                  </Button>
                </>
              ) : (
                <>
                  <p className="pt-1 text-[15px] font-semibold">
                    아직 거래가 없어요
                  </p>
                  <p className="text-muted-foreground text-sm">
                    카드 문자가 도착하면 자동으로 정리해 드려요
                  </p>
                  <Button variant="tint" className="mt-3" asChild>
                    <Link href="/devices">장치 연결하러 가기</Link>
                  </Button>
                </>
              )}
            </div>
          ) : (
            <>
              {groups.map((group) => (
                <section key={group.key} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between px-2">
                    <h2 className="text-muted-foreground text-[13px] font-semibold">
                      {group.label}
                    </h2>
                    <Money
                      amount={group.total}
                      muted
                      className="text-[13px]"
                    />
                  </div>
                  <div className="flex flex-col">
                    {group.items.map((txn) => {
                      const Icon = categoryIcon(categoryNameOf(txn));
                      const isCancellation =
                        txn.transactionType === "cancellation";
                      return (
                        <ListRow
                          key={txn.id}
                          icon={<Icon />}
                          iconClassName={
                            txn.masked
                              ? "bg-muted text-muted-foreground"
                              : undefined
                          }
                          title={
                            txn.masked ? (
                              <span className="text-muted-foreground">
                                {merchantLabel(txn)}
                              </span>
                            ) : (
                              merchantLabel(txn)
                            )
                          }
                          subtitle={subtitleOf(txn)}
                          value={
                            isCancellation ? (
                              <Money amount={-txn.amount} muted />
                            ) : (
                              <Money amount={txn.netAmount} />
                            )
                          }
                          valueSub={
                            <span className="flex items-center justify-end gap-1.5">
                              {isCancellation ? (
                                <span className="text-xs">
                                  {TYPE_LABELS[txn.transactionType]}
                                </span>
                              ) : null}
                              <StatusBadge status={txn.status} />
                            </span>
                          }
                          onClick={
                            txn.masked ? undefined : () => setDetailId(txn.id)
                          }
                          chevron={!txn.masked}
                          className={
                            busyId === txn.id
                              ? "pointer-events-none opacity-60"
                              : undefined
                          }
                        />
                      );
                    })}
                  </div>
                </section>
              ))}

              <div className="flex flex-col items-center gap-3">
                {canNext ? (
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={listQuery.isFetching}
                    onClick={goNext}
                  >
                    다음 거래 보기
                  </Button>
                ) : null}
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground text-[13px]">
                    {items.length}건 · {pageIndex + 1}페이지
                  </span>
                  {canPrev ? (
                    <button
                      type="button"
                      onClick={goPrev}
                      disabled={listQuery.isFetching}
                      className="text-accent-foreground text-[13px] font-medium disabled:opacity-50"
                    >
                      이전 페이지로
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {detailTxn ? (
        <TransactionDetailDialog
          txn={detailTxn}
          busy={mutation.isPending}
          cardLabel={cardLabelOf(detailTxn)}
          memberName={memberNameOf(detailTxn)}
          categoryOptions={categoryFilterOptions}
          applyRule={applyRule}
          onApplyRuleChange={setApplyRule}
          onChangeCategory={(v) => changeCategory(detailTxn, v)}
          onChangeVisibility={(v) => changeVisibility(detailTxn, v)}
          onOpenMemo={() => setMemoTarget(detailTxn)}
          onOpenLink={() => setLinkTarget(detailTxn)}
          onMarkValid={() =>
            mutation.mutate({ kind: "markValid", id: detailTxn.id })
          }
          onMarkDuplicate={() =>
            mutation.mutate({ kind: "markDuplicate", id: detailTxn.id })
          }
          onClose={() => setDetailId(null)}
        />
      ) : null}

      {memoTarget ? (
        <MemoModal
          txn={memoTarget}
          busy={mutation.isPending}
          onClose={() => setMemoTarget(null)}
          onSave={(memo) => saveMemo(memoTarget, memo)}
        />
      ) : null}

      {linkTarget ? (
        <LinkCancellationModal
          cancellation={linkTarget}
          busy={mutation.isPending}
          onClose={() => setLinkTarget(null)}
          onConfirm={(approvalId) => confirmLink(linkTarget, approvalId)}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Transaction detail dialog                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 거래 상세 Dialog — 행 클릭 시 열리며 편집 액션(카테고리/공개 범위/메모/
 * 정상·중복 표시/취소연결)을 점진 공개로 모아 보여준다. masked 행은 열리지 않는다.
 */
function TransactionDetailDialog({
  txn,
  busy,
  cardLabel,
  memberName,
  categoryOptions,
  applyRule,
  onApplyRuleChange,
  onChangeCategory,
  onChangeVisibility,
  onOpenMemo,
  onOpenLink,
  onMarkValid,
  onMarkDuplicate,
  onClose,
}: Readonly<{
  txn: TransactionSummary;
  busy: boolean;
  cardLabel: string;
  memberName: string;
  categoryOptions: ReadonlyArray<Option>;
  applyRule: boolean;
  onApplyRuleChange: (value: boolean) => void;
  onChangeCategory: (categoryId: string) => void;
  onChangeVisibility: (visibility: string) => void;
  onOpenMemo: () => void;
  onOpenLink: () => void;
  onMarkValid: () => void;
  onMarkDuplicate: () => void;
  onClose: () => void;
}>) {
  const isCancellation = txn.transactionType === "cancellation";
  const isPending =
    txn.status === "pending_review" || txn.status === "duplicate_suspected";
  const canLink = isCancellation && txn.parentTransactionId == null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{merchantLabel(txn)}</DialogTitle>
          <DialogDescription>
            {formatDate(occurredAt(txn))} · {cardLabel} · {memberName}
          </DialogDescription>
        </DialogHeader>

        {/* 금액 요약 */}
        <div className="bg-muted flex flex-col items-center gap-1 rounded-xl px-4 py-5">
          <span className="text-muted-foreground text-[13px]">
            {isCancellation ? "취소 금액" : "결제 금액"}
          </span>
          <span className="text-2xl font-bold tabular-nums">
            {isCancellation ? (
              <Money amount={-txn.amount} />
            ) : (
              <Money amount={txn.netAmount} />
            )}
          </span>
          {!isCancellation && txn.netAmount !== txn.amount ? (
            <span className="text-muted-foreground text-[13px]">
              원래 {formatWon(txn.amount)}에서 취소{" "}
              {formatWon(txn.cancelledAmount)}이 반영됐어요
            </span>
          ) : null}
          <span className="flex items-center gap-1.5 pt-1">
            {isCancellation ? (
              <span className="text-muted-foreground text-xs">
                {TYPE_LABELS[txn.transactionType]} 거래
              </span>
            ) : null}
            <StatusBadge status={txn.status} />
            {txn.installmentMonths ? (
              <span className="text-muted-foreground text-xs">
                {txn.installmentMonths}개월 할부
              </span>
            ) : null}
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {/* 카테고리 변경(+applyRule) */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="detail-category">카테고리</Label>
            <Select
              value={txn.categoryId ?? ""}
              disabled={busy}
              onValueChange={onChangeCategory}
            >
              <SelectTrigger id="detail-category" className="w-full">
                <SelectValue placeholder="미분류" />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex w-fit cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={applyRule}
                onChange={(e) => onApplyRuleChange(e.target.checked)}
              />
              <span className="text-muted-foreground text-[13px]">
                같은 가맹점은 다음부터 이 카테고리로 자동 분류해요
              </span>
            </label>
          </div>

          {/* 공개 범위 */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="detail-visibility">공개 범위</Label>
            <Select
              value={txn.visibility}
              disabled={busy}
              onValueChange={onChangeVisibility}
            >
              <SelectTrigger id="detail-visibility" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 메모 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>메모</Label>
              <button
                type="button"
                disabled={busy}
                onClick={onOpenMemo}
                className="text-accent-foreground text-[13px] font-medium disabled:opacity-50"
              >
                {txn.memo ? "수정하기" : "남기기"}
              </button>
            </div>
            <p
              className={cn(
                "bg-muted rounded-lg px-3 py-2.5 text-sm",
                !txn.memo && "text-muted-foreground",
              )}
            >
              {txn.memo ?? "아직 메모가 없어요"}
            </p>
          </div>

          {/* 보조 액션 */}
          {canLink || txn.status !== "duplicate_suspected" ? (
            <div className="flex flex-col gap-2">
              {canLink ? (
                <Button
                  variant="tint"
                  className="h-11 w-full"
                  disabled={busy}
                  onClick={onOpenLink}
                >
                  원래 결제와 연결하기
                </Button>
              ) : null}
              {txn.status !== "duplicate_suspected" ? (
                <Button
                  variant="ghost"
                  className="text-muted-foreground h-11 w-full"
                  disabled={busy}
                  onClick={onMarkDuplicate}
                >
                  중복 거래로 표시하기
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {isPending ? (
            <Button className="h-11 w-full" disabled={busy} onClick={onMarkValid}>
              정상 거래로 확인하기
            </Button>
          ) : null}
          <Button
            variant="ghost"
            className="h-11 w-full"
            disabled={busy}
            onClick={onClose}
          >
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Memo modal                                                                 */
/* -------------------------------------------------------------------------- */

function MemoModal({
  txn,
  busy,
  onClose,
  onSave,
}: Readonly<{
  txn: TransactionSummary;
  busy: boolean;
  onClose: () => void;
  onSave: (memo: string) => void;
}>) {
  const [memo, setMemo] = useState(txn.memo ?? "");
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>메모 남기기</DialogTitle>
          <DialogDescription>
            {merchantLabel(txn)} 거래에 기억할 내용을 적어 주세요
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="memo-input" className="sr-only">
            메모
          </Label>
          <textarea
            id="memo-input"
            rows={4}
            maxLength={1000}
            value={memo}
            placeholder="예: 아이 생일 케이크, 부모님 선물이었어요"
            onChange={(e) => setMemo(e.target.value)}
            className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive flex min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            variant="default"
            className="h-11 w-full"
            onClick={() => onSave(memo)}
            disabled={busy}
          >
            저장하기
          </Button>
          <Button
            variant="ghost"
            className="h-11 w-full"
            onClick={onClose}
            disabled={busy}
          >
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Link-cancellation modal                                                    */
/* -------------------------------------------------------------------------- */

function LinkCancellationModal({
  cancellation,
  busy,
  onClose,
  onConfirm,
}: Readonly<{
  cancellation: TransactionSummary;
  busy: boolean;
  onClose: () => void;
  onConfirm: (approvalTransactionId: string) => void;
}>) {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const [selected, setSelected] = useState("");

  // 취소액을 커버할 수 있는 잔액이 남은 승인 거래 후보를 조회한다.
  const approvalsQuery = useQuery({
    queryKey: ["link-approvals", householdId, cancellation.id],
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) =>
        api.transactions.list(token, {
          householdId: householdId as string,
          type: "approval",
          limit: 100,
        }),
      ),
  });

  const candidates = (approvalsQuery.data?.items ?? []).filter(
    (a) =>
      (a.status === "approved" || a.status === "partially_cancelled") &&
      a.amount - a.cancelledAmount >= cancellation.amount,
  );

  const options: Option[] = candidates.map((a) => ({
    value: a.id,
    label: `${merchantLabel(a)} · 남은 금액 ${formatWon(
      a.amount - a.cancelledAmount,
    )} · ${formatDate(a.approvedAt, { dateOnly: true })}`,
  }));

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>어떤 결제를 취소한 건가요?</DialogTitle>
          <DialogDescription>
            이 취소 금액 {formatWon(cancellation.amount)}을 원래 결제와 연결해
            주세요. 연결하면 순지출이 자동으로 다시 계산돼요.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {approvalsQuery.isLoading ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              결제 내역을 불러오고 있어요…
            </p>
          ) : approvalsQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              결제 내역을 불러오지 못했어요:{" "}
              {errorMessage(approvalsQuery.error)}
            </p>
          ) : options.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              연결할 수 있는 결제가 없어요
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-approval">원래 결제</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger id="link-approval" className="w-full">
                  <SelectValue placeholder="결제를 골라 주세요" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            variant="default"
            className="h-11 w-full"
            onClick={() => onConfirm(selected)}
            disabled={busy || selected === ""}
          >
            연결하기
          </Button>
          <Button
            variant="ghost"
            className="h-11 w-full"
            onClick={onClose}
            disabled={busy}
          >
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
