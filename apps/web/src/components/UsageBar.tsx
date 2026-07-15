import type { ReactNode } from "react";

import { formatKRW, percent } from "@/lib/format";

interface UsageBarProps {
  label: ReactNode;
  /** 현재월 순지출(KRW 정수). */
  spent: number;
  /** 예산 한도(KRW 정수). */
  amount: number;
  /** 사용률 = spent/amount(서버 계산). 1 초과 가능(초과 지출). */
  usageRate: number;
  /** 우측 상단 보조 텍스트(스코프 종류 등). */
  meta?: ReactNode;
}

/** 예산 사용률 막대. 80%↑ 경고, 100%↑ 초과 색조. */
export function UsageBar({ label, spent, amount, usageRate, meta }: UsageBarProps) {
  const width = Math.min(100, Math.max(0, usageRate * 100));
  const tone = usageRate >= 1 ? "over" : usageRate >= 0.8 ? "warn" : "ok";
  return (
    <div className="usagebar">
      <div className="usagebar-row">
        <span className="usagebar-label">{label}</span>
        {meta ? <span className="usagebar-meta">{meta}</span> : null}
      </div>
      <div className="usagebar-track">
        <div
          className={`usagebar-fill usage-${tone}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="usagebar-figure">
        <span>
          {formatKRW(spent)} / {formatKRW(amount)}
        </span>
        <span className={`usagebar-pct usage-${tone}-text`}>
          {percent(usageRate)}
        </span>
      </div>
    </div>
  );
}
