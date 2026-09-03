"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 홈(대시보드) — 오늘의집 톤 카드 스택
 *
 * 활성 가족(household-context)의 이번 달 재무 현황을 단일 컬럼 카드 스택
 * (max-w-2xl)으로 보여준다.
 *  - 할 일(최상단): 결제 실패 / 확인필요·중복의심 거래 / 읽지 못한 문자 — 처리할 게
 *    없으면 카드 자체가 사라진다. 전체 백로그는 /todo가 갖는다(C-8)
 *  - 히어로: "이번 달 소비" 총액 큰 타이포 + 전월 대비 해요체 문장(analytics.monthly)
 *  - 예산: UsageBar 상위 5개(budgets.list), 초과 시 "예산을 넘었어요" 카피
 *  - "어디에 많이 썼나요?" 카테고리 BarList / 구성원·카드는 ListRow(analytics.*)
 *  - 최근 거래: ListRow 5건(transactions.list limit 10 중 상위 5) + 전체 보기 링크
 *
 * 금액이 적힌 집계 행은 전부 **필터가 걸린 거래 목록으로 가는 링크**다(C-7).
 * 거래 화면이 이미 `month`/`memberId`/`cardId`/`categoryId`/`q`를 초기 필터로 읽으므로
 * 링크만 만들면 되고 새 백엔드가 필요 없다(lib/deep-link.ts).
 *
 * 거래도 카드도 없는 새 가족에게는 빈 카드 6장 대신 3단계 온보딩 체크리스트를
 * 보여준다(C-1). 완료 판정은 이미 로딩 중인 쿼리(useCardList/useDevices/
 * useTransactions)로만 계산한다.
 *
 * 모든 집계는 서버(SQL)에서 끝났다고 가정하며 여기서는 표시만 한다(합산/계산 금지).
 * 데이터는 React Query 훅(queries.ts) + authedFetch(401→refresh)로 가져온다.
 * ------------------------------------------------------------------------- */
import {
  AlertTriangle,
  Check,
  CircleAlert,
  CreditCard,
  MailWarning,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState, type ReactNode } from "react";

import type {
  BudgetScopeType,
  MemberColor,
  TransactionSummary,
} from "@family/contracts";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BarList,
  EmptyState,
  ListRow,
  Money,
  MonthSwitcher,
  ReviewInboxDialog,
  StatusBadge,
  UsageBar,
  declineReasonHint,
  pendingCountText,
  useTodoCounts,
  type BarListItem,
  type TodoCounts,
} from "@/components/widgets";
import { MonthlyInsightsCard } from "@/components/monthly-insights-card";
import { UpcomingSpendCard } from "./upcoming-card";
import { AddTransactionDialog } from "../transactions/add-transaction-dialog";
import { ApiError } from "@/lib/api-client";
import {
  currentMonth,
  formatDate,
  formatMonth,
  formatWon,
  percent,
} from "@/lib/format";
import { categoryIcon } from "@/lib/category-icon";
import { budgetTransactionsHref, transactionsHref } from "@/lib/deep-link";
import { useHousehold } from "@/lib/household-context";
import { memberColorClass } from "@/lib/member-color";
import { addMonths, isMonthKey } from "@/lib/month";
import {
  useAnalyticsMonths,
  useBudgets,
  useCardList,
  useCards,
  useCategories,
  useCategoryList,
  useDevices,
  useHouseholdMembers,
  useMembers,
  useMerchants,
  useMonthly,
  useTransactions,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

/** BarList 상위 노출 개수(구성원/카드/카테고리 공통). */
const BREAKDOWN_TOP_N = 6;

/** 예산 사용률 패널에 노출할 상위 예산 개수. */
const BUDGET_TOP_N = 5;

/** 최근 거래 홈 노출 개수(쿼리는 10건 유지, 표시만 5건). */
const RECENT_DISPLAY_N = 5;

/** 실시간 카드문자 반영 폴링 간격(ms). 포커스 상태에서만 동작. */
// 실시간 반영의 주 채널은 SSE(ActivityProvider) — 폴링은 SSE 불통 시 안전망이라
// 저빈도(60초)로 둔다. staleTime 30초 + 포커스 리페치가 2차 안전망.
const REALTIME_POLL_MS = 60_000;

/** 온보딩 체크리스트 1단계. `done`은 이미 로딩 중인 쿼리로만 판정한다. */
interface ChecklistStep {
  key: string;
  title: string;
  description: string;
  done: boolean;
  /** 미완료일 때 이동할 설정 화면. */
  href?: string;
  /** 미완료일 때 버튼 라벨('등록'/'연결'). */
  cta?: string;
}

/** 공개범위로 마스킹된 가맹점 라벨(서버 analytics가 이 문자열로 접는다). */
const MASKED_MERCHANT = "(비공개)";

/** 예산 스코프 → 한국어 보조 라벨(UsageBar meta). */
const SCOPE_LABEL: Record<BudgetScopeType, string> = {
  household: "가족 전체",
  member: "구성원",
  category: "카테고리",
  card: "카드",
};

// --- 페이지 -----------------------------------------------------------------

/**
 * `useSearchParams`는 Suspense 경계를 요구한다(정적 export 포함) — 홈 화면의
 * 달·필터는 URL이 소유하므로 여기서 경계를 친다. `/login`·`/join`·`/register`가
 * 쓰던 것과 같은 형태로 맞춰, 어떤 화면은 감싸고 어떤 화면은 아닌 상태를 없앤다.
 */
export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardView />
    </Suspense>
  );
}

