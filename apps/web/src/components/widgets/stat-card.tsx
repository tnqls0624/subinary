import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type TrendDirection = "up" | "down" | "flat";

interface StatCardProps {
  label: string;
  value: ReactNode;
  /** 값 아래 보조 설명(예: 전월 대비 금액). */
  sub?: ReactNode;
  /** 추세 배지(전월 대비 등). direction으로 색/화살표 결정. */
  trend?: { direction: TrendDirection; label: ReactNode };
}

const TREND_ARROW: Record<TrendDirection, string> = {
  up: "▲",
  down: "▼",
  flat: "—",
};

const TREND_CLASS: Record<TrendDirection, string> = {
  up: "text-destructive",
  down: "text-success",
  flat: "text-muted-foreground",
};

/** 핵심 지표 카드(순지출/전월대비 등). */
export function StatCard({ label, value, sub, trend }: StatCardProps) {
  return (
    <Card className="gap-2 p-5">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </span>
      {trend ? (
        <span
          className={cn(
            "flex items-center gap-1 text-sm font-medium",
            TREND_CLASS[trend.direction],
          )}
        >
          <span aria-hidden="true">{TREND_ARROW[trend.direction]}</span>
          {trend.label}
        </span>
      ) : null}
      {sub ? (
        <span className="text-muted-foreground text-xs">{sub}</span>
      ) : null}
    </Card>
  );
}
