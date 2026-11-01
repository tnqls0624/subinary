import type { MonthlyAnalytics } from "@family/contracts";
import { ArrowRight, Info, RefreshCw } from "lucide-react";
import Link from "next/link";
import React from "react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatMonth, formatWon } from "@/lib/format";
import { HOME_REVIEW_HREF, visibleReviewCount } from "@/lib/home-finance-summary";

export interface HomeConsumptionCardProps {
  month: string;
  isCurrentMonth: boolean;
  monthly?: MonthlyAnalytics;
  loading: boolean;
  error: boolean;
  reviews: { count: number; loading: boolean; error: boolean; truncated: boolean };
  processing: { count: number; loading: boolean; error: boolean; truncated: boolean };
}

/** No work queue or empty review card: exceptions stay beside their spending. */
export function HomeConsumptionCard({
  month,
  isCurrentMonth,
  monthly,
  loading,
  error,
  reviews,
  processing,
}: HomeConsumptionCardProps) {
  const reviewCount = visibleReviewCount(reviews);
  const processingCount = visibleReviewCount(processing);
  const amountKnown = !loading && !error && monthly != null && Number.isFinite(monthly.totalNet);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{isCurrentMonth ? "이번 달 카드 사용액" : `${formatMonth(month)} 카드 사용액`}</CardTitle>
        <CardDescription>결제 취소 반영</CardDescription>
        <CardAction>
          <Link href={`/ledger/analysis?month=${encodeURIComponent(month)}`} className="text-primary inline-flex min-h-11 items-center gap-1 text-[13px]">
            분석 <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {amountKnown ? (
          <p className="break-words text-3xl font-bold tracking-tight tabular-nums" aria-label="기록된 카드 소비">{formatWon(monthly.totalNet)}</p>
        ) : (
          <p className={loading ? "text-muted-foreground text-sm" : "text-destructive text-sm"} role={loading ? "status" : "alert"}>
            {loading ? "카드 사용액을 불러오는 중이에요." : "카드 사용액을 불러오지 못했어요."}
          </p>
        )}
        {reviewCount !== null ? (
          <Link href={HOME_REVIEW_HREF} className="bg-muted text-foreground flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-[13px]">
            <Info className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">확인할 거래 {reviewCount.toLocaleString("ko-KR")}{reviews.truncated ? "+" : ""}건 · 전체 기간</span>
            <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
        ) : null}
        {processingCount !== null ? (
          <div className="text-muted-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed" role="status">
            <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>문자·환율 확인 대기 {processingCount.toLocaleString("ko-KR")}{processing.truncated ? "+" : ""}건 · 아직 사용액에 포함되지 않았어요. <Link href="/todo?section=processing" className="inline-flex min-h-11 items-center underline underline-offset-2">처리 상태 보기</Link></span>
          </div>
        ) : null}
        <Link href={`/transactions?month=${encodeURIComponent(month)}`} className="text-primary inline-flex min-h-11 items-center gap-1 text-sm font-medium">
          카드 내역 보기 <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </CardContent>
    </Card>
  );
}
