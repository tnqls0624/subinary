"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { HomeConsumptionCard } from "@/components/home-consumption-card";
import { HomeHousingCard } from "@/components/home-housing-card";
import { ManualAssetsSummary } from "@/components/manual-finance/asset-summary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTodoCounts } from "@/components/widgets";
import { currentMonth } from "@/lib/format";
import { useManualHousingPlans } from "@/lib/manual-finance-client";
import { useFinancialOverview } from "@/lib/loan-import-client";
import { isMonthKey } from "@/lib/month";
import { useMonthly } from "@/lib/queries";

const POLL_INTERVAL_MS = 60_000;

/** The home page displays records; it never changes a balance or a transaction. */
export default function DashboardPage() {
  return <Suspense fallback={null}><HomeView /></Suspense>;
}

function HomeView() {
  const searchParams = useSearchParams();
  const thisMonth = currentMonth();
  const selectedMonth = searchParams.get("month");
  const month = selectedMonth && isMonthKey(selectedMonth) ? selectedMonth : thisMonth;
  // Asset visibility remains separate from the existing card visibility policy.
  const scope = "household" as const;
  const assets = useFinancialOverview(scope);
  const housing = useManualHousingPlans(scope);
  const monthly = useMonthly(month, { refetchInterval: POLL_INTERVAL_MS });
  const todo = useTodoCounts({ refetchInterval: POLL_INTERVAL_MS });


  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">홈</h1>
      </header>

      <section className="space-y-2" aria-label="가족 자산">
      {assets.isPending || assets.isError || !assets.data ? (
        <Card>
          <CardHeader><CardTitle>가족과 공유한 자산</CardTitle></CardHeader>
          <CardContent><p className={assets.isError ? "text-destructive text-sm" : "text-muted-foreground text-sm"} role={assets.isError ? "alert" : "status"}>{assets.isError ? "자산을 불러오지 못했어요." : "자산을 불러오는 중이에요."}</p></CardContent>
        </Card>
      ) : <ManualAssetsSummary summary={assets.data.summary} scope={scope} hasImportedBalance={assets.data.loanItems.some((item) => item.includedInTotals)} sourceLabel={assets.data.loanItems.some((item) => item.includedInTotals) ? "직접 입력·신한 대출 파일" : "직접 입력"} />}
      {assets.data && !assets.isError && assets.data.unresolvedLoans > 0 ? (
        <p role="status" className="text-muted-foreground text-sm">확인이 필요한 대출 {assets.data.unresolvedLoans}건은 합계에서 제외했어요.</p>
      ) : null}
      <Link href={`/assets?scope=${scope}`} className="text-primary flex min-h-11 items-center justify-end gap-1 text-sm font-medium">자산 보기 <ArrowRight className="size-4" aria-hidden="true" /></Link>
      </section>

      <HomeConsumptionCard
        month={month}
        isCurrentMonth={month === thisMonth}
        monthly={monthly.data}
        loading={monthly.isLoading}
        error={monthly.isError}
        reviews={{ count: todo.reviews.length, loading: todo.reviewsLoading, error: todo.reviewsError, truncated: todo.reviewsTruncated }}
        processing={{ count: todo.processing.length, loading: todo.processingLoading, error: todo.processingError, truncated: todo.processingTruncated }}
      />

      <HomeHousingCard scope={scope} summary={housing.data?.summary} loading={housing.isPending} error={housing.isError} />
      <details className="text-muted-foreground text-xs leading-relaxed">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">금액 계산 기준</summary>
        <p className="pb-3">자산은 직접 입력한 금액과 합계 반영을 선택한 신한 대출로 계산해요. 가져온 대출은 브라우저에서 확인한 시점의 남은 원금이며, 은행의 별도 금액 기준일은 제공되지 않아요. 참고용 대출과 주택 계약금액은 합계에서 제외해요. 카드 사용액은 내가 볼 수 있는 승인·취소 내역을 기준으로 해요.</p>
      </details>
    </div>
  );
}
