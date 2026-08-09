"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 정기 지출 Radar (/more/recurring) — C-5 **최소 제품**
 *
 * 이 화면이 하는 일은 둘뿐이다.
 *   1. 반복으로 보이는 결제 후보를 보여준다
 *   2. 사용자가 "정기 결제 맞음 / 아님"을 확정한다
 *
 * ⛔ **의도적으로 없는 것**: 다음 결제 예상일 · 이번 달 정기 지출 총액 · 예정 알림 ·
 * 해지 종료 처리 · 카드 교체 CTA. 금액 계약(ADR-0027)이 아직 enforce 전이라
 * `net_amount`가 확정이 아니고, 그 위에서 "다음 달 12,900원이 나갑니다"를 띄우면
 * 틀린 예고를 하는 것이다. 로드맵 5-1절도 "S4는 후보 표시와 사용자 확정까지"로 정했다.
 * 여기에 금액 기반 표면을 얹으려면 enforce와 과거 수리, 전량 재계산이 먼저다.
 *
 * 그래서 화면은 금액을 **관측된 사실**로만 말한다("최근 3회 13,500원"). 예측하지 않는다.
 * ------------------------------------------------------------------------- */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Loader2,
  RefreshCw,
  Repeat,
  X,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import type {
  CardSmsDeclineReason,
  RecurringSeriesItem,
  RecurringSeriesListResponse,
} from "@family/contracts";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Money,
  PageBackHeader,
  StatusBadge,
  declineReasonHint,
} from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import {
  decideRecurringSeries,
  fetchRecurringSeries,
  recomputeRecurringSeries,
  recurringQueryKey,
} from "./recurring-api";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** 관측된 사실만 말한다 — "월 1회"가 아니라 "약 30일마다"(우리가 본 것). */
function cadenceText(item: RecurringSeriesItem): string {
  return item.cadence === "weekly"
    ? `약 ${item.intervalDays}일마다 · ${item.occurrenceCount}회 관측`
    : `약 ${item.intervalDays}일마다 · ${item.occurrenceCount}회 관측`;
}

/** 재검토 사유를 사람 말로. 무엇이 바뀌었고 왜 다시 묻는지 말해야 한다. */
function needsReviewText(item: RecurringSeriesItem): string | null {
  switch (item.needsReviewReason) {
    case "evidence_lost":
      return "근거가 된 거래가 사라졌어요. 아직도 정기 결제인지 다시 확인해 주세요.";
    case "merged":
      return "가맹점을 하나로 묶으면서 다른 항목과 합쳐졌어요. 어느 쪽이 맞는지 다시 확인해 주세요.";
    case "split":
      return "가맹점 묶음이 풀리면서 여러 건으로 나뉘었어요. 다시 확인해 주세요.";
    default:
      return null;
  }
}

