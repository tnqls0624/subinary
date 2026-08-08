import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

export interface BarListItem {
  key: string;
  label: ReactNode;
  value: number;
  /** 0~1 비율(막대 너비). 서버 ratio를 그대로 전달. */
  ratio: number;
  /** 우측 보조 텍스트(건수 등). */
  meta?: ReactNode;
  /**
   * 있으면 행 전체가 이 경로로 가는 링크가 된다(보통 필터가 걸린 거래 목록).
   * 집계값을 근거로 이동하는 유일한 경로다 — 없으면 "식비 412,000원"을 보고
   * 내역을 확인하려면 거래 탭에서 필터를 처음부터 다시 골라야 한다.
   */
  href?: string;
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
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate">{item.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="tabular-nums font-medium">
                  {formatValue ? formatValue(item.value) : item.value}
                </span>
                {item.href ? (
                  <ChevronRight
                    className="text-muted-foreground/50 size-4 self-center"
                    aria-hidden="true"
                  />
                ) : null}
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
          </>
        );
        return (
          <li key={item.key} className="flex flex-col">
            {item.href ? (
              // 음수 마진 + 패딩: 카드 안 정렬을 유지한 채 터치 영역만 넓힌다
              // (세 줄 구성이라 세로 크기는 44px을 넘는다).
              <Link
                href={item.href}
                className="hover:bg-muted/70 -mx-2 flex flex-col gap-1.5 rounded-lg px-2 py-2 transition-colors active:scale-[0.99]"
              >
                {body}
              </Link>
            ) : (
              <span className="flex flex-col gap-1.5">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
