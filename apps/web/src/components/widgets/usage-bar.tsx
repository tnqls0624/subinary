import type { ReactNode } from "react";

import { formatMoney, percent } from "@/lib/format";
import { cn } from "@/lib/utils";

interface UsageBarProps {
  label: ReactNode;
  /** 현재월 순지출(minor units, 예산 통화 기준). */
  spent: number;
  /** 예산 한도(minor units, 예산 통화 기준). */
  amount: number;
  /** 예산 통화(ISO4217). 기본 'KRW'. spent/amount 표시에 사용. */
  currency?: string;
  /** 사용률 = spent/amount(서버 계산). 1 초과 가능(초과 지출). */
  usageRate: number;
  /** 우측 상단 보조 텍스트(스코프 종류 등). */
  meta?: ReactNode;
}

/** 예산 사용률 막대. 80%↑ 경고, 100%↑ 초과 색조. */
export function UsageBar({
  label,
  spent,
  amount,
  currency = "KRW",
  usageRate,
  meta,
}: UsageBarProps) {
  const width = Math.min(100, Math.max(0, usageRate * 100));
  const fill =
    usageRate >= 1
      ? "bg-destructive"
      : usageRate >= 0.8
        ? "bg-warning"
        : "bg-primary";
  const pctText =
    usageRate >= 1
      ? "text-destructive"
      : usageRate >= 0.8
        ? "text-warning"
        : "text-muted-foreground";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {meta ? (
          <span className="text-muted-foreground text-xs">{meta}</span>
        ) : null}
      </div>
      <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full", fill)}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground tabular-nums">
          {formatMoney(spent, currency)} / {formatMoney(amount, currency)}
        </span>
        <span className={cn("tabular-nums font-medium", pctText)}>
          {percent(usageRate)}
        </span>
      </div>
    </div>
  );
}
