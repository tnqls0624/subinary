"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 월간 인사이트 카드 (AI)
 *
 * 대시보드 로드 시 자동으로 GET /v1/ai/monthly-insights 를 조회해, 전월 대비 추세·
 * 이상 지출·예산 소진 예측을 해요체 문구로 보여준다. 사실은 전부 서버가 계산하고
 * LLM은 문구만 다듬는다(키 없으면 서버 문구 그대로). 인사이트가 없으면 렌더 안 함.
 * ------------------------------------------------------------------------- */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Sparkles, TrendingUp, Wallet } from "lucide-react";

import type { MonthlyInsight, MonthlyInsightKind } from "@family/contracts";

import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";

/** insight 종류별 아이콘/색조. */
const KIND_STYLE: Record<
  MonthlyInsightKind,
  { icon: typeof TrendingUp; className: string }
> = {
  trend: { icon: TrendingUp, className: "text-accent-foreground bg-accent" },
  anomaly: { icon: AlertTriangle, className: "text-warning bg-warning/10" },
  budget: { icon: Wallet, className: "text-destructive bg-destructive/10" },
};

export function MonthlyInsightsCard({ month }: { month?: string }) {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();

  const query = useQuery({
    queryKey: ["monthly-insights", householdId, month ?? null],
    enabled: householdId != null,
    staleTime: 5 * 60_000,
    queryFn: () =>
      authedFetch((token) =>
        api.ai.monthlyInsights(token, {
          householdId: householdId as string,
          ...(month ? { month } : {}),
        }),
      ),
  });

  const insights: MonthlyInsight[] = query.data?.insights ?? [];

  // 로딩/에러/빈 결과는 조용히 숨긴다(대시보드 보조 카드).
  if (query.isLoading || query.isError || insights.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="text-accent-foreground size-4" />
          <span className="text-[15px] font-semibold">이번 달 AI 인사이트</span>
        </div>
        <ul className="flex flex-col gap-2.5">
          {insights.map((insight, i) => {
            const style = KIND_STYLE[insight.kind];
            const Icon = style.icon;
            return (
              <li key={i} className="flex items-start gap-3">
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full ${style.className}`}
                >
                  <Icon className="size-4" />
                </span>
                <span className="pt-1 text-sm leading-snug">
                  {insight.message}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
