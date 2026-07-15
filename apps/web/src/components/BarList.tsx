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
  /** 값 포맷터(기본: 그대로 표시). 보통 formatKRW 전달. */
  formatValue?: (value: number) => ReactNode;
  emptyLabel?: string;
}

/** CSS 막대 기반 순위 목록(구성원/카드/카테고리/가맹점 지출 등). 차트 라이브러리 없음. */
export function BarList({
  items,
  formatValue,
  emptyLabel = "데이터가 없습니다",
}: BarListProps) {
  if (items.length === 0) {
    return <p className="empty">{emptyLabel}</p>;
  }
  return (
    <ul className="barlist">
      {items.map((item) => {
        const width = Math.min(100, Math.max(0, item.ratio * 100));
        return (
          <li key={item.key} className="barlist-item">
            <div className="barlist-row">
              <span className="barlist-label">{item.label}</span>
              <span className="barlist-value">
                {formatValue ? formatValue(item.value) : item.value}
              </span>
            </div>
            <div className="barlist-track">
              <div className="barlist-fill" style={{ width: `${width}%` }} />
            </div>
            {item.meta ? <span className="barlist-meta">{item.meta}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
