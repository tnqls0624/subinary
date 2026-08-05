"use client";
/* ---------------------------------------------------------------------------
 * 결제 실패 배너 — 미해결 반복 거절이 있을 때만 나타난다.
 *
 * `declined`는 실제 체결이 아니라 거래로 승격되지 않는다(유령 거래 방지). 그 결과
 * 앱 어디에도 표시되지 않아 사용자가 실패를 알 수 없었다 — 실측(2026-07)에서
 * `분실카드 승인거절 · OO피트니스 99,000원`이 7일 연속 반복되고 승인은 0건이었는데
 * 아무 신호도 없었다(정기결제 수단 미갱신 → 멤버십 종료 추정).
 *
 * 사유를 **조치 문구로 번역**해서 보여준다. 사유 코드는 사용자에게 아무 의미가 없고,
 * "거절됨"만으로는 카드사 앱을 따로 열어야 한다.
 * ------------------------------------------------------------------------- */
import { AlertTriangle, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { formatWon } from "@/lib/format";
import { useDeclineList } from "@/lib/queries";
import type { CardSmsDeclineReason } from "@family/contracts";

/** 사유 → 사용자가 할 일. 미등록 사유는 문구 없이 건수만 보여준다(추측 안내 금지). */
const REASON_HINT: Partial<Record<CardSmsDeclineReason, string>> = {
  lost_or_stolen: "분실 신고된 카드예요 · 결제수단을 바꿔주세요",
  limit_exceeded: "한도를 넘었어요",
  insufficient_balance: "잔액이 부족해요",
  expired_card: "유효기간이 지났어요",
  suspended: "정지된 카드예요",
  invalid_credential: "카드 정보가 맞지 않아요",
};

export function DeclineBanner() {
  const { data } = useDeclineList();
  const unresolved = (data?.items ?? []).filter((d) => d.resolvedAt === null);
  if (unresolved.length === 0) return null;

  const top = unresolved[0];
  const hint = top.reason ? REASON_HINT[top.reason] : undefined;

  return (
    <Link href="/declines" className="block">
      <Card className="border-destructive/30 bg-destructive/5 flex items-center gap-3 p-4 transition-colors hover:bg-destructive/10">
        <span className="bg-destructive/10 text-destructive flex size-10 shrink-0 items-center justify-center rounded-full">
          <AlertTriangle className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            결제가 계속 실패하고 있어요
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {top.merchant ?? "어떤 가맹점"}
            {top.amount === null ? "" : ` ${formatWon(top.amount)}`} ·{" "}
            {top.attempts}번 거절
            {hint ? ` · ${hint}` : ""}
            {unresolved.length > 1 ? ` · 그 외 ${unresolved.length - 1}건` : ""}
          </span>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" />
      </Card>
    </Link>
  );
}
