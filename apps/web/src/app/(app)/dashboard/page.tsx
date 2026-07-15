"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 대시보드 (Phase 5 §6.2 · P6)
 *
 * 활성 가족(household-context)의 이번 달 재무 현황을 한눈에 보여준다.
 *  - 순지출 StatCard + 전월 대비 delta(analytics.monthly)
 *  - 구성원/카드/카테고리별 지출 BarList(analytics.members/cards/categories)
 *  - 예산 사용률 상위(budgets.list)
 *  - 최근 거래 10건 Table(transactions.list)
 *  - 처리 대기 알림: 확인필요(pending_review + duplicate_suspected → /transactions),
 *    파싱실패(card-sms-events?status=parse_failed)
 *
 * 모든 집계는 서버(SQL)에서 끝났다고 가정하며 여기서는 표시만 한다(합산/계산 금지).
 * 데이터는 React Query 훅(P5 queries.ts) + authedFetch(401→refresh)로 가져온다.
 * ------------------------------------------------------------------------- */
import Link from "next/link";
import { useMemo, type CSSProperties, type ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";

import type {
  BudgetScopeType,
  CardSmsEventSummary,
  TransactionSummary,
} from "@family/contracts";

import {
  BarList,
  Money,
  StatCard,
  StatusBadge,
  Table,
  UsageBar,
  type BarListItem,
  type TableColumn,
  type TrendDirection,
} from "@/components";
import { ApiError, apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import {
  currentMonth,
  formatDate,
  formatKRW,
  formatMonth,
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

/** 처리 대기 건수 집계 시 한 번에 가져올 상한(초과 시 'N+' 표기). */
const REVIEW_SCAN_LIMIT = 100;

/** BarList 상위 노출 개수(구성원/카드/카테고리 공통). */
const BREAKDOWN_TOP_N = 6;

/** 예산 사용률 패널에 노출할 상위 예산 개수. */
const BUDGET_TOP_N = 5;

/** 예산 스코프 → 한국어 보조 라벨(UsageBar meta). */
const SCOPE_LABEL: Record<BudgetScopeType, string> = {
  household: "가족 전체",
  member: "구성원",
  category: "카테고리",
  card: "카드",
};

/** BarList 3분할 반응형 그리드(전용 CSS 없이 인라인). */
const BREAKDOWN_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 14,
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

  // 최근 거래 테이블의 구성원명 매핑(analytics.members 결과 재활용).
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

  // --- 렌더 -----------------------------------------------------------------

  const recentColumns: ReadonlyArray<TableColumn<TransactionSummary>> = [
    {
      key: "approvedAt",
      header: "일시",
      render: (t) => formatDate(t.approvedAt),
    },
    {
      key: "merchant",
      header: "가맹점",
      render: (t) => merchantLabel(t),
    },
    {
      key: "member",
      header: "구성원",
      render: (t) => memberNameById.get(t.memberId) ?? "—",
    },
    {
      key: "amount",
      header: "금액",
      align: "right",
      render: (t) => {
        const signed =
          t.transactionType === "cancellation" ? -t.amount : t.netAmount;
        return (
          <Money amount={signed} muted={t.transactionType === "cancellation"} />
        );
      },
    },
    {
      key: "status",
      header: "상태",
      align: "center",
      render: (t) =>
        t.transactionType === "cancellation" ? (
          <StatusBadge status="cancelled" label="취소" />
        ) : (
          <StatusBadge status={t.status} />
        ),
    },
  ];

  return (
    <div className="stack">
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "baseline" }}
      >
        <h1 className="section-title" style={{ marginBottom: 0 }}>
          대시보드
        </h1>
        <span className="text-muted">{formatMonth(month)}</span>
      </div>

      {/* 핵심 지표 */}
      <section className="stack">
        {monthlyQuery.isLoading || monthlyQuery.isError ? (
          <StateNote
            loading={monthlyQuery.isLoading}
            error={monthlyQuery.error}
          />
        ) : monthly ? (
          <>
            <div className="grid-cards">
              <StatCard
                label="이번 달 순지출"
                value={formatKRW(monthly.totalNet)}
                trend={buildTrend(monthly.deltaNet, monthly.deltaRate)}
                sub={
                  monthly.previousNet === 0
                    ? "전월 지출 없음"
                    : `전월 ${formatKRW(monthly.previousNet)}`
                }
              />
              <StatCard
                label="승인 총액"
                value={formatKRW(monthly.totalApproved)}
              />
              <StatCard
                label="취소 총액"
                value={formatKRW(monthly.totalCancelled)}
              />
              <StatCard
                label="거래 건수"
                value={`${monthly.transactionCount.toLocaleString("ko-KR")}건`}
              />
            </div>
            {monthly.meta.excludedByPermission > 0 ? (
              <p className="text-subtle" style={{ fontSize: "0.8rem", margin: 0 }}>
                공개범위 설정으로 {monthly.meta.excludedByPermission}건이 합계에서
                제외되었습니다.
              </p>
            ) : null}
          </>
        ) : null}

        {/* 처리 대기 알림 */}
        <div className="grid-cards">
          <AlertTile
            label="확인 필요"
            hint="확인필요 · 중복의심"
            count={reviewCount}
            plus={reviewMore}
            tone="warning"
            href="/transactions"
            loading={reviewLoading}
            error={reviewError}
          />
          <AlertTile
            label="파싱 실패"
            hint="문자 파싱 실패 이벤트"
            count={parseFailedCount}
            plus={parseFailedMore}
            tone="danger"
            loading={parseFailedQuery.isLoading}
            error={parseFailedQuery.isError}
          />
        </div>
      </section>

      {/* 지출 분해(구성원/카드/카테고리) */}
      <div style={BREAKDOWN_GRID}>
        <Panel title="구성원별 지출">
          {membersQuery.isLoading || membersQuery.isError ? (
            <StateNote
              loading={membersQuery.isLoading}
              error={membersQuery.error}
            />
          ) : (
            <BarList items={memberItems} formatValue={formatKRW} />
          )}
        </Panel>

        <Panel title="카드별 지출">
          {cardsQuery.isLoading || cardsQuery.isError ? (
            <StateNote loading={cardsQuery.isLoading} error={cardsQuery.error} />
          ) : (
            <BarList items={cardItems} formatValue={formatKRW} />
          )}
        </Panel>

        <Panel title="카테고리별 지출">
          {categoriesQuery.isLoading || categoriesQuery.isError ? (
            <StateNote
              loading={categoriesQuery.isLoading}
              error={categoriesQuery.error}
            />
          ) : (
            <BarList items={categoryItems} formatValue={formatKRW} />
          )}
        </Panel>
      </div>

      {/* 예산 사용률 */}
      <Panel
        title="예산 사용률"
        action={
          <Link href="/budgets" className="text-muted" style={{ fontSize: "0.85rem" }}>
            전체 보기
          </Link>
        }
      >
        {budgetsQuery.isLoading || budgetsQuery.isError ? (
          <StateNote
            loading={budgetsQuery.isLoading}
            error={budgetsQuery.error}
          />
        ) : topBudgets.length === 0 ? (
          <p className="empty">
            설정된 예산이 없습니다.{" "}
            <Link href="/budgets">예산 만들기</Link>
          </p>
        ) : (
          <div>
            {topBudgets.map((b) => (
              <UsageBar
                key={b.id}
                label={b.name ?? b.scopeLabel}
                meta={SCOPE_LABEL[b.scopeType]}
                spent={b.spent}
                amount={b.amount}
                usageRate={b.usageRate}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* 최근 거래 */}
      <Panel
        title="최근 거래"
        action={
          <Link
            href="/transactions"
            className="text-muted"
            style={{ fontSize: "0.85rem" }}
          >
            전체 거래
          </Link>
        }
      >
        {recentQuery.isLoading || recentQuery.isError ? (
          <StateNote loading={recentQuery.isLoading} error={recentQuery.error} />
        ) : (
          <Table
            columns={recentColumns}
            rows={recentRows}
            rowKey={(t) => t.id}
            emptyLabel="거래 내역이 없습니다"
          />
        )}
      </Panel>
    </div>
  );
}

// --- 로컬 헬퍼 --------------------------------------------------------------

/** 순지출 delta → StatCard trend(지출 증가=up/붉은색, 감소=down/초록색). */
function buildTrend(
  deltaNet: number,
  deltaRate: number | null,
): { direction: TrendDirection; label: ReactNode } {
  const direction: TrendDirection =
    deltaNet > 0 ? "up" : deltaNet < 0 ? "down" : "flat";
  const rate = deltaRate != null ? ` · ${percent(Math.abs(deltaRate))}` : "";
  return {
    direction,
    label: `${formatKRW(Math.abs(deltaNet))}${rate}`,
  };
}

/** 마스킹/미확인을 고려한 가맹점 표시명. */
function merchantLabel(t: TransactionSummary): string {
  if (t.masked) return "(비공개)";
  return t.merchantNormalized ?? t.merchantRaw ?? "미확인 가맹점";
}

/** 섹션 로딩/에러 표기. 둘 다 아니면 아무것도 렌더하지 않는다. */
function StateNote({
  loading,
  error,
}: Readonly<{ loading: boolean; error: unknown }>) {
  if (loading) {
    return (
      <div className="loader" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>불러오는 중…</span>
      </div>
    );
  }
  if (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : "데이터를 불러오지 못했습니다.";
    return (
      <p className="form-error" role="alert">
        {message}
      </p>
    );
  }
  return null;
}

/** 패널(제목 + 선택적 우측 액션 + 본문). */
function Panel({
  title,
  action,
  children,
}: Readonly<{ title: string; action?: ReactNode; children: ReactNode }>) {
  return (
    <section className="panel">
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 14 }}
      >
        <h2 className="panel-title" style={{ marginBottom: 0 }}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 처리 대기 알림 타일. count>0이면 tone 색으로 강조, href 지정 시 링크. */
function AlertTile({
  label,
  hint,
  count,
  plus,
  tone,
  href,
  loading,
  error,
}: Readonly<{
  label: string;
  hint: string;
  count: number;
  plus: boolean;
  tone: "warning" | "danger";
  href?: string;
  loading: boolean;
  error: boolean;
}>) {
  const active = count > 0;
  const accent =
    tone === "danger" ? "var(--danger)" : "var(--warning)";
  const valueColor = active ? accent : "var(--text-subtle)";

  const valueText = loading
    ? "…"
    : error
      ? "—"
      : `${count.toLocaleString("ko-KR")}${plus ? "+" : ""}건`;

  const body = (
    <div
      className="stat-card"
      style={active ? { borderColor: accent } : undefined}
    >
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={{ color: valueColor }}>
        {valueText}
      </span>
      <span className="stat-sub">{error ? "불러오지 못함" : hint}</span>
    </div>
  );

  if (!href) return body;
  return (
    <Link
      href={href}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      {body}
    </Link>
  );
}
