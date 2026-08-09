import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /**
   * 원형 배경 안에 들어갈 아이콘(lucide). `emoji`와 함께 주지 않는다 —
   * 하나의 빈 상태에 그림이 둘이면 무엇을 보라는 것인지 알 수 없다.
   */
  icon?: ReactNode;
  /** 아이콘 대신 쓰는 이모지(집계 카드 계열이 쓰던 톤). */
  emoji?: string;
  title: string;
  description?: ReactNode;
  /** 다음 행동 버튼 1개. 빈 상태에서 할 일이 없으면 생략한다. */
  action?: ReactNode;
  /** 원형 배경 색 오버라이드(기본 `bg-muted`). */
  iconClassName?: string;
  className?: string;
}

/**
 * 빈 상태 — 그림 + 제목 + 설명 + (선택) 다음 행동 하나.
 *
 * 화면마다 따로 만들던 마크업을 하나로 모았다(디자인 진단 5-3의 "빈 상태 4종").
 * 같은 상황을 화면마다 다른 여백·글자 크기로 그리면 사용자는 같은 상태를 매번
 * 새로 읽어야 한다. 여기 없는 변형이 필요하면 **이 컴포넌트에 넣고** 쓰십시오 —
 * 지역 정의를 다시 만들면 다섯 번째 변형이 된다.
 */
export function EmptyState({
  icon,
  emoji,
  title,
  description,
  action,
  iconClassName,
  className,
}: Readonly<EmptyStateProps>) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          className={cn(
            "bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full [&_svg]:size-6",
            iconClassName,
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : emoji ? (
        <span className="text-3xl" aria-hidden="true">
          {emoji}
        </span>
      ) : null}
      <p className="mt-1 text-[15px] font-semibold">{title}</p>
      {description ? (
        <p className="text-muted-foreground text-[13px]">{description}</p>
      ) : null}
      {action ? <div className="mt-3 w-full max-w-60">{action}</div> : null}
    </div>
  );
}
