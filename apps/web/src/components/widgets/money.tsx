import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MoneyProps {
  /** minor-units 금액(해당 통화 기준). */
  amount: number;
  /** ISO4217 통화 코드. 기본 'KRW'(지수 0 → `12,500원`). USD 등은 `$22.00`. */
  currency?: string;
  className?: string;
  /** 회색 톤(부가 금액). */
  muted?: boolean;
}

/** minor-units 금액을 통화별로 표시하는 인라인 컴포넌트(₩12,500 / $22.00). */
export function Money({ amount, currency = "KRW", className, muted }: MoneyProps) {
  return (
    <span
      className={cn(
        "tabular-nums",
        muted && "text-muted-foreground",
        className,
      )}
    >
      {formatMoney(amount, currency)}
    </span>
  );
}
