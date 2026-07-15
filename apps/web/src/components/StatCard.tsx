import type { ReactNode } from "react";

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

/** 핵심 지표 카드(순지출/전월대비 등). */
export function StatCard({ label, value, sub, trend }: StatCardProps) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {trend ? (
        <span className={`stat-trend trend-${trend.direction}`}>
          <span aria-hidden="true">{TREND_ARROW[trend.direction]}</span>{" "}
          {trend.label}
        </span>
      ) : null}
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}
