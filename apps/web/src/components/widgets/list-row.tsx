import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

interface ListRowProps {
  /** 좌측 원형 아이콘 내용(lucide 아이콘/이모지). 원형 배경은 자동. */
  icon?: ReactNode;
  /** 아이콘 원형 배경 클래스 오버라이드(기본 파랑 틴트). */
  iconClassName?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 우측 주 값(보통 금액). */
  value?: ReactNode;
  /** 우측 보조(상태 배지/시각 등). */
  valueSub?: ReactNode;
  /** 클릭 가능 행(hover/눌림 피드백 + 커서). */
  onClick?: () => void;
  /** 우측 끝 chevron 표시. */
  chevron?: boolean;
  className?: string;
}

/**
 * 리스트 행(오늘의집 톤). 표 대신 쓰는 기본 단위 —
 * [원형 아이콘] 제목/부제 ······ 값/보조 [›]
 */
export function ListRow({
  icon,
  iconClassName,
  title,
  subtitle,
  value,
  valueSub,
  onClick,
  chevron,
  className,
}: ListRowProps) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left",
        onClick &&
          "hover:bg-muted/70 cursor-pointer transition-[background-color,transform] active:scale-[0.99]",
        className,
      )}
    >
      {icon ? (
        <span
          className={cn(
            "bg-accent text-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-full text-lg [&_svg]:size-5",
            iconClassName,
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-medium">{title}</span>
        {subtitle ? (
          <span className="text-muted-foreground truncate text-[13px]">
            {subtitle}
          </span>
        ) : null}
      </span>
      {value != null || valueSub != null ? (
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {value != null ? (
            <span className="text-[15px] font-semibold tabular-nums">
              {value}
            </span>
          ) : null}
          {valueSub != null ? (
            <span className="text-muted-foreground text-[13px]">
              {valueSub}
            </span>
          ) : null}
        </span>
      ) : null}
      {chevron ? (
        <ChevronRight className="text-muted-foreground/50 size-4 shrink-0" />
      ) : null}
    </Comp>
  );
}