function DashboardView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const thisMonth = currentMonth();
  // 보고 있는 달은 URL(`?month=YYYY-MM`)이 소유한다 — 새로고침·공유·알림 딥링크가
  // 같은 화면을 재현해야 하고, 뒤로가기가 달 이동을 되돌리는 것이 자연스럽다.
  // 무효한 값(수동 편집·오래된 링크)은 조용히 이번 달로 되돌린다.
  const monthParam = searchParams.get("month");
  const month = monthParam && isMonthKey(monthParam) ? monthParam : thisMonth;
  const isCurrentMonth = month === thisMonth;

  const { activeMembership } = useHousehold();
  const [parseFailedOpen, setParseFailedOpen] = useState(false);

  // 이번 달이면 쿼리스트링을 없애 링크를 짧게 유지한다(기본 상태 = 파라미터 없음).
  // replace: 달을 5번 넘겼다고 뒤로가기를 5번 눌러야 하면 안 된다.
  const changeMonth = useCallback(
    (next: string) => {
      router.replace(
        next === thisMonth
          ? "/dashboard"
          : `/dashboard?month=${encodeURIComponent(next)}`,
        { scroll: false },
      );
    },
    [router, thisMonth],
  );

  // 실시간 카드문자가 파싱돼 들어오면 화면에 자동 반영되도록, 문자 유입에 민감한
  // 쿼리는 폴링한다(포커스 상태에서만 — TanStack 기본이 백그라운드 폴링 정지).
  const poll = { refetchInterval: REALTIME_POLL_MS };

  // 이번 달 집계.
  const monthlyQuery = useMonthly(month, poll);
  const membersQuery = useMembers(month);
  // 구성원이 직접 고른 색(memberId → 팔레트 키). 없으면 해시 색 폴백.
  const householdMembersQuery = useHouseholdMembers();
  const memberColorById = useMemo(() => {
    const map = new Map<string, MemberColor | null>();
    for (const m of householdMembersQuery.data ?? []) map.set(m.memberId, m.color);
    return map;
  }, [householdMembersQuery.data]);
  // 전 구성원 이름(카드 소유자가 이달 지출이 없어 analytics.members에 없을 수 있어 폴백).
  const householdNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of householdMembersQuery.data ?? []) map.set(m.memberId, m.name);
    return map;
  }, [householdMembersQuery.data]);
  // 카드 소유자 매핑: 거래 색/이름은 "카드 소유자" 기준으로 표시한다(문자를 대신
  // 전달한 사람이 아니라 카드 주인이 누구 지출인지를 나타냄 — 카드 화면과 동일 색).
  const cardListQuery = useCardList();
  const cardOwnerById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cardListQuery.data ?? []) map.set(c.id, c.ownerMemberId);
    return map;
  }, [cardListQuery.data]);
  const cardsQuery = useCards(month);
  const categoriesQuery = useCategories(month);
  const budgetsQuery = useBudgets(month);
  const merchantsQuery = useMerchants(month);
  // 거래가 있는 달 목록 — 스위처가 빈 달을 건너뛰는 데 쓴다.
  const monthsQuery = useAnalyticsMonths();
  const availableMonths = useMemo(
    () => monthsQuery.data?.items.map((i) => i.month),
    [monthsQuery.data],
  );

  // 최근 거래 10건(기간 무관, 최신순).
  const recentQuery = useTransactions({ limit: 10 }, poll);

  // 할 일 백로그(월 무관) — 결제 실패 · 확인 필요 거래 · 읽지 못한 문자.
  // 세는 규칙은 `useTodoCounts()`가 갖고 있고, `/todo`와 하단 탭 배지가 같은 훅을
  // 쓴다. 홈이 자기 방식으로 또 세면 화면마다 숫자가 갈린다.
  const todo = useTodoCounts(poll);

  // --- 파생 데이터 ----------------------------------------------------------

  // 집계 행 → 거래 목록 딥링크(C-7). 축 값이 없는 행(미분류/미연결/마스킹)은
  // 링크를 걸지 않는다 — 필터가 안 걸린 전체 목록으로 보내면 사용자는 자기가
  // 누른 행과 무관한 화면을 보게 된다.
  const memberItems = useMemo<BarListItem[]>(
    () =>
      (membersQuery.data?.items ?? [])
        .slice(0, BREAKDOWN_TOP_N)
        .map((m) => ({
          // memberId가 null이면 '공용' 버킷이다(공용 표시한 카드의 결제). 사람이 아니라
          // 귀속을 보류한 묶음이므로 딥링크를 걸지 않는다 — memberId 필터로는 그 집합을
          // 다시 만들 수 없고, 필터 없는 목록으로 보내면 누른 행과 무관한 화면이 된다.
          key: m.memberId ?? "__shared__",
          label: m.name,
          value: m.net,
          ratio: m.ratio,
          meta: `${m.count}건`,
          ...(m.memberId === null
            ? {}
            : { href: transactionsHref({ month, memberId: m.memberId }) }),
        })),
    [membersQuery.data, month],
  );

  const cardItems = useMemo<BarListItem[]>(
    () =>
      (cardsQuery.data?.items ?? []).slice(0, BREAKDOWN_TOP_N).map((c) => ({
        key: c.cardId ?? "unlinked",
        label: c.issuer ? `${c.alias} · ${c.issuer}` : c.alias,
        value: c.net,
        ratio: c.ratio,
        meta: `${c.count}건`,
        ...(c.cardId
          ? { href: transactionsHref({ month, cardId: c.cardId }) }
          : {}),
      })),
    [cardsQuery.data, month],
  );

  const categoryItems = useMemo<BarListItem[]>(
    () =>
      (categoriesQuery.data?.items ?? [])
        .slice(0, BREAKDOWN_TOP_N)
        .map((c) => ({
          key: c.categoryId ?? "uncategorized",
          label: c.categoryName,
          value: c.net,
          ratio: c.ratio,
          meta: `${c.count}건`,
          ...(c.categoryId
            ? { href: transactionsHref({ month, categoryId: c.categoryId }) }
            : {}),
        })),
    [categoriesQuery.data, month],
  );

  // 가맹점 상위 — 서버가 이미 net 내림차순 top 20을 주므로 앞에서 잘라 쓴다.
  // 거래 화면에 가맹점 필터는 없고 검색(`q`)이 그 역할을 한다. 공개범위로
  // 마스킹된 '(비공개)' 행은 검색해도 남의 거래가 나오지 않으므로 링크를 뺀다.
  const merchantItems = useMemo<BarListItem[]>(
    () =>
      (merchantsQuery.data?.items ?? [])
        .slice(0, BREAKDOWN_TOP_N)
        .map((m) => ({
          key: m.merchant,
          label: m.merchant,
          value: m.net,
          ratio: m.ratio,
          meta: `${m.count}건`,
          ...(m.merchant === MASKED_MERCHANT
            ? {}
            : { href: transactionsHref({ month, q: m.merchant }) }),
        })),
    [merchantsQuery.data, month],
  );

  // 상위 사용률 예산(사용률 내림차순).
  const topBudgets = useMemo(
    () =>
      [...(budgetsQuery.data?.items ?? [])]
        .sort((a, b) => b.usageRate - a.usageRate)
        .slice(0, BUDGET_TOP_N),
    [budgetsQuery.data],
  );

  // 최근 거래 리스트의 구성원명 매핑(analytics.members 결과 재활용).
  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    // '공용'(memberId null)은 사람 이름 매핑에 넣지 않는다 — 이 맵은 거래 행의
    // memberId로 이름을 찾는 용도이고, 거래의 member_id는 언제나 실제 구성원이다.
    for (const m of membersQuery.data?.items ?? []) {
      if (m.memberId !== null) map.set(m.memberId, m.name);
    }
    return map;
  }, [membersQuery.data]);

  // 카테고리 아이콘 선택용 id→이름 맵(거래 목록과 동일한 카테고리 목록 사용).
  const categoryListQuery = useCategoryList();
  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categoryListQuery.data ?? []) map.set(c.id, c.name);
    return map;
  }, [categoryListQuery.data]);

  const recentRows = recentQuery.data?.items ?? [];

  // 확인 필요 문자: 홈은 **최근 3일**만 줄로 노출한다. 3일이 지난 건은 사라지는 게
  // 아니라 "지난 문자 N건 더 보기"(→ /todo)로 내려간다 — 예전에는 3일이 지나면 홈에서
  // 조용히 사라졌고, 그 문자 한 통이 거래 한 건이라 지출 합계가 영구히 틀어졌다(D-7).
  // 창 자체는 유지한다: 없애면 홈이 오래된 백로그로 덮여 원래 창을 넣은 이유가 사라진다.
  // 창을 가르는 규칙과 그 이유는 components/widgets/todo-counts.ts에 있다.
  const parseFailedRecent = todo.smsRecent;
  const parseFailedCount = parseFailedRecent.length;
  const olderSmsCount = todo.smsOlder.length;

  // 노출 규칙: 결제 실패는 미해결이 1건이라도 있으면, 확인필요 거래도 1건이라도 있으면
  // (해결하면 자동으로 사라진다), 읽지 못한 문자는 3일 이내 건 또는 지난 건이 있으면
  // 표시. 셋 다 없으면 카드 자체를 감춘다(빈 상태로 자리 차지 금지).
  const showDeclineRow = todo.declinesError || todo.declines.length > 0;
  const showReviewRow = todo.reviewsError || todo.reviews.length > 0;
  const showParseFailedRow =
    todo.smsError || parseFailedCount > 0 || olderSmsCount > 0;
  const showTodoCard = showDeclineRow || showReviewRow || showParseFailedRow;

  // --- 온보딩 체크리스트(C-1) ------------------------------------------------
  // 합류 직후 홈은 빈 카드 6장이라 다음 행동이 없었다. 거래가 아직 하나도 없고
  // 3단계를 다 끝내지 않았으면 빈 카드 대신 체크리스트를 보여준다.
  //
  // 완료 판정은 **이미 로딩 중인 쿼리로만** 계산한다(새 백엔드 없음):
  //  1) 가족 만들기 — 이 화면이 렌더된다는 것 자체가 활성 가족이 있다는 뜻이다.
  //  2) 카드 등록  — useCardList
  //  3) 휴대폰 연결 — useDevices
  // 3/3이 되면 조건이 깨져 체크리스트가 사라지고 평소 홈으로 돌아간다.
  const devicesQuery = useDevices();
  const [addTxnOpen, setAddTxnOpen] = useState(false);

  const checklistSteps = useMemo<ChecklistStep[]>(
    () => [
      {
        key: "household",
        title: "가족 만들기",
        description: activeMembership
          ? `'${activeMembership.name}' 가족을 만들었어요`
          : "가족을 만들었어요",
        done: true,
      },
      {
        key: "card",
        title: "결제 카드 등록하기",
        description: "뒤 4자리를 넣으면 문자가 자동으로 연결돼요",
        done: (cardListQuery.data ?? []).length > 0,
        href: "/cards",
        cta: "등록",
      },
      {
        key: "device",
        title: "휴대폰 연결하기",
        description: "카드 문자를 자동으로 모아와요",
        done: (devicesQuery.data ?? []).length > 0,
        href: "/devices",
        cta: "연결",
      },
    ],
    [activeMembership, cardListQuery.data, devicesQuery.data],
  );
  const checklistDone = checklistSteps.filter((s) => s.done).length;
  // 참조 쿼리가 아직 안 왔을 때 체크리스트를 먼저 그리면, 이미 설정을 끝낸
  // 사용자에게 "카드를 등록하세요"가 한 번 깜빡인다 → 로딩 중에는 판단을 미룬다.
  // 실패한 쿼리도 같다 — 못 읽은 것을 '없음'으로 읽으면 없는 할 일을 만들어 낸다
  // (권한이 좁은 구성원은 장치 목록에서 403을 받을 수 있다).
  const setupLoaded =
    cardListQuery.isSuccess && devicesQuery.isSuccess && recentQuery.isSuccess;
  const showChecklist =
    setupLoaded &&
    checklistDone < checklistSteps.length &&
    (recentQuery.data?.items.length ?? 0) === 0;

  const monthly = monthlyQuery.data;

  /**
   * 총액에서 빠진 것들의 공시 문구. 0인 버킷은 줄을 만들지 않는다 —
   * "0건 제외했어요"는 정보가 아니라 소음이다.
   */
  const excludedNotes = useMemo(() => {
    if (!monthly) return [];
    const { excludedByPermission, excludedManual, excludedTransfer } =
      monthly.meta;
    const notes: { key: string; text: string }[] = [];
    if (excludedManual.count > 0) {
      notes.push({
        key: "manual",
        // 금액을 함께 말한다. 건수만으로는 "18.6%가 빠졌다"를 알 수 없다.
        text: `직접 빼놓은 ${excludedManual.count}건 ${formatWon(excludedManual.net)}은 합계에 넣지 않았어요.`,
      });
    }
    if (excludedTransfer.count > 0) {
      notes.push({
        key: "transfer",
        text: `자산 이동 ${excludedTransfer.count}건 ${formatWon(excludedTransfer.net)}은 쓴 돈이 아니라 옮긴 돈이라 빼놨어요.`,
      });
    }
    if (excludedByPermission > 0) {
      // 금액 없이 건수만 — 공개범위의 요점이다.
      notes.push({
        key: "permission",
        text: `공개범위 설정으로 ${excludedByPermission}건은 합계에서 제외했어요.`,
      });
    }
    return notes;
  }, [monthly]);

  // 비교 대상 호칭: 이번 달이면 '지난달', 과거월이면 그 달의 직전 달을 명시한다.
  const prevLabel = isCurrentMonth
    ? "지난달"
    : formatMonth(addMonths(month, -1));
  const delta = monthly
    ? deltaSentence(
        monthly.deltaNet,
        monthly.deltaRate,
        monthly.previousNet,
        prevLabel,
      )
    : null;

  // --- 렌더 -----------------------------------------------------------------

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* 제목은 하단 탭('홈')과 중복이라 시각적으로 숨긴다(스크린리더용 h1만 유지).
          월 라벨이 있던 자리가 그대로 스위처가 된다 — 누적 지출의 대부분이 지난달에
          있는데도 이 화면이 이번 달만 보여주고 있었다(ADR-0026). */}
      <h1 className="sr-only">홈</h1>

      {/* 할 일 — 화면 최상단. 처리할 게 하나도 없으면 카드 자체가 사라진다.
          체크리스트(새 가족) 화면에서도 남긴다 — 문자가 왔는데 읽지 못한 상태는
          설정을 끝내기 전에도 알려야 한다.
          결제 실패 배너를 여기로 흡수했다(C-8): 같은 자리에 붉은 카드가 두 장 쌓이면
          무엇이 급한지 오히려 묻힌다. 대신 실패 줄만 destructive 톤을 유지하고 맨 위에
          둔다 — 셋 중 유일하게 **돈이 나가지 않은** 사고다. */}
      {showTodoCard ? (
        <TodoCard
          todo={todo}
          showDeclineRow={showDeclineRow}
          showReviewRow={showReviewRow}
          showParseFailedRow={showParseFailedRow}
          recentSmsCount={parseFailedCount}
          olderSmsCount={olderSmsCount}
          onOpenSms={() => setParseFailedOpen(true)}
        />
      ) : null}

      {/* 거래가 한 건도 없으면 달을 옮길 이유가 없다 — 체크리스트 화면에서는 감춘다. */}
      {showChecklist ? null : (
        <div className="flex items-center justify-end">
          <MonthSwitcher
            month={month}
            months={availableMonths}
            onChange={changeMonth}
            className="-mr-2"
          />
        </div>
      )}

      {/* 온보딩 체크리스트 — 아직 거래가 없고 3단계를 다 못 끝낸 새 가족에게만.
          아래 집계 카드들은 전부 빈 상태가 되므로 그 자리를 이걸로 대신한다. */}
      {showChecklist ? (
        <OnboardingChecklist
          steps={checklistSteps}
          doneCount={checklistDone}
          onPasteSms={() => setAddTxnOpen(true)}
        />
      ) : null}

      {showChecklist ? null : (
      <>
      {/* 히어로 — 이번 달 소비 */}
      <Card>
        <CardContent className="flex flex-col gap-4">
          {monthlyQuery.isLoading || monthlyQuery.isError ? (
            <StateNote
              loading={monthlyQuery.isLoading}
              error={monthlyQuery.error}
            />
          ) : monthly && delta ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-sm">
                  {isCurrentMonth ? "이번 달 소비" : `${formatMonth(month)} 소비`}
                </span>
                <span className="text-3xl font-bold tracking-tight tabular-nums">
                  {formatWon(monthly.totalNet)}
                </span>
                <p className={cn("text-sm font-medium", delta.className)}>
                  {delta.text}
                </p>
                {monthly.previousNet !== 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {prevLabel}에는 {formatWon(monthly.previousNet)} 썼어요
                  </p>
                ) : null}
              </div>

              <dl className="bg-muted grid grid-cols-3 divide-x rounded-lg py-3 text-center">
                <div className="flex flex-col gap-0.5 px-2">
                  <dt className="text-muted-foreground text-xs">승인</dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {formatWon(monthly.totalApproved)}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5 px-2">
                  <dt className="text-muted-foreground text-xs">취소</dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {formatWon(monthly.totalCancelled)}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5 px-2">
                  <dt className="text-muted-foreground text-xs">거래</dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {monthly.transactionCount.toLocaleString("ko-KR")}건
                  </dd>
                </div>
              </dl>

              {/*
                총액에서 빠진 것을 전부 말한다. 이전에는 `excludedByPermission`만
                공시했고, 사용자가 직접 뺀 금액과 자산 이동은 문구 없이 사라졌다 —
                실측(2026-07) 표시 총액 752,721원 옆에서 140,281원(18.6%)이 조용히
                빠져 있었다. 세 버킷은 서로 겹치지 않으므로(계약 주석 참조) 나열해도
                이중 계상이 아니다.

                권한 제외분만 금액을 말하지 않는다 — 그걸 말하면 공개범위가 무의미해진다.
              */}
              {excludedNotes.length > 0 ? (
                <div className="text-muted-foreground space-y-1 text-xs">
                  {excludedNotes.map((note) => (
                    <p key={note.key}>{note.text}</p>
                  ))}
                  {monthly.meta.excludedManual.count > 0 ? (
                    <Link
                      href={`/transactions?month=${month}&excluded=only`}
                      className="text-primary inline-block underline-offset-2 hover:underline"
                    >
                      빼놓은 거래 보기
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {/*
       * 앞으로 나갈 돈 (금액 레이어 S2). 히어로가 "얼마 썼나"를 말한 직후에 "얼마 더
       * 나가나"를 답한다 — 순서를 바꾸면 아직 안 쓴 돈이 쓴 돈보다 먼저 읽힌다.
       * 예정 0건·과거 달·Radar 꺼짐이면 컴포넌트가 스스로 사라진다.
       */}
      <UpcomingSpendCard
        isCurrentMonth={isCurrentMonth}
        monthlyNet={monthly?.totalNet ?? null}
      />

      {/* AI 인사이트(있을 때만 렌더). 자연어 질의는 하단 탭 중앙 'AI'(/ai)로 분리. */}
      <MonthlyInsightsCard month={month} />
      </>
      )}

      {showChecklist ? null : (
      <>
      {/* 예산 요약 */}
      <Card>
        <CardHeader>
          <CardTitle>
            {isCurrentMonth ? "이번 달 예산" : `${formatMonth(month)} 예산`}
          </CardTitle>
          <CardDescription>
            {isCurrentMonth
              ? "사용률이 높은 예산부터 보여드려요"
              : "그 달의 예산 달성률이에요"}
          </CardDescription>
          <CardAction>
            <SeeAllLink href="/budgets" />
          </CardAction>
        </CardHeader>
        <CardContent>
          {budgetsQuery.isLoading || budgetsQuery.isError ? (
            <StateNote
              loading={budgetsQuery.isLoading}
              error={budgetsQuery.error}
            />
          ) : topBudgets.length === 0 ? (
            <EmptyState
              emoji="🎯"
              title="아직 예산이 없어요"
              description="예산을 만들면 이번 달 사용률을 한눈에 알려드려요"
              action={
                <Button asChild variant="tint" className="w-full">
                  <Link href="/budgets">예산 만들기</Link>
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-5">
              {topBudgets.map((b) => {
                // 이름이 있으면 대상까지("구성원 · 홍길동") 표시 — 어떤 구성원 예산인지
                // 대시보드에서도 바로 보이게(/budgets 전체보기와 동일). 이름이 없으면
                // label에 이미 scopeLabel이 나오므로 meta는 스코프 타입만.
                const scope = b.name
                  ? `${SCOPE_LABEL[b.scopeType]} · ${b.scopeLabel}`
                  : SCOPE_LABEL[b.scopeType];
                const href = budgetTransactionsHref(
                  b.scopeType,
                  b.scopeRefId,
                  month,
                );
                return (
                  <UsageBar
                    key={b.id}
                    label={b.name ?? b.scopeLabel}
                    {...(href ? { href, hrefLabel: "어디서 썼는지 보기" } : {})}
                    meta={
                      b.usageRate >= 1 ? (
                        <span className="text-destructive font-semibold">
                          {scope} · 예산을 넘었어요
                        </span>
                      ) : (
                        scope
                      )
                    }
                    spent={b.spent}
                    amount={b.amount}
                    currency={b.currency}
                    usageRate={b.usageRate}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 카테고리별 지출 */}
      <Card>
        <CardHeader>
          <CardTitle>어디에 많이 썼나요?</CardTitle>
          <CardDescription>
            {isCurrentMonth ? "이번 달" : formatMonth(month)} 카테고리별
            지출이에요
          </CardDescription>
        </CardHeader>
        <CardContent>
          {categoriesQuery.isLoading || categoriesQuery.isError ? (
            <StateNote
              loading={categoriesQuery.isLoading}
              error={categoriesQuery.error}
            />
          ) : (
            <BarList
              items={categoryItems}
              formatValue={formatWon}
              emptyLabel="아직 지출 내역이 없어요"
            />
          )}
        </CardContent>
      </Card>

      {/* 가맹점별 지출 — 서버 `analytics/merchants`(타 구성원 summary_only는 '(비공개)'로
          마스킹된 상태)를 그대로 표시한다. 이 집계는 이미 있었지만 화면 소비자가
          없었다(ADR-0026). '이번 달 어디서 많이 썼나'는 카테고리보다 구체적이라
          회고에서 먼저 눈에 들어온다. */}
      <Card>
        <CardHeader>
          <CardTitle>자주 간 곳은 어디인가요?</CardTitle>
          <CardDescription>
            {isCurrentMonth ? "이번 달" : formatMonth(month)} 가맹점별 지출
            상위예요
          </CardDescription>
        </CardHeader>
        <CardContent>
          {merchantsQuery.isLoading || merchantsQuery.isError ? (
            <StateNote
              loading={merchantsQuery.isLoading}
              error={merchantsQuery.error}
            />
          ) : (
            <BarList
              items={merchantItems}
              formatValue={formatWon}
              emptyLabel="아직 지출 내역이 없어요"
            />
          )}
        </CardContent>
      </Card>

      {/* 구성원 · 카드별 지출 */}
      <Card>
        <CardHeader>
          <CardTitle>누가, 어떤 카드로 썼나요?</CardTitle>
          <CardDescription>구성원과 카드별로 모아봤어요</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <section className="flex flex-col gap-1">
            <h3 className="text-muted-foreground text-[13px] font-semibold">
              구성원
            </h3>
            {membersQuery.isLoading || membersQuery.isError ? (
              <StateNote
                loading={membersQuery.isLoading}
                error={membersQuery.error}
              />
            ) : memberItems.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-[13px]">
                아직 구성원 지출이 없어요
              </p>
            ) : (
              <div className="-mx-2 flex flex-col">
                {memberItems.map((item) => (
                  <ListRow
                    key={item.key}
                    {...(item.href ? { href: item.href } : {})}
                    icon={
                      <span className="text-sm font-semibold">
                        {initialOf(item.label)}
                      </span>
                    }
                    iconClassName={memberColorClass(
                      item.key,
                      memberColorById.get(item.key),
                    )}
                    title={item.label}
                    subtitle={`전체의 ${percent(item.ratio)}`}
                    value={<Money amount={item.value} />}
                    valueSub={item.meta}
                    chevron={item.href != null}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-muted-foreground text-[13px] font-semibold">
              카드
            </h3>
            {cardsQuery.isLoading || cardsQuery.isError ? (
              <StateNote
                loading={cardsQuery.isLoading}
                error={cardsQuery.error}
              />
            ) : cardItems.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-[13px]">
                아직 카드 지출이 없어요
              </p>
            ) : (
              <div className="-mx-2 flex flex-col">
                {cardItems.map((item) => {
                  // 카드 아이콘 색 = 그 카드 소유자 색(카드 화면과 동일). item.key=cardId,
                  // 미연결('unlinked')이면 소유자가 없어 기본 색.
                  const ownerId = cardOwnerById.get(item.key);
                  return (
                    <ListRow
                      key={item.key}
                      {...(item.href ? { href: item.href } : {})}
                      icon={<CreditCard />}
                      iconClassName={
                        ownerId
                          ? memberColorClass(ownerId, memberColorById.get(ownerId))
                          : undefined
                      }
                      title={item.label}
                      subtitle={`전체의 ${percent(item.ratio)}`}
                      value={<Money amount={item.value} />}
                      valueSub={item.meta}
                      chevron={item.href != null}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </CardContent>
      </Card>

      {/* 최근 거래 */}
      <Card>
        <CardHeader>
          <CardTitle>최근 거래</CardTitle>
          <CardDescription>가장 최근에 기록된 거래예요</CardDescription>
          <CardAction>
            <SeeAllLink href="/transactions" />
          </CardAction>
        </CardHeader>
        <CardContent>
          {recentQuery.isLoading || recentQuery.isError ? (
            <StateNote
              loading={recentQuery.isLoading}
              error={recentQuery.error}
            />
          ) : recentRows.length === 0 ? (
            <EmptyState
              emoji="🧾"
              title="아직 거래가 없어요"
              description="카드 문자 수집을 시작하면 거래가 여기에 쌓여요"
            />
          ) : (
            <div className="-mx-2 flex flex-col">
              {recentRows
                .slice(0, RECENT_DISPLAY_N)
                .map((t: TransactionSummary) => {
                  const cancelled = t.transactionType === "cancellation";
                  // 제외(excludedAt)는 status와 직교하는 플래그 — 거래 화면과 동일하게
                  // status 배지보다 우선해 '제외됨'으로 표기하고 금액을 흐리게 처리한다.
                  const excluded = t.excludedAt != null;
                  const signed = cancelled ? -t.amount : t.netAmount;
                  // 색·이름 기준 구성원 = 카드 소유자(연결된 카드가 있으면), 없으면
                  // 거래 귀속 구성원. 카드 화면의 소유자 색과 일치시킨다.
                  const attributedId =
                    (t.cardId ? cardOwnerById.get(t.cardId) : undefined) ??
                    t.memberId;
                  const who =
                    householdNameById.get(attributedId) ??
                    memberNameById.get(attributedId);
                  // 카테고리 = 아이콘(모양), 구성원 = 배경색 — 거래 목록과 동일 규칙.
                  const Icon = cancelled
                    ? RotateCcw
                    : categoryIcon(
                        t.categoryId ? categoryNameById.get(t.categoryId) : null,
                      );
                  return (
                    <ListRow
                      key={t.id}
                      icon={<Icon />}
                      iconClassName={
                        cancelled || excluded
                          ? "bg-muted text-muted-foreground"
                          : memberColorClass(
                              attributedId,
                              memberColorById.get(attributedId),
                            )
                      }
                      title={merchantLabel(t)}
                      subtitle={
                        who
                          ? `${formatDate(t.approvedAt)} · ${who}`
                          : formatDate(t.approvedAt)
                      }
                      value={
                        <span className={cn(excluded && "line-through opacity-60")}>
                          <Money amount={signed} currency={t.currency} muted={cancelled} />
                        </span>
                      }
                      valueSub={
                        cancelled ? (
                          <StatusBadge status="cancelled" label="취소" />
                        ) : excluded ? (
                          <StatusBadge
                            status="excluded"
                            label="제외됨"
                            tone="neutral"
                          />
                        ) : (
                          <StatusBadge status={t.status} />
                        )
                      }
                    />
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>
      </>
      )}

      {/* 확인 필요 문자 검토(원문+교정) 다이얼로그 — 네이티브/웹 공통.
          홈은 **최근 3일 것만** 넘긴다: 이 다이얼로그는 넘긴 건마다 상세를 한 번씩
          받으므로 전 기간 백로그를 통째로 넘기면 열자마자 요청이 수십 개 나간다.
          지난 건은 /todo에서 한 건씩 연다. */}
      <ReviewInboxDialog
        open={parseFailedOpen}
        events={parseFailedRecent}
        onClose={() => setParseFailedOpen(false)}
      />

      {/* 체크리스트의 '문자 붙여넣어 거래 추가하기' — 거래 화면과 같은 다이얼로그를
          그대로 재사용한다(장치 연결 전에도 첫 거래를 만들어 볼 수 있게). */}
      <AddTransactionDialog open={addTxnOpen} onOpenChange={setAddTxnOpen} />
    </div>
  );
}

/**
 * 홈 '할 일' 카드 (C-8 · 로드맵 366~379행 와이어프레임).
 *
 * 매일 생기는 처리 작업 3종을 홈 최상단 한 장으로 모은다. 예전에는 결제 실패가 별도
 * 배너, 나머지 둘이 히어로 아래 카드로 흩어져 있었다 — 같은 성격의 일인데 자리가
 * 셋이면 사용자는 매번 다른 곳을 봐야 한다.
 *
 * 여기는 **요약**이다. 전체(기간 제한 없는 백로그)는 `/todo`가 갖는다.
 */
function TodoCard({
  todo,
  showDeclineRow,
  showReviewRow,
  showParseFailedRow,
  recentSmsCount,
  olderSmsCount,
  onOpenSms,
}: Readonly<{
  todo: TodoCounts;
  showDeclineRow: boolean;
  showReviewRow: boolean;
  showParseFailedRow: boolean;
  /** 홈 창(최근 3일) 안쪽 문자 수. */
  recentSmsCount: number;
  /** 창 밖(지난) 문자 수 — 0이면 '더 보기' 줄을 만들지 않는다. */
  olderSmsCount: number;
  onOpenSms: () => void;
}>) {
  const top = todo.declines[0];
  const topHint = top ? declineReasonHint(top.reason) : undefined;

  return (
    <Card className="gap-0 py-2">
      <CardHeader className="px-3 pt-1 pb-2">
        <CardTitle className="text-[15px]">할 일</CardTitle>
        <CardAction>
          {/* 합계 배지 — 다음 웨이브의 탭 배지가 같은 `useTodoCounts().total`을 쓴다. */}
          {todo.total > 0 ? (
            <span className="bg-destructive text-destructive-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">
              {todo.total > 99 ? "99+" : todo.total}
            </span>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="px-3">
        {showDeclineRow ? (
          // 배너에 있던 정보(가맹점·금액·시도 횟수·조치 문구)를 한 줄로 옮겼다.
          // ListRow는 자체가 flex 행이고 제목/부제가 `min-w-0 flex-1` 안에서 truncate
          // 되므로, 배너에서 카드가 좌우로 넘치던 문제(a0f8fea)는 재발하지 않는다.
          <ListRow
            href="/declines"
            icon={<AlertTriangle />}
            iconClassName="bg-destructive/10 text-destructive"
            title="결제가 계속 실패하고 있어요"
            subtitle={
              todo.declinesError
                ? "실패한 결제를 불러오지 못했어요"
                : top
                  ? `${top.merchant ?? "어떤 가맹점"}${
                      top.amount === null ? "" : ` ${formatWon(top.amount)}`
                    } · ${top.attempts}번 거절${topHint ? ` · ${topHint}` : ""}`
                  : ""
            }
            value={
              <span className="text-destructive">
                {pendingCountText(
                  todo.declinesLoading,
                  todo.declinesError,
                  todo.declines.length,
                  false,
                )}
              </span>
            }
            chevron
          />
        ) : null}

        {showReviewRow ? (
          <ListRow
            href="/transactions"
            icon={<CircleAlert />}
            iconClassName="bg-warning/15 text-warning-strong"
            title="확인이 필요한 거래"
            subtitle={
              todo.reviewsError
                ? "건수를 불러오지 못했어요"
                : "확인필요 · 중복의심 거래를 모아뒀어요"
            }
            value={
              <span
                className={
                  !todo.reviewsLoading &&
                  !todo.reviewsError &&
                  todo.reviews.length > 0
                    ? "text-warning-strong"
                    : "text-muted-foreground"
                }
              >
                {pendingCountText(
                  todo.reviewsLoading,
                  todo.reviewsError,
                  todo.reviews.length,
                  todo.reviewsTruncated,
                )}
              </span>
            }
            chevron
          />
        ) : null}

        {showParseFailedRow ? (
          <>
            <ListRow
              icon={<MailWarning />}
              iconClassName="bg-warning/15 text-warning-strong"
              title="확인이 필요한 문자"
              subtitle={
                todo.smsError
                  ? "건수를 불러오지 못했어요"
                  : recentSmsCount > 0
                    ? "탭하면 원문을 보고 바로 확정할 수 있어요"
                    : "최근 3일 안에 온 건 없어요"
              }
              value={
                <span
                  className={
                    !todo.smsLoading && !todo.smsError && recentSmsCount > 0
                      ? "text-warning-strong"
                      : "text-muted-foreground"
                  }
                >
                  {/* '최근 3일' 창이 붙는 건 이 줄뿐이다 — 아래 '지난 문자'와 /todo는
                      전 기간이다. 라벨로 창을 명시해야 0건일 때 "없다"로 읽히지 않는다. */}
                  {todo.smsLoading || todo.smsError
                    ? pendingCountText(
                        todo.smsLoading,
                        todo.smsError,
                        recentSmsCount,
                        false,
                      )
                    : `최근 3일 ${recentSmsCount.toLocaleString("ko-KR")}건`}
                </span>
              }
              chevron={recentSmsCount > 0}
              onClick={recentSmsCount > 0 ? onOpenSms : undefined}
            />
            {/* 3일이 지난 문자는 사라지지 않는다 — 여기서 /todo로 넘긴다(D-7). */}
            {olderSmsCount > 0 ? (
              <Link
                href="/todo"
                className="text-accent-foreground hover:bg-muted/70 -mt-1 mb-1 ml-13 block rounded-lg px-2 py-2 text-[13px] font-medium transition-colors"
              >
                지난 문자 {olderSmsCount.toLocaleString("ko-KR")}
                {todo.smsTruncated ? "+" : ""}건 더 보기 ›
              </Link>
            ) : null}
          </>
        ) : null}

        {/* 카드 전체 → /todo. 세 줄은 각자의 처리 화면으로 가므로, 백로그 전체를 보는
            입구는 따로 둔다(탭이 생기기 전까지 /todo의 유일한 상시 진입점이다). */}
        <Link
          href="/todo"
          className="text-muted-foreground hover:bg-muted/70 mt-1 block rounded-lg px-2 py-2 text-center text-[13px] font-medium transition-colors"
        >
          할 일 전체 보기 ›
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * 온보딩 체크리스트 (C-1 · 디자인 진단 E-1).
 *
 * 합류 직후 홈이 빈 카드 6장이면 "다음에 뭘 해야 하는지"가 아무 데도 없다.
 * 진행률 + 3단계 + 지금 당장 해볼 수 있는 행동(문자 붙여넣기) 하나를 준다.
 */
function OnboardingChecklist({
  steps,
  doneCount,
  onPasteSms,
}: Readonly<{
  steps: ReadonlyArray<ChecklistStep>;
  doneCount: number;
  onPasteSms: () => void;
}>) {
  const progress = Math.round((doneCount / steps.length) * 100);
  return (
    <Card>
      <CardHeader>
        <CardTitle>시작하기</CardTitle>
        <CardDescription>
          카드 문자가 자동으로 모이기까지 {steps.length - doneCount}단계 남았어요
        </CardDescription>
        <CardAction>
          <span className="text-muted-foreground text-[13px] tabular-nums">
            {doneCount} / {steps.length}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div
          className="bg-muted h-2 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={doneCount}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-label="시작하기 진행률"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>

        <ul className="flex flex-col divide-y">
          {steps.map((step, index) => (
            <li key={step.key} className="flex items-center gap-3 py-3">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
                  step.done
                    ? "bg-accent text-accent-foreground"
                    : "bg-muted text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {step.done ? <Check className="size-4" /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={cn(
                    "text-[15px] font-medium",
                    step.done && "text-muted-foreground",
                  )}
                >
                  {step.title}
                </span>
                <span className="text-muted-foreground text-[13px]">
                  {step.description}
                </span>
              </span>
              {!step.done && step.href && step.cta ? (
                <Button asChild size="sm" variant="tint" className="h-9 shrink-0">
                  <Link href={step.href}>{step.cta}</Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-2 border-t pt-4">
          <p className="text-[15px] font-semibold">지금 바로 넣어볼까요?</p>
          <p className="text-muted-foreground text-[13px]">
            받은 카드 문자를 붙여넣으면 거래 한 건을 바로 만들어 볼 수 있어요.
          </p>
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="mt-1 h-11 w-full"
            onClick={onPasteSms}
          >
            문자 붙여넣어 거래 추가하기
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- 로컬 헬퍼 --------------------------------------------------------------

/**
 * 순지출 delta → 히어로 해요체 문장.
 * 증가 = text-destructive, 감소 = text-accent-foreground(오늘의집 민트).
 */
function deltaSentence(
  deltaNet: number,
  deltaRate: number | null,
  previousNet: number,
  /**
   * 비교 대상 달의 호칭. 이번 달을 볼 때는 '지난달'이지만, 과거월을 볼 때는
   * '2026년 6월'처럼 실제 달을 쓴다 — 7월 화면에서 '지난달보다'는 6월이 아니라
   * 지금 기준의 지난달로 읽힌다.
   */
  prevLabel: string,
): { text: string; className: string } {
  if (previousNet === 0) {
    return {
      text:
        prevLabel === "지난달"
          ? "지난달 기록이 없어요. 이번 달부터 차곡차곡 모아봐요"
          : `${prevLabel} 기록이 없어요`,
      className: "text-muted-foreground",
    };
  }
  if (deltaNet === 0) {
    return {
      text: `${prevLabel}과 똑같이 썼어요`,
      className: "text-muted-foreground",
    };
  }
  const rate = deltaRate != null ? ` (${percent(Math.abs(deltaRate))})` : "";
  if (deltaNet > 0) {
    return {
      text: `${prevLabel}보다 ${formatWon(deltaNet)} 더 썼어요${rate}`,
      className: "text-destructive",
    };
  }
  return {
    text: `${prevLabel}보다 ${formatWon(Math.abs(deltaNet))} 덜 썼어요${rate}`,
    className: "text-accent-foreground",
  };
}

/** 마스킹/미확인을 고려한 가맹점 표시명. */
function merchantLabel(t: TransactionSummary): string {
  if (t.masked) return "(비공개)";
  return t.merchantNormalized ?? t.merchantRaw ?? "미확인 가맹점";
}

/** 구성원 아바타용 첫 글자(라벨이 문자열일 때만). */
function initialOf(label: ReactNode): string {
  return typeof label === "string" && label.length > 0
    ? label.slice(0, 1)
    : "?";
}

/** 섹션 로딩/에러 표기. 둘 다 아니면 아무것도 렌더하지 않는다. */
function StateNote({
  loading,
  error,
}: Readonly<{ loading: boolean; error: unknown }>) {
  if (loading) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        불러오고 있어요…
      </p>
    );
  }
  if (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : "데이터를 불러오지 못했어요.";
    return (
      <p className="text-destructive text-sm" role="alert">
        {message}
      </p>
    );
  }
  return null;
}

/** 섹션 우측 "전체 보기" 텍스트 링크(오늘의집 톤). */
function SeeAllLink({
  href,
  label = "전체 보기",
}: Readonly<{ href: string; label?: string }>) {
  return (
    <Link
      href={href}
      className="text-accent-foreground text-[13px] font-medium hover:underline"
    >
      {label}
    </Link>
  );
}

