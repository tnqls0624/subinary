import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

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
  /**
   * 있으면 막대 전체가 이 경로로 가는 링크가 된다(보통 필터가 걸린 거래 목록).
   * 숫자를 보여준 다음 "어디서 썼는지"로 이어지는 유일한 경로다 — 없으면 사용자는
   * 거래 탭에서 필터를 처음부터 다시 골라야 한다.
   */
  href?: string;
  /** 링크일 때 스크린리더에 읽힐 설명(기본: '거래 보기'). */
  hrefLabel?: string;
}

/** 예산 사용률 막대. 80%↑ 경고, 100%↑ 초과 색조. */
export function UsageBar({
  label,
  spent,
  amount,
  currency = "KRW",
  usageRate,
  meta,
  href,
  hrefLabel = "거래 보기",
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

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-sm font-medium">
          <span className="truncate">{label}</span>
          {href ? (
            <ChevronRight
              className="text-muted-foreground/50 size-4 shrink-0 self-center"
              aria-hidden="true"
            />
          ) : null}
        </span>
        {meta ? (
          <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>
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
    </>
  );

  if (!href) {
    return <div className="flex flex-col gap-1.5">{body}</div>;
  }

  // 음수 마진 + 패딩: 카드 안에서 정렬을 유지한 채 hover 영역만 넓힌다.
  // 세 줄 구성이라 세로 크기는 이미 44px을 넘는다.
  return (
    <Link
      href={href}
      aria-label={hrefLabel}
      className="hover:bg-muted/70 -mx-2 flex flex-col gap-1.5 rounded-lg px-2 py-2 transition-colors active:scale-[0.99]"
    >
      {body}
    </Link>
  );
}
