import { formatWon } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MoneyProps {
  amount: number;
  className?: string;
  /** 회색 톤(부가 금액). */
  muted?: boolean;
}

/** KRW 정수 금액을 `12,500원`으로 표시하는 인라인 컴포넌트. */
export function Money({ amount, className, muted }: MoneyProps) {
  return (
    <span
      className={cn(
        "tabular-nums",
        muted && "text-muted-foreground",
        className,
      )}
    >
      {formatWon(amount)}
    </span>
  );
}
