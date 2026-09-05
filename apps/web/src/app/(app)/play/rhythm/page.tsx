"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 주간 리듬 (/play/rhythm)
 *
 * 언제 쓰는지를 요일로 본다. **금액이 아니라 횟수**를 센다 — 지출 합계의 정의는
 * ADR-0026이 소유하고, 이 화면이 거래를 받아 다시 더하면 같은 달의 숫자가 화면마다
 * 갈린다. 횟수는 그 계약 밖이라 안전하고, 리듬은 원래 횟수의 이야기다.
 *
 * ## 판정하지 않는다
 *
 * "금요일에 조심하세요"를 쓰지 않는다. 장을 몰아서 보는 사람의 토요일과 매일
 * 편의점에 가는 사람의 평일은 같은 숫자라도 다른 이야기다. 많은 요일이 나쁜 요일이라는
 * 판단은 이 화면의 것이 아니다.
 *
 * ## 추적 대상을 고르게 하지 않는 이유(지금은)
 *
 * 원래 설계는 "사용자가 습관을 고르면 연속 일수를 센다"였다. 그러려면 선택을 저장할
 * 곳이 필요한데, 실측을 보니 **데이터가 이미 습관을 말하고 있었다** — 벤디스 18회가
 * 전부 평일이다(월2 화3 수4 목6 금3, 주말 0). 그래서 발견만 먼저 내보내고, 이 화면이
 * 실제로 쓰이는 것이 확인되면 그때 "고정하기"를 붙인다. 쓰이지 않을 저장소를 미리
 * 만들지 않는다.
 * ------------------------------------------------------------------------- */
import { useMemo } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBackHeader } from "@/components/widgets";
import { currentMonth } from "@/lib/format";
import { monthRange } from "@/lib/month";
import { useTransactions } from "@/lib/queries";
import { merchantRhythms, weekdayBuckets } from "@/lib/rhythm";

/**
 * 목록 API의 최대 limit. 이번 달 거래가 이보다 많으면 **뒷부분을 못 센다** —
 * 그 사실을 숨기지 않고 화면에 적는다(실측 최대 월 181건).
 */
const SCAN_LIMIT = 100;

export default function RhythmPage() {
  const month = currentMonth();
  const range = useMemo(() => monthRange(month), [month]);
  const { data, isLoading, isError } = useTransactions({
    ...range,
    limit: SCAN_LIMIT,
  });

  const rows = useMemo(() => data?.items ?? [], [data]);
  const buckets = useMemo(() => weekdayBuckets(rows), [rows]);
  const rhythms = useMemo(() => merchantRhythms(rows), [rows]);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const capped = rows.length >= SCAN_LIMIT;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PageBackHeader
        title="주간 리듬"
        subtitle={`${month.slice(5)}월에 무슨 요일에 결제했는지 봐요`}
      />

      {isError ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            거래를 불러오지 못했어요
          </p>
        </Card>
      ) : isLoading ? (
        <Skeleton className="h-56 w-full rounded-2xl" />
      ) : total === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-medium">이번 달 결제가 아직 없어요</p>
          <p className="text-muted-foreground mt-1 text-sm">
            카드 문자가 쌓이면 요일 리듬이 보여요
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent>
              <div className="flex items-end justify-between gap-2">
                {buckets.map((b) => (
                  <div
                    key={b.weekday}
                    className="flex flex-1 flex-col items-center gap-1.5"
                  >
                    <span className="text-xs font-semibold tabular-nums">
                      {b.count}
                    </span>
                    <div
                      className={`w-full rounded-t-md ${
                        b.count === 0 ? "bg-muted" : "bg-primary/70"
                      }`}
                      // 0도 관측 결과다 — 막대를 없애지 않고 바닥 높이로 남긴다.
                      style={{
                        height: `${Math.max(4, Math.round((b.count / max) * 96))}px`,
                      }}
                    />
                    <span
                      className={`text-xs ${
                        b.weekday === 0 || b.weekday === 6
                          ? "text-muted-foreground"
                          : ""
                      }`}
                    >
                      {b.label}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground mt-4 text-xs">
                {month.slice(5)}월 결제 {total}건
                {capped
                  ? ` (최근 ${SCAN_LIMIT}건까지만 셌어요 — 이번 달 거래가 더 있어요)`
                  : ""}
              </p>
            </CardContent>
          </Card>

          {rhythms.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-muted-foreground px-1 text-[13px] font-semibold">
                자주 가는 곳의 요일
              </h2>
              <Card className="divide-border divide-y overflow-hidden p-0">
                {rhythms.slice(0, 6).map((r) => (
                  <div key={r.merchant} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium">
                        {r.merchant}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {r.total}번
                        {/* 사실만 적는다: 주말에 0건이었다는 관측. */}
                        {r.weekdayOnly ? " · 주말엔 없어요" : ""}
                      </span>
                    </div>
                    <div className="mt-2 flex gap-1">
                      {r.byWeekday.map((n, i) => (
                        <span
                          key={i}
                          title={`${["일", "월", "화", "수", "목", "금", "토"][i]} ${n}번`}
                          className={`h-5 flex-1 rounded ${
                            n === 0 ? "bg-muted" : "bg-primary/70"
                          }`}
                          style={n === 0 ? undefined : { opacity: 0.4 + Math.min(0.6, n / 8) }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
