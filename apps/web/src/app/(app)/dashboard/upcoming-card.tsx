"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 홈 "앞으로 나갈 돈" (금액 레이어 S2)
 *
 * 히어로가 "이번 달 얼마 썼나"를 말한다. 이 카드는 그 다음 질문에 답한다 —
 * **"앞으로 얼마 더 나가나."**
 *
 * ## 절제가 이 카드의 품질이다 (기획 D6)
 *
 * 이번 달 예상 = **이미 쓴 것(확정) + 남은 정기(관측된 반복)**. 그게 전부다.
 * 변동 지출은 예측하지 않는다 — 평균 기반 추정은 틀리고, 틀린 숫자가 홈 히어로 옆에
 * 붙으면 앱 전체 신뢰가 깎인다.
 *
 * 이중 계상은 구조적으로 막힌다: `nextExpectedAt`은 `lastSeenAt + interval`이라
 * 이번 달에 이미 결제된 series는 예상일이 다음 달로 넘어가 조회 창(이번 달 말)을
 * 벗어난다. 그래서 "이미 쓴 것"과 "남은 정기"가 같은 결제를 두 번 세지 않는다.
 *
 * ## 언제 사라지는가
 *
 * 세 경우에 **아무것도 그리지 않는다**(기존 빈 상태 규칙):
 *  1. 정기 지출 Radar가 꺼져 있다
 *  2. 예정이 0건이다 — 빈 카드가 "정기 결제 없음"으로 읽히면 그건 없는 사실이다
 *  3. 과거 달을 보고 있다 — 지난 달에 "앞으로 나갈 돈"은 뜻이 없다
 *
 * ## 빠진 것을 말한다
 *
 * 합계는 **금액을 예고할 수 있는 것만** 담는다(기획 D2). 근거에 v1 거래가 섞인
 * series와 외화는 빠지고, 빠진 건수를 문구로 말한다 — 빠진 걸 숨긴 합계는
 * "이만큼만 나간다"는 거짓말이 된다.
 * ------------------------------------------------------------------------- */
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import type { RecurringUpcomingResponse } from "@family/contracts";

import { Card, CardContent } from "@/components/ui/card";
import { Money } from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import {
  endOfMonthKst,
  fetchRecurringUpcoming,
  recurringUpcomingQueryKey,
} from "@/lib/recurring-api";

export function UpcomingSpendCard({
  isCurrentMonth,
  monthlyNet,
}: {
  /** 과거 달을 보고 있으면 렌더하지 않는다. */
  isCurrentMonth: boolean;
  /**
   * 이번 달 이미 쓴 순액(ADR-0026 지출 합계). `null`이면 아직 모르는 것이므로
   * 예상 총액을 만들지 않는다 — 반쪽 합계를 "이번 달 예상"이라고 부르면 안 된다.
   */
  monthlyNet: number | null;
}) {
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();

  // 창은 한 번만 계산한다. 매 렌더 새 값을 만들면 queryKey가 달라져 요청이 늘어난다.
  const until = useMemo(() => endOfMonthKst(), []);

  const query = useQuery<RecurringUpcomingResponse>({
    queryKey: recurringUpcomingQueryKey(householdId, until),
    enabled: householdId != null && isCurrentMonth,
    queryFn: () =>
      authedFetch((token) =>
        fetchRecurringUpcoming(token, householdId as string, until),
      ),
  });

  const data = query.data;

  // 로딩·에러에도 아무것도 그리지 않는다. 이 카드는 보조 정보이고, 홈에서 실패
  // 문구가 하나 더 늘어나는 것보다 조용히 없는 편이 낫다(히어로는 자기 상태를 말한다).
  if (!isCurrentMonth || !data?.enabled || data.items.length === 0) return null;

  const overdue = data.items.filter(
    (i) => i.nextExpectedPhase === "overdue",
  ).length;
  const hasAmount = data.forecastableCount > 0;
  // 예상 총액은 **양쪽을 다 알 때만** 만든다.
  const projected =
    hasAmount && monthlyNet !== null ? monthlyNet + data.totalAmount : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <CalendarClock className="size-4" />
              앞으로 나갈 돈
            </span>
            {hasAmount ? (
              <span className="text-2xl font-bold tracking-tight tabular-nums">
                <Money
                  amount={data.totalAmount}
                  currency={data.totalCurrency}
                />
              </span>
            ) : (
              <span className="text-[15px] font-medium">
                금액을 아직 말할 수 없어요
              </span>
            )}
            <p className="text-muted-foreground text-sm">
              {hasAmount
                ? `정기 결제 ${data.forecastableCount}건이 이번 달에 남았어요`
                : `정기 결제 ${data.items.length}건이 이번 달에 남았어요`}
              {overdue > 0 ? ` · ${overdue}건은 예정일이 지났어요` : ""}
            </p>
          </div>
        </div>

        {/*
         * 이번 달 예상 총액 — 기획 D6. "이미 쓴 것 + 남은 정기"이며 변동 지출은
         * 여기 없다. 그 사실을 문구로 밝혀야 사용자가 이 숫자를 과신하지 않는다.
         */}
        {projected !== null ? (
          <div className="bg-muted flex flex-col gap-0.5 rounded-lg p-3">
            <span className="text-muted-foreground text-xs">
              이번 달 예상 총액
            </span>
            <span className="text-lg font-semibold tabular-nums">
              <Money amount={projected} currency={data.totalCurrency} />
            </span>
            <span className="text-muted-foreground text-xs leading-relaxed">
              이미 쓴 돈 + 남은 정기 결제예요. 그 밖의 지출은 예상하지 않아요.
            </span>
          </div>
        ) : null}

        {/* 빠진 것. 두 사유는 사용자가 할 수 있는 일이 달라서 따로 말한다. */}
        {data.excludedCount > 0 || data.otherCurrencyCount > 0 ? (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {data.excludedCount > 0
              ? `${data.excludedCount}건은 과거 거래 기준이 아직 정리되지 않아 금액을 세지 않았어요. `
              : ""}
            {data.otherCurrencyCount > 0
              ? `${data.otherCurrencyCount}건은 원화가 아니라 합계에 넣지 않았어요.`
              : ""}
          </p>
        ) : null}

        <Link
          href="/more/recurring"
          className="text-primary text-sm underline-offset-2 hover:underline"
        >
          정기 지출 전체 보기
        </Link>
      </CardContent>
    </Card>
  );
}
