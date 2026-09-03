"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 정기 지출 Radar (/more/recurring) — C-5 **최소 제품**
 *
 * 이 화면이 하는 일은 둘뿐이다.
 *   1. 반복으로 보이는 결제 후보를 보여준다
 *   2. 사용자가 "정기 결제 맞음 / 아님"을 확정한다
 *
 * ✅ **2026-08-18 추가 — 날짜 레이어**: 확정된 series에 다음 결제 예상일을 붙였다.
 * 예상일은 `last_seen_at`·`interval_days`의 순수 함수라 금액 계약과 무관하다
 * (`@family/shared`의 `forecastRecurring`). 월 주기는 일(day-of-month)을 앵커로 쓰고,
 * 창(±N일)과 함께 말한다 — 카드 결제일은 주말·영업일로 밀리므로 단일 날짜는 반드시 틀린다.
 *
 * ✅ **2026-09-03 추가 — 금액 레이어(S1)**: 상단에 "이번 달 남은 정기" 합계를 둔다.
 * ADR-0027이 8단계까지 끝나(전량 v2 + 제약 VALIDATE) `net_amount`가 확정됐기 때문이다.
 *
 * 합계는 **예고할 수 있는 것만** 담는다. 근거에 v1이 하나라도 섞인 series는 금액을
 * 예고하지 않고(기획 D2), 외화는 환산하지 않는다 — 환산은 금액 계약의 일이고 예고는
 * 관측만 말한다. 빠진 건수를 문구로 함께 말한다: 빠진 걸 숨긴 합계는 "이만큼만
 * 나간다"는 거짓말이 된다.
 *
 * ⛔ **여전히 없는 것**: 예정 알림 발송(S3) · 해지 종료 처리(S4) · 카드 교체 CTA(폐기).
 * 앞의 둘은 오탐이 확정처럼 전달되거나 사용자 모르게 상태가 바뀌는 문제라 별도
 * 슬라이스다(`docs/concept-upcoming-spend-2026-08.md` §4).
 *
 * 금액은 예측하지 않는다 — 관측된 중앙값을 그대로 말한다("최근 3회 13,500원").
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
import { useMemo } from "react";
import { toast } from "sonner";

import type {
  CardSmsDeclineReason,
  RecurringSeriesItem,
  RecurringSeriesListResponse,
  RecurringUpcomingResponse,
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
  endOfMonthKst,
  fetchRecurringSeries,
  fetchRecurringUpcoming,
  recomputeRecurringSeries,
  recurringQueryKey,
  recurringUpcomingQueryKey,
} from "@/lib/recurring-api";

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

/**
 * 다음 결제 예상을 사람 말로. **금액은 넣지 않는다** — 날짜만 확정적으로 말할 수 있다.
 *
 * 창(±N일)을 문구에 넣는 이유: "8월 24일"이라고 못 박으면 하루만 밀려도 틀린 예고가 된다.
 * "쯤"과 폭을 함께 말하면 밀림이 예고의 실패가 아니라 예고의 일부가 된다.
 */
