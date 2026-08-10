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
import { formatMonth } from "@/lib/format";
import { useHousehold } from "@/lib/household-context";

/** insight 종류별 아이콘/색조. */
const KIND_STYLE: Record<
  MonthlyInsightKind,
  { icon: typeof TrendingUp; className: string }
> = {
  trend: { icon: TrendingUp, className: "text-accent-foreground bg-accent" },
  anomaly: { icon: AlertTriangle, className: "text-warning-strong bg-warning/10" },
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

  // 로딩과 빈 결과는 조용히 숨긴다(대시보드 보조 카드). 다만 **에러는 알린다** —
  // 월을 넘겨가며 보는 화면에서 카드가 이유 없이 사라지면 "그 달은 인사이트가
  // 없구나"로 오해하게 된다(둘은 다른 상태다).
  if (query.isLoading || (!query.isError && insights.length === 0)) {
    return null;
  }

  const title = month ? `${formatMonth(month)} AI 인사이트` : "AI 인사이트";

  if (query.isError) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2">
          <Sparkles className="text-muted-foreground size-4" />
          <span className="text-muted-foreground text-sm">
            인사이트를 불러오지 못했어요
          </span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="text-accent-foreground size-4" />
          <span className="text-[15px] font-semibold">{title}</span>
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
