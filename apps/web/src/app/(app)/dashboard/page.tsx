"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 홈(대시보드) — 오늘의집 톤 카드 스택
 *
 * 활성 가족(household-context)의 이번 달 재무 현황을 단일 컬럼 카드 스택
 * (max-w-2xl)으로 보여준다.
 *  - 히어로: "이번 달 소비" 총액 큰 타이포 + 전월 대비 해요체 문장(analytics.monthly)
 *  - 확인 필요: 확인필요·중복의심 거래(→ /transactions) / 파싱 실패 문자 백로그
 *  - 예산: UsageBar 상위 5개(budgets.list), 초과 시 "예산을 넘었어요" 카피
 *  - "어디에 많이 썼나요?" 카테고리 BarList / 구성원·카드는 ListRow(analytics.*)
 *  - 최근 거래: ListRow 5건(transactions.list limit 10 중 상위 5) + 전체 보기 링크
 *
 * 모든 집계는 서버(SQL)에서 끝났다고 가정하며 여기서는 표시만 한다(합산/계산 금지).
 * 데이터는 React Query 훅(queries.ts) + authedFetch(401→refresh)로 가져온다.
 * ------------------------------------------------------------------------- */
import {
  CircleAlert,
  CreditCard,
  MailWarning,
  Receipt,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";

import type {
  BudgetScopeType,
  CardSmsEventSummary,
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
  ListRow,
  Money,
  StatusBadge,
  UsageBar,
  type BarListItem,
} from "@/components/widgets";
import { MonthlyInsightsCard } from "@/components/monthly-insights-card";
import { ApiError, apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import {
  currentMonth,
  formatDate,
  formatMonth,
  formatWon,
  percent,
} from "@/lib/format";
import { useHousehold } from "@/lib/household-context";
import {
  useBudgets,
  useCards,
  useCategories,
  useMembers,
  useMonthly,
  useTransactions,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

/** 처리 대기 건수 집계 시 한 번에 가져올 상한(초과 시 'N+' 표기). */
const REVIEW_SCAN_LIMIT = 100;

/** BarList 상위 노출 개수(구성원/카드/카테고리 공통). */
const BREAKDOWN_TOP_N = 6;

/** 예산 사용률 패널에 노출할 상위 예산 개수. */
const BUDGET_TOP_N = 5;

/** 최근 거래 홈 노출 개수(쿼리는 10건 유지, 표시만 5건). */
const RECENT_DISPLAY_N = 5;

/** 예산 스코프 → 한국어 보조 라벨(UsageBar meta). */
const SCOPE_LABEL: Record<BudgetScopeType, string> = {
  household: "가족 전체",
  member: "구성원",
  category: "카테고리",
  card: "카드",
};

// --- 페이지 -----------------------------------------------------------------

export default function DashboardPage() {
  const month = currentMonth();
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();

  // 이번 달 집계.
  const monthlyQuery = useMonthly(month);
  const membersQuery = useMembers(month);
  const cardsQuery = useCards(month);
  const categoriesQuery = useCategories(month);
  const budgetsQuery = useBudgets(month);

  // 최근 거래 10건(기간 무관, 최신순).
  const recentQuery = useTransactions({ limit: 10 });

  // 처리 대기 백로그(월 무관): 상태별로 스캔해 건수를 센다.
  const pendingReviewQuery = useTransactions({
    status: "pending_review",
    limit: REVIEW_SCAN_LIMIT,
  });
  const duplicateQuery = useTransactions({
    status: "duplicate_suspected",
    limit: REVIEW_SCAN_LIMIT,
  });

  // 파싱 실패 문자 이벤트(전용 훅/클라이언트 함수가 없어 apiFetch 직접 사용).
  const parseFailedQuery = useQuery({
    queryKey: ["card-sms-events", householdId, "parse_failed"],
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) =>
        apiFetch<CardSmsEventSummary[]>(
          `/v1/card-sms-events?householdId=${encodeURIComponent(
            householdId as string,
          )}&status=parse_failed&limit=${REVIEW_SCAN_LIMIT}`,
          { accessToken: token },
        ),
      ),
  });

  // --- 파생 데이터 ----------------------------------------------------------

  const memberItems = useMemo<BarListItem[]>(
    () =>
      (membersQuery.data?.items ?? [])
        .slice(0, BREAKDOWN_TOP_N)
        .map((m) => ({
          key: m.memberId,
          label: m.name,
          value: m.net,
          ratio: m.ratio,
          meta: `${m.count}건`,
        })),
    [membersQuery.data],
  );

  const cardItems = useMemo<BarListItem[]>(
    () =>
      (cardsQuery.data?.items ?? []).slice(0, BREAKDOWN_TOP_N).map((c) => ({
        key: c.cardId ?? "unlinked",
        label: c.issuer ? `${c.alias} · ${c.issuer}` : c.alias,
        value: c.net,
        ratio: c.ratio,
        meta: `${c.count}건`,
      })),
    [cardsQuery.data],
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
        })),
    [categoriesQuery.data],
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
    for (const m of membersQuery.data?.items ?? []) map.set(m.memberId, m.name);
    return map;
  }, [membersQuery.data]);

  const recentRows = recentQuery.data?.items ?? [];

  // 처리 대기 건수(확인필요 = pending_review + duplicate_suspected).
  const reviewLoading =
    pendingReviewQuery.isLoading || duplicateQuery.isLoading;
  const reviewError = pendingReviewQuery.isError || duplicateQuery.isError;
  const reviewCount =
    (pendingReviewQuery.data?.items.length ?? 0) +
    (duplicateQuery.data?.items.length ?? 0);
  const reviewMore =
    Boolean(pendingReviewQuery.data?.nextCursor) ||
    Boolean(duplicateQuery.data?.nextCursor);

  const parseFailedCount = parseFailedQuery.data?.length ?? 0;
  const parseFailedMore = parseFailedCount >= REVIEW_SCAN_LIMIT;

  const monthly = monthlyQuery.data;
  const delta = monthly
    ? deltaSentence(monthly.deltaNet, monthly.deltaRate, monthly.previousNet)
    : null;

  // --- 렌더 -----------------------------------------------------------------

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">홈</h1>
        <span className="text-muted-foreground text-[13px]">
          {formatMonth(month)}
        </span>
      </div>

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
                  이번 달 소비
                </span>
                <span className="text-3xl font-bold tracking-tight tabular-nums">
                  {formatWon(monthly.totalNet)}
                </span>
                <p className={cn("text-sm font-medium", delta.className)}>
                  {delta.text}
                </p>
                {monthly.previousNet !== 0 ? (
                  <p className="text-muted-foreground text-xs">
                    지난달에는 {formatWon(monthly.previousNet)} 썼어요
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

              {monthly.meta.excludedByPermission > 0 ? (
                <p className="text-muted-foreground text-xs">
                  공개범위 설정으로 {monthly.meta.excludedByPermission}건은
                  합계에서 제외했어요.
                </p>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* AI 인사이트(있을 때만 렌더). 자연어 질의는 하단 탭 중앙 'AI'(/ai)로 분리. */}
      <MonthlyInsightsCard month={month} />

      {/* 확인 필요 — 처리 대기 백로그 */}
      <Card className="gap-0 py-2">
        <CardContent className="px-3">
          <Link href="/transactions" className="block">
            <ListRow
              className="hover:bg-muted/70 transition-colors"
              icon={<CircleAlert />}
              iconClassName="bg-warning/15 text-warning"
              title="확인이 필요한 거래"
              subtitle={
                reviewError
                  ? "건수를 불러오지 못했어요"
                  : "확인필요 · 중복의심 거래를 모아뒀어요"
              }
              value={
                <span
                  className={
                    !reviewLoading && !reviewError && reviewCount > 0
                      ? "text-warning"
                      : "text-muted-foreground"
                  }
                >
                  {pendingCountText(
                    reviewLoading,
                    reviewError,
                    reviewCount,
                    reviewMore,
                  )}
                </span>
              }
              chevron
            />
          </Link>
          <ListRow
            icon={<MailWarning />}
            iconClassName="bg-warning/15 text-warning"
            title="읽지 못한 문자"
            subtitle={
              parseFailedQuery.isError
                ? "건수를 불러오지 못했어요"
                : "파싱에 실패한 카드 문자예요"
            }
            value={
              <span
                className={
                  !parseFailedQuery.isLoading &&
                  !parseFailedQuery.isError &&
                  parseFailedCount > 0
                    ? "text-warning"
                    : "text-muted-foreground"
                }
              >
                {pendingCountText(
                  parseFailedQuery.isLoading,
                  parseFailedQuery.isError,
                  parseFailedCount,
                  parseFailedMore,
                )}
              </span>
            }
          />
        </CardContent>
      </Card>

      {/* 예산 요약 */}
      <Card>
        <CardHeader>
          <CardTitle>이번 달 예산</CardTitle>
          <CardDescription>사용률이 높은 예산부터 보여드려요</CardDescription>
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
              {topBudgets.map((b) => (
                <UsageBar
                  key={b.id}
                  label={b.name ?? b.scopeLabel}
                  meta={
                    b.usageRate >= 1 ? (
                      <span className="text-destructive font-semibold">
                        {SCOPE_LABEL[b.scopeType]} · 예산을 넘었어요
                      </span>
                    ) : (
                      SCOPE_LABEL[b.scopeType]
                    )
                  }
                  spent={b.spent}
                  amount={b.amount}
                  usageRate={b.usageRate}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 카테고리별 지출 */}
      <Card>
        <CardHeader>
          <CardTitle>어디에 많이 썼나요?</CardTitle>
          <CardDescription>이번 달 카테고리별 지출이에요</CardDescription>
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
                    icon={
                      <span className="text-sm font-semibold">
                        {initialOf(item.label)}
                      </span>
                    }
                    title={item.label}
                    subtitle={`전체의 ${percent(item.ratio)}`}
                    value={<Money amount={item.value} />}
                    valueSub={item.meta}
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
                {cardItems.map((item) => (
                  <ListRow
                    key={item.key}
                    icon={<CreditCard />}
                    title={item.label}
                    subtitle={`전체의 ${percent(item.ratio)}`}
                    value={<Money amount={item.value} />}
                    valueSub={item.meta}
                  />
                ))}
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
                  const signed = cancelled ? -t.amount : t.netAmount;
                  const who = memberNameById.get(t.memberId);
                  return (
                    <ListRow
                      key={t.id}
                      icon={cancelled ? <RotateCcw /> : <Receipt />}
                      iconClassName={
                        cancelled
                          ? "bg-muted text-muted-foreground"
                          : undefined
                      }
                      title={merchantLabel(t)}
                      subtitle={
                        who
                          ? `${formatDate(t.approvedAt)} · ${who}`
                          : formatDate(t.approvedAt)
                      }
                      value={<Money amount={signed} muted={cancelled} />}
                      valueSub={
                        cancelled ? (
                          <StatusBadge status="cancelled" label="취소" />
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
    </div>
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
): { text: string; className: string } {
  if (previousNet === 0) {
    return {
      text: "지난달 기록이 없어요. 이번 달부터 차곡차곡 모아봐요",
      className: "text-muted-foreground",
    };
  }
  if (deltaNet === 0) {
    return {
      text: "지난달과 똑같이 썼어요",
      className: "text-muted-foreground",
    };
  }
  const rate = deltaRate != null ? ` (${percent(Math.abs(deltaRate))})` : "";
  if (deltaNet > 0) {
    return {
      text: `지난달보다 ${formatWon(deltaNet)} 더 썼어요${rate}`,
      className: "text-destructive",
    };
  }
  return {
    text: `지난달보다 ${formatWon(Math.abs(deltaNet))} 덜 썼어요${rate}`,
    className: "text-accent-foreground",
  };
}

/** 처리 대기 건수 표기(로딩 … / 에러 — / 'N건' 또는 'N+건'). */
function pendingCountText(
  loading: boolean,
  error: boolean,
  count: number,
  plus: boolean,
): string {
  if (loading) return "…";
  if (error) return "—";
  return `${count.toLocaleString("ko-KR")}${plus ? "+" : ""}건`;
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

/** 빈 상태(이모지 + 해요체 안내 + 선택 CTA 1개). */
function EmptyState({
  emoji,
  title,
  description,
  action,
}: Readonly<{
  emoji: string;
  title: string;
  description: string;
  action?: ReactNode;
}>) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-8 text-center">
      <span className="text-3xl" aria-hidden="true">
        {emoji}
      </span>
      <p className="mt-1 text-[15px] font-semibold">{title}</p>
      <p className="text-muted-foreground text-[13px]">{description}</p>
      {action ? <div className="mt-3 w-full max-w-60">{action}</div> : null}
    </div>
  );
}
