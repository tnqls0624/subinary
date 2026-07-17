import type { ReactNode } from "react";

export interface BarListItem {
  key: string;
  label: ReactNode;
  value: number;
  /** 0~1 비율(막대 너비). 서버 ratio를 그대로 전달. */
  ratio: number;
  /** 우측 보조 텍스트(건수 등). */
  meta?: ReactNode;
}

interface BarListProps {
  items: ReadonlyArray<BarListItem>;
  /** 값 포맷터(기본: 그대로 표시). 보통 formatWon 전달. */
  formatValue?: (value: number) => ReactNode;
  emptyLabel?: string;
}

/** Tailwind 막대 기반 순위 목록(구성원/카드/카테고리/가맹점 지출 등). */
export function BarList({
  items,
  formatValue,
  emptyLabel = "데이터가 없습니다",
}: BarListProps) {
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const width = Math.min(100, Math.max(0, item.ratio * 100));
        return (
          <li key={item.key} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate">{item.label}</span>
              <span className="tabular-nums font-medium">
                {formatValue ? formatValue(item.value) : item.value}
              </span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full"
                style={{ width: `${width}%` }}
              />
            </div>
            {item.meta ? (
              <span className="text-muted-foreground text-xs">{item.meta}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
