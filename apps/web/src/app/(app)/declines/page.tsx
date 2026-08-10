"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 실패한 결제 (/declines)
 *
 * `declined`(승인거절)는 실제 체결이 아니라 거래로 승격되지 않는다 — 유령 거래를 만들지
 * 않기 위한 옳은 설계다. 그런데 그 결과 앱 어디에도 나타나지 않아 사용자가 실패를 알 수
 * 없었다. 실측(2026-07): `분실카드 승인거절 · OO피트니스 99,000원`이 7일 연속 15:00에
 * 반복되고 승인은 0건 — 정기결제 수단을 갱신하지 않아 멤버십이 끊긴 것으로 보이는데
 * 아무 신호도 없었다.
 *
 * 카드사가 매일 재시도하므로 시도를 낱개로 보여주면 같은 사건이 7줄이 된다. 서버가
 * `(가맹점, 금액)`으로 묶어 주고, 여기서는 **미해결 먼저** 보여준다.
 * ------------------------------------------------------------------------- */
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  declineGroupKey,
  declineReasonHint,
  PageBackHeader,
} from "@/components/widgets";
import { formatRelativeTime, formatWon } from "@/lib/format";
import { useDeclineList, useSetDeclineDismissed } from "@/lib/queries";
import type { CardSmsDeclineGroup } from "@family/contracts";

function DeclineRow({ item }: { item: CardSmsDeclineGroup }) {
  const autoResolved = item.resolvedAt !== null;
  const dismissed = item.dismissedAt !== null;
  // 조치가 끝난 것(자동 해결 또는 사용자 확인)은 회색 톤으로 내린다.
  const done = autoResolved || dismissed;
  // 사유 → 조치 문구는 홈 '할 일' 카드와 **같은 표**를 쓴다(사본을 두면 갈린다).
  const hint = declineReasonHint(item.reason);
  const mutation = useSetDeclineDismissed();

  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
          done
            ? "bg-muted text-muted-foreground"
            : "bg-destructive/10 text-destructive"
        }`}
      >
        {done ? (
          <CheckCircle2 className="size-4" />
        ) : (
          <AlertTriangle className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {item.merchant ?? "확인 안 된 가맹점"}
          </span>
          <Badge variant={done ? "secondary" : "destructive"}>
            {autoResolved
              ? "해결됨"
              : dismissed
                ? "확인함"
                : `${item.attempts}번 거절`}
          </Badge>
        </span>
        <span className="text-muted-foreground mt-1 block text-xs">
          {item.amount === null ? "금액 미확인" : formatWon(item.amount)}
          {item.issuer ? ` · ${item.issuer}` : ""}
          {item.maskedCardNumber ? ` ${item.maskedCardNumber}` : ""}
        </span>
        {autoResolved ? (
          <span className="text-muted-foreground mt-1 block text-xs">
            {formatRelativeTime(item.resolvedAt)}에 결제됐어요
          </span>
        ) : hint ? (
          <span
            className={`mt-1 block text-xs font-medium ${
              dismissed ? "text-muted-foreground" : "text-destructive"
            }`}
          >
            {hint}
          </span>
        ) : null}
        <span className="text-muted-foreground mt-1 block text-[11px]">
          마지막 시도 {formatRelativeTime(item.lastAttemptAt)}
        </span>

        {/* 자동 해결된 것에는 버튼을 두지 않는다 — 이미 승인 기록으로 끝난 사건이다.
            직접 확인한 것은 되돌릴 수 있게 남긴다(잘못 눌렀을 때 복구 경로). */}
        {autoResolved ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1.5 -ml-2 h-8"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                merchant: item.merchant,
                amount: item.amount,
                dismissed: !dismissed,
              })
            }
          >
            {dismissed ? "다시 알려주세요" : "확인했어요"}
          </Button>
        )}
      </span>
    </div>
  );
}

export default function DeclinesPage() {
  const { data, isLoading, isError } = useDeclineList();
  const items = data?.items ?? [];
  // 조치가 필요한 것 = 자동 해결도, 사용자 확인도 안 된 것.
  const unresolved = items.filter(
    (i) => i.resolvedAt === null && i.dismissedAt === null,
  );
  const resolved = items.filter(
    (i) => i.resolvedAt !== null || i.dismissedAt !== null,
  );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PageBackHeader
        title="실패한 결제"
        subtitle="거절된 결제는 거래 목록에 잡히지 않아 여기서 따로 보여줘요"
      />

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : isError ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            실패 목록을 불러오지 못했어요
          </p>
        </Card>
      ) : items.length === 0 ? (
        <Card className="p-8 text-center">
          <CheckCircle2 className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium">실패한 결제가 없어요</p>
          <p className="text-muted-foreground mt-1 text-sm">
            거절된 결제가 생기면 여기에 모아서 알려드려요
          </p>
        </Card>
      ) : (
        <>
          {unresolved.length > 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground px-1 text-xs font-medium">
                아직 해결되지 않았어요 {unresolved.length}건
              </p>
              <Card className="divide-border divide-y overflow-hidden p-0">
                {unresolved.map((item) => (
                  <DeclineRow key={declineGroupKey(item)} item={item} />
                ))}
              </Card>
            </div>
          ) : null}

          {resolved.length > 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground px-1 text-xs font-medium">
                해결됐거나 확인한 것 {resolved.length}건
              </p>
              <Card className="divide-border divide-y overflow-hidden p-0">
                {resolved.map((item) => (
                  <DeclineRow key={declineGroupKey(item)} item={item} />
                ))}
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
