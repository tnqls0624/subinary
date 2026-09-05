"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 이번 달 페이스 (/play/pace)
 *
 * 이번 달과 지난달을 **같은 날짜까지** 잘라 나란히 놓는다.
 *
 * ## 이 화면이 하지 않는 것
 *
 * 판정하지 않는다. "잘하고 있어요"·"평소보다 많아요"를 쓰지 않는다. 두 숫자는 둘 다
 * 관측된 사실이고, 나란히 놓는 것까지가 이 화면의 일이다. 해석은 사람이 한다.
 *
 * '평소'를 정의하는 순간 그 기준을 지어내야 하고, 지어낸 기준은 근거를 화면에 함께
 * 띄울 수 없다. 대신 **기간·건수·합계를 전부 보여준다** — 사용자가 직접 판단할 수
 * 있는 재료를 주는 것이 판정을 대신하는 방식이다.
 *
 * ## 합계를 직접 세지 않는다
 *
 * `GET /v1/transactions/summary`를 쓴다. 지출 합계의 정의(취소 상계·제외 거래·
 * 공개범위)는 ADR-0026이 하나로 정했고, 화면이 자기 방식으로 다시 세면 같은 달의
 * 숫자가 화면마다 갈린다. 그때 사용자가 잃는 것은 기능이 아니라 숫자에 대한 신뢰다.
 * ------------------------------------------------------------------------- */
import { useMemo } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Money, PageBackHeader } from "@/components/widgets";
import { transactionsHref } from "@/lib/deep-link";
import { currentPacePair, paceDelta, type PaceRange } from "@/lib/pace";
import { useSpendSummary } from "@/lib/queries";
import Link from "next/link";

/** 막대 길이 계산용 — 둘 중 큰 값을 100%로 둔다. */
function widthPercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(2, Math.round((value / max) * 100));
}

export default function PacePage() {
  // `now`를 한 번만 읽는다. 렌더마다 새로 만들면 자정을 넘길 때 두 쿼리의 기준이
  // 갈려 "이번 달 6일 vs 지난달 5일"이 될 수 있다.
  const { current, previous } = useMemo(
    () => currentPacePair(new Date()),
    [],
  );

  const currentQuery = useSpendSummary({ from: current.from, to: current.to });
  const previousQuery = useSpendSummary({
    from: previous.from,
    to: previous.to,
  });

  const loading = currentQuery.isLoading || previousQuery.isLoading;
  const failed = currentQuery.isError || previousQuery.isError;
  const currentNet = currentQuery.data?.totalNet ?? 0;
  const previousNet = previousQuery.data?.totalNet ?? 0;
  const max = Math.max(currentNet, previousNet);
  const { diff, ratio } = paceDelta(currentNet, previousNet);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PageBackHeader
        title="이번 달 페이스"
        subtitle={`${current.month.slice(5)}월 ${current.throughDay}일까지를 지난달 같은 날과 견줘요`}
      />

      {failed ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            지출을 불러오지 못했어요
          </p>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-5">
            {loading ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
              </div>
            ) : (
              <>
                <PaceBar
                  label="이번 달"
                  range={current}
                  net={currentNet}
                  count={currentQuery.data?.count ?? 0}
                  percent={widthPercent(currentNet, max)}
                  emphasis
                />
                <PaceBar
                  label="지난달 같은 기간"
                  range={previous}
                  net={previousNet}
                  count={previousQuery.data?.count ?? 0}
                  percent={widthPercent(previousNet, max)}
                />

                {/* 차이는 **사실만** 적는다. 좋다/나쁘다를 붙이지 않는다 —
                    병원비를 낸 달이 '나쁜 달'이 되는 순간 이 화면은 거짓말을 한다. */}
                <div className="border-t pt-4">
                  <p className="text-sm">
                    지난달 같은 기간보다{" "}
                    <span className="font-semibold tabular-nums">
                      <Money amount={Math.abs(diff)} />
                    </span>{" "}
                    {diff === 0 ? "차이가 없어요" : diff > 0 ? "많아요" : "적어요"}
                    {ratio !== null && diff !== 0
                      ? ` (${Math.abs(Math.round(ratio * 100))}%)`
                      : ""}
                  </p>
                  {previous.truncated ? (
                    // 3/31의 지난달은 2/28까지다. 이 사실을 숨기면 사용자는 같은
                    // 길이의 기간을 비교하고 있다고 믿는다.
                    <p className="text-muted-foreground mt-1 text-xs">
                      지난달은 {previous.throughDay}일까지만 있어 비교 기간이 조금
                      짧아요
                    </p>
                  ) : null}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-muted-foreground px-1 text-xs">
        합계는 거래 화면과 같은 기준으로 계산해요(취소 상계·제외한 거래 반영).
      </p>
    </div>
  );
}

/** 한 구간의 막대 + 숫자. 기간과 건수를 함께 보여 판단 재료를 남긴다. */
function PaceBar({
  label,
  range,
  net,
  count,
  percent,
  emphasis,
}: {
  label: string;
  range: PaceRange;
  net: number;
  count: number;
  percent: number;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <Link
          href={transactionsHref({ month: range.month })}
          className="text-muted-foreground text-xs underline-offset-2 hover:underline"
        >
          {range.month.slice(5)}월 1~{range.throughDay}일 · {count}건
        </Link>
      </div>
      <div className="bg-muted h-9 w-full overflow-hidden rounded-lg">
        <div
          className={`flex h-full items-center justify-end rounded-lg px-2.5 ${
            emphasis ? "bg-primary/80" : "bg-muted-foreground/30"
          }`}
          style={{ width: `${percent}%` }}
        >
          <span
            className={`text-xs font-semibold tabular-nums whitespace-nowrap ${
              emphasis ? "text-primary-foreground" : "text-foreground"
            }`}
          >
            <Money amount={net} />
          </span>
        </div>
      </div>
    </div>
  );
}
