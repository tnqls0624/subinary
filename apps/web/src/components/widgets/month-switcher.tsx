"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatMonth } from "@/lib/format";
import { nextAvailable, prevAvailable } from "@/lib/month";
import { cn } from "@/lib/utils";

interface MonthSwitcherProps {
  /** 현재 보고 있는 달(`YYYY-MM`). */
  month: string;
  /**
   * 거래가 있는 달의 목록(오름차순, `useAnalyticsMonths`). 이동은 이 목록 안에서만
   * 일어난다 — 빈 달로 가면 총액 0원과 `-100%` 델타만 보여 사용자를 헷갈리게 한다.
   * 로딩 중(`undefined`)이면 양쪽 화살표가 비활성.
   */
  months?: readonly string[];
  onChange: (month: string) => void;
  className?: string;
}

/**
 * `‹ 2026년 8월 ›` 월 이동 컨트롤.
 *
 * 현재월은 목록에 없을 수 있다(그 달 거래가 아직 0건). 그래서 `months`에 현재월을
 * 합쳐서 경계를 계산한다 — 그렇지 않으면 거래 없는 달 초에 뒤로 갈 수 없다.
 */
export function MonthSwitcher({
  month,
  months,
  onChange,
  className,
}: MonthSwitcherProps) {
  const available = months
    ? [...new Set([...months, month])].sort()
    : undefined;
  const prev = available ? prevAvailable(available, month) : null;
  const next = available ? nextAvailable(available, month) : null;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={prev == null}
        aria-label="이전 달"
        onClick={() => prev && onChange(prev)}
      >
        <ChevronLeft className="size-4" />
      </Button>
      {/* 라벨 폭이 달마다 흔들리면 화살표가 움직여 오탭이 난다 → 최소 폭 고정. */}
      <span className="min-w-[6.5rem] text-center text-[13px] font-medium tabular-nums">
        {formatMonth(month)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={next == null}
        aria-label="다음 달"
        onClick={() => next && onChange(next)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