/** 후보 한 줄. 확정/거부 두 버튼이 전부다. */
function SeriesRow({
  item,
  busy,
  onDecide,
}: {
  item: RecurringSeriesItem;
  busy: boolean;
  onDecide: (decision: "confirmed" | "rejected") => void;
}) {
  const review = needsReviewText(item);
  const declineHint = declineReasonHint(
    item.recentDeclineReason as CardSmsDeclineReason | null,
  );
  const varies = item.amountMin !== item.amountMax;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[15px] font-medium">
              {item.merchant}
            </span>
            <span className="text-muted-foreground text-[13px]">
              {cadenceText(item)}
            </span>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <Money amount={item.amount} currency={item.currency} />
            {varies ? (
              // 변동형 구독은 대표 금액만 보여주면 사용자가 "왜 다르지?"를 앱 밖에서 찾는다.
              <span className="text-muted-foreground text-[12px] tabular-nums">
                <Money amount={item.amountMin} currency={item.currency} muted />
                {" ~ "}
                <Money amount={item.amountMax} currency={item.currency} muted />
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {item.status === "confirmed" ? (
            <StatusBadge status={item.status} tone="success" label="정기 결제" />
          ) : null}
          {item.status === "rejected" ? (
            <StatusBadge
              status={item.status}
              tone="neutral"
              label="정기 결제 아님"
            />
          ) : null}
          {item.status === "needs_review" ? (
            <StatusBadge
              status={item.status}
              tone="warning"
              label="다시 확인 필요"
            />
          ) : null}
          {!item.mine ? (
            <StatusBadge status="member" tone="neutral" label="가족 구성원" />
          ) : null}
          <span className="text-muted-foreground text-[12px]">
            {formatDate(item.firstSeenAt)} ~ {formatDate(item.lastSeenAt)}
          </span>
        </div>

        {review ? (
          <p className="text-muted-foreground text-[13px]">{review}</p>
        ) : null}

        {item.recentDeclineAttempts >= 2 ? (
          // 반복 거절은 기존 사유별 조치 화면으로 연결한다 — 여기서 조치를 새로 만들지 않는다.
          <Link
            href="/declines"
            className="flex items-center gap-1.5 text-[13px] text-amber-600 dark:text-amber-500"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="truncate">
              {declineHint ??
                `최근 ${item.recentDeclineAttempts}번 결제에 실패했어요`}
            </span>
          </Link>
        ) : null}

        <div className="flex gap-2">
          <Button
            variant={item.status === "confirmed" ? "default" : "outline"}
            size="sm"
            className="flex-1"
            disabled={busy}
            onClick={() => onDecide("confirmed")}
          >
            <Check className="size-4" />
            정기 결제 맞아요
          </Button>
          <Button
            variant={item.status === "rejected" ? "default" : "outline"}
            size="sm"
            className="flex-1"
            disabled={busy}
            onClick={() => onDecide("rejected")}
          >
            <X className="size-4" />
            아니에요
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RecurringPage() {
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();
  const queryClient = useQueryClient();

  const seriesQuery = useQuery<RecurringSeriesListResponse>({
    queryKey: recurringQueryKey(householdId),
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) => fetchRecurringSeries(token, householdId as string)),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: recurringQueryKey(householdId) });

  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
    }: {
      id: string;
      decision: "confirmed" | "rejected";
    }) => authedFetch((token) => decideRecurringSeries(token, id, decision)),
    onSuccess: async (_, variables) => {
      await invalidate();
      toast.success(
        variables.decision === "confirmed"
          ? "정기 결제로 표시했어요."
          : "정기 결제가 아닌 것으로 표시했어요.",
      );
    },
    onError: () => toast.error("저장하지 못했어요. 잠시 후 다시 시도해 주세요."),
  });

  const recompute = useMutation({
    mutationFn: () =>
      authedFetch((token) =>
        recomputeRecurringSeries(token, householdId as string),
      ),
    onSuccess: async (result) => {
      await invalidate();
      toast.success(
        result.needsReview > 0
          ? `다시 찾았어요. ${result.needsReview}건은 확인이 필요해요.`
          : `다시 찾았어요. 새 후보 ${result.created}건.`,
      );
    },
    onError: () =>
      toast.error("다시 찾지 못했어요. 잠시 후 다시 시도해 주세요."),
  });

  const data = seriesQuery.data;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <PageBackHeader title="정기 지출" backHref="/more" />

      {seriesQuery.isPending ? (
        <div className="text-muted-foreground flex items-center gap-2 px-1 text-[14px]">
          <Loader2 className="size-4 animate-spin" />
          불러오는 중…
        </div>
      ) : null}

      {seriesQuery.isError ? (
        <Card>
          <CardContent className="p-4 text-[14px]">
            정기 지출을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
          </CardContent>
        </Card>
      ) : null}

      {data && !data.enabled ? (
        // ⚠️ 빈 목록을 "정기 결제가 없다"로 읽히게 두지 않는다 — 그건 없는 사실이다.
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <span className="text-[15px] font-medium">아직 준비 중이에요</span>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              정기 지출 찾기는 아직 켜지 않았어요. 금액 계산 방식을 정리하는 작업이
              끝나면 열립니다 — 그 전에 보여드리면 틀린 금액을 사실처럼 말하게 돼요.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {data?.enabled ? (
        <>
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              최근 6개월에서 반복으로 보이는 결제예요. 맞는지 알려 주시면 다음부터
              그대로 기억할게요.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={recompute.isPending}
              onClick={() => recompute.mutate()}
            >
              {recompute.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              다시 찾기
            </Button>
          </div>

          {data.items.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
                <Repeat className="text-muted-foreground size-8" />
                <span className="text-[15px] font-medium">
                  아직 찾은 정기 결제가 없어요
                </span>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  같은 가맹점에서 서로 다른 달에 3번 이상 결제돼야 후보로 올라와요.
                  가맹점 이름이 여러 개로 나뉘어 있다면{" "}
                  <Link href="/more/merchants" className="underline">
                    가맹점 정리
                  </Link>
                  에서 묶은 뒤 다시 찾아 보세요.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {data.items.map((item) => (
                <SeriesRow
                  key={item.id}
                  item={item}
                  busy={decide.isPending}
                  onDecide={(decision) =>
                    decide.mutate({ id: item.id, decision })
                  }
                />
              ))}
            </div>
          )}

          {data.provisional ? (
            // 미확정 금액 위에 서 있다는 사실을 화면이 숨기지 않는다.
            <p className="text-muted-foreground px-1 text-[12px] leading-relaxed">
              금액은 지금까지 관측한 결제 그대로예요. 다음 결제 예정일과 이번 달 정기
              지출 합계는 금액 계산 방식 정리가 끝난 뒤에 보여드릴게요.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
