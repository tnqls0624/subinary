import { formatKRW } from "@/lib/format";

interface MoneyProps {
  amount: number;
  className?: string;
  /** 회색 톤(부가 금액). */
  muted?: boolean;
}

/** KRW 정수 금액을 `₩12,500`으로 표시하는 인라인 컴포넌트. */
export function Money({ amount, className, muted }: MoneyProps) {
  const classes = ["money"];
  if (muted) classes.push("money-muted");
  if (className) classes.push(className);
  return <span className={classes.join(" ")}>{formatKRW(amount)}</span>;
}