function forecastText(item: RecurringSeriesItem): string | null {
  if (!item.nextExpectedAt || item.nextExpectedPhase === null) return null;
  const when = formatDate(item.nextExpectedAt);
  const pm =
    item.nextExpectedWindowDays && item.nextExpectedWindowDays > 0
      ? ` (±${item.nextExpectedWindowDays}일)`
      : "";
  switch (item.nextExpectedPhase) {
    case "due":
      return `${when}쯤 결제 예정이에요${pm}`;
    case "overdue":
      return item.stoppedCandidate
        ? `${when}쯤 나갈 차례였는데 ${item.overdueDays}일째 안 들어왔어요`
        : `${when}쯤 예정이었어요 · 아직 안 들어왔어요`;
    default:
      return `다음 ${when}쯤${pm}`;
  }
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
  onDecide: (
    decision: "confirmed" | "rejected" | "ended" | "still_active",
  ) => void;
}) {
  const review = needsReviewText(item);
  const forecast = forecastText(item);
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
            {forecast ? (
              <span
                className={
                  item.nextExpectedPhase === "overdue"
                    ? "text-warning-strong text-[13px]"
                    : "text-[13px] font-medium"
                }
              >
                {forecast}
              </span>
            ) : null}
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
          {item.status === "ended" ? (
            // 해지는 실패가 아니다 — 사용자가 정리를 끝낸 상태라 중립 톤을 쓴다.
            <StatusBadge status={item.status} tone="neutral" label="해지함" />
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
            className="flex items-center gap-1.5 text-warning-strong text-[13px]"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="truncate">
              {declineHint ??
                `최근 ${item.recentDeclineAttempts}번 결제에 실패했어요`}
            </span>
          </Link>
        ) : null}

        {/*
         * 해지 확인 (금액 레이어 S4, 기획 D4 "묻는다, 끄지 않는다").
         *
         * 일반 판정 버튼과 **분리한다.** "정기 결제 맞아요/아니에요"는 후보 판정이고
         * 이건 사실 확인이다 — 한 줄에 네 버튼을 놓으면 사용자가 무엇을 답하는지
         * 흐려진다.
         *
         * 답을 받을 때까지 이 series는 예상 총액에 **그대로 남는다.** 시스템이 미리
         * 빼면 사용자 모르게 총액이 줄어든다(D4).
         */}
        {item.stoppedCandidate ? (
          <div className="border-warning/40 flex flex-col gap-2 rounded-lg border p-3">
            <span className="text-[14px] font-medium">해지하셨나요?</span>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              나갈 차례가 {item.overdueDays}일 지났는데 결제가 안 들어왔어요. 아직
              쓰고 계시면 그대로 두고 셀게요.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={busy}
                onClick={() => onDecide("ended")}
              >
                해지했어요
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={busy}
                onClick={() => onDecide("still_active")}
              >
                계속 써요
              </Button>
            </div>
          </div>
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

/**
 * 이번 달 남은 정기 합계 (금액 레이어 S1).
 *
 * 세 가지를 정직하게 말한다.
 *  1. 합계에 **들어간** 건수와 금액
 *  2. 금액을 예고할 수 없어 **빠진** 건수 (근거에 v1이 섞인 series — 기획 D2)
 *  3. 통화가 달라 **합산하지 않은** 건수 (환산은 금액 계약의 일이다)
 *
 * 2·3을 숨기면 합계가 "이만큼만 나간다"는 거짓말이 된다. 그래서 0이 아닐 때만,
 * 그러나 반드시 말한다.
 *
 * 예정이 0건이면 아무것도 그리지 않는다 — 빈 카드가 "정기 결제가 없다"로 읽히면
 * 그건 없는 사실이다(이 화면의 다른 빈 상태와 같은 규칙).
 */
function UpcomingSummary({ data }: { data: RecurringUpcomingResponse }) {
  if (data.items.length === 0) return null;

  const overdue = data.items.filter(
    (i) => i.nextExpectedPhase === "overdue",
  ).length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[15px] font-medium">이번 달 남은 정기</span>
          {data.forecastableCount > 0 ? (
            <span className="text-[17px] font-semibold tabular-nums">
              <Money amount={data.totalAmount} currency={data.totalCurrency} />
            </span>
          ) : null}
        </div>

        <p className="text-muted-foreground text-[13px] leading-relaxed">
          {data.forecastableCount > 0
            ? `${data.forecastableCount}건이 나갈 예정이에요.`
            : "예정된 금액을 아직 말할 수 없어요."}
          {overdue > 0 ? ` ${overdue}건은 예정일이 지났어요.` : ""}
        </p>

        {/*
         * 빠진 것을 말하는 문단. 두 사유를 따로 쓰는 이유: 사용자가 취할 조치가
         * 다르다 — 앞은 기다리면 풀리고(재계산), 뒤는 영구적이다(외화).
         */}
        {data.excludedCount > 0 || data.otherCurrencyCount > 0 ? (
          <p className="text-muted-foreground bg-muted rounded-lg p-3 text-[12px] leading-relaxed">
            {data.excludedCount > 0
              ? `${data.excludedCount}건은 과거 거래 기준이 아직 정리되지 않아 금액을 세지 않았어요. `
              : ""}
            {data.otherCurrencyCount > 0
              ? `${data.otherCurrencyCount}건은 원화가 아니라 합계에 넣지 않았어요.`
              : ""}
          </p>
        ) : null}
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

  // 창은 화면이 정한다("이번 달"). 한 번 계산해 두고 렌더마다 바꾸지 않는다 —
  // 매 렌더 새 값을 만들면 queryKey가 달라져 요청이 무한히 늘어난다.
  const until = useMemo(() => endOfMonthKst(), []);

  const upcomingQuery = useQuery<RecurringUpcomingResponse>({
    queryKey: recurringUpcomingQueryKey(householdId, until),
    enabled: householdId != null && seriesQuery.data?.enabled === true,
    queryFn: () =>
      authedFetch((token) =>
        fetchRecurringUpcoming(token, householdId as string, until),
      ),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: recurringQueryKey(householdId) });
    // 확정·재계산은 예정 목록도 바꾼다 — 한쪽만 갱신하면 합계가 목록과 어긋난다.
    queryClient.invalidateQueries({ queryKey: ["recurring-upcoming"] });
  };

  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
    }: {
      id: string;
      decision: "confirmed" | "rejected" | "ended" | "still_active";
    }) => authedFetch((token) => decideRecurringSeries(token, id, decision)),
    onSuccess: async (_, variables) => {
      await invalidate();
      // 네 답이 서로 다른 일을 한다 — 토스트도 그 차이를 말해야 사용자가 무엇이
      // 바뀌었는지 안다. 특히 `still_active`는 **아무 상태도 바꾸지 않는다.**
      const message: Record<typeof variables.decision, string> = {
        confirmed: "정기 결제로 표시했어요.",
        rejected: "정기 결제가 아닌 것으로 표시했어요.",
        ended: "해지한 것으로 표시했어요. 이번 달 예상에서 빠져요.",
        still_active: "계속 쓰는 것으로 알겠어요. 예상 금액은 그대로예요.",
      };
      toast.success(message[variables.decision]);
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
          {/*
           * 합계를 목록 **위**에 둔다 — 사용자가 이 화면에 오는 이유는 "얼마 나가지?"이고,
           * 개별 확정은 그 답을 얻은 뒤의 작업이다. 예정 0건이면 컴포넌트가 스스로
           * 사라진다(빈 카드를 "정기 결제 없음"으로 읽히게 두지 않는다).
           */}
          {upcomingQuery.data ? (
            <UpcomingSummary data={upcomingQuery.data} />
          ) : null}

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
