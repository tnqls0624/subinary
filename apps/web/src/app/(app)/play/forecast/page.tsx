"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 이번 달 예측 맞히기 (/play/forecast)
 *
 * **첫 번째 "상태를 가진" 미니앱.** 앞선 셋(페이스·도감·리듬)은 읽기 전용이라 볼 수만
 * 있었다. 여기서는 사용자가 숫자를 정하고, 그것이 저장되고, 다음에 열면 이어진다 —
 * 토스가 게임 미니앱의 최소 조건으로 요구하는 "재접속 시 복구"가 그것이다.
 *
 * ## 원칙을 우회하지 않고 뒤집는다
 *
 * 이 저장소는 "예측하지 않는다"를 강하게 지켜 왔다. 그래서 지출 예상 기능은 전부
 * 기각됐다 — 시스템이 만든 추정은 근거를 화면에 함께 띄울 수 없다.
 *
 * 이 게임은 **예측을 사람이 한다.** 시스템이 하는 일은 저장과 비교뿐이고 둘 다
 * 사실이다. 게임적 긴장도 여기서 나온다 — 내가 적은 숫자가 있으면 남은 날의 지출이
 * 다르게 읽힌다. 보상이 없어도 성립하는 이유다.
 *
 * ## 판정하지 않는다
 *
 * "잘 맞혔어요"·"많이 썼어요"를 쓰지 않는다. 차이와 오차율은 사실이지만 그것이 좋은지
 * 나쁜지는 이 화면이 답할 수 없다 — 병원비를 낸 달의 초과는 실패가 아니다.
 *
 * 진행 중인 달과 끝난 달을 구분하는 것도 같은 이유다. 월중에 "예상보다 적게 썼다"고
 * 말하면 그건 적게 쓴 것이 아니라 **달이 안 끝난 것**이다.
 * ------------------------------------------------------------------------- */
import { Target } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Money, PageBackHeader } from "@/components/widgets";
import { ApiError } from "@/lib/api-client";
import { currentMonth, formatWon } from "@/lib/format";
import {
  FORECAST_APP_KEY,
  compareForecast,
  isMonthClosed,
  isValidForecastAmount,
  parseForecastState,
} from "@/lib/forecast";
import { monthRange } from "@/lib/month";
import {
  useDeletePlayState,
  usePlayStates,
  useSavePlayState,
  useSpendSummary,
} from "@/lib/queries";

export default function ForecastPage() {
  const month = currentMonth();
  const range = useMemo(() => monthRange(month), [month]);

  const statesQuery = usePlayStates(FORECAST_APP_KEY);
  const summaryQuery = useSpendSummary(range);
  const saveState = useSavePlayState(FORECAST_APP_KEY);
  const deleteState = useDeletePlayState(FORECAST_APP_KEY);

  const [input, setInput] = useState("");

  const current = useMemo(() => {
    const row = statesQuery.data?.items.find((i) => i.stateKey === month);
    return parseForecastState(row?.state ?? null);
  }, [statesQuery.data, month]);

  /** 지난 달들의 기록 — 최근 순. 진행 중인 달은 여기 넣지 않는다. */
  const past = useMemo(() => {
    const now = new Date();
    return (statesQuery.data?.items ?? [])
      .filter((i) => i.stateKey !== month && isMonthClosed(i.stateKey, now))
      .map((i) => ({ monthKey: i.stateKey, state: parseForecastState(i.state) }))
      .filter((x): x is { monthKey: string; state: NonNullable<typeof x.state> } =>
        x.state !== null,
      )
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  }, [statesQuery.data, month]);

  const actualNet = summaryQuery.data?.totalNet ?? 0;
  const loading = statesQuery.isLoading || summaryQuery.isLoading;

  const submit = () => {
    const amount = Number(input.replace(/[^0-9]/g, ""));
    if (!isValidForecastAmount(amount)) {
      toast.error("1원 이상의 금액을 적어 주세요");
      return;
    }
    saveState.mutate(
      {
        stateKey: month,
        state: { amount, decidedAt: new Date().toISOString() },
      },
      {
        onSuccess: () => {
          setInput("");
          toast.success(`${formatWon(amount)}로 적었어요`);
        },
        onError: (error) =>
          toast.error(
            error instanceof ApiError ? error.message : "저장하지 못했어요",
          ),
      },
    );
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PageBackHeader
        title="이번 달 예측"
        subtitle="얼마 쓸지 먼저 적어 두고 실제와 견줘요"
      />

      {loading ? (
        <Skeleton className="h-48 w-full rounded-2xl" />
      ) : current === null ? (
        <Card>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-2">
              <Target className="text-primary mt-0.5 size-5 shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  {month.slice(5)}월에 얼마 쓸 것 같나요?
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                  지금까지 {formatWon(actualNet)} 썼어요. 적어 두면 남은 날 동안
                  얼마나 가까워지는지 볼 수 있어요.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                inputMode="numeric"
                placeholder="예상 금액"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <Button
                onClick={submit}
                disabled={saveState.isPending || input.trim() === ""}
              >
                {saveState.isPending ? "저장 중…" : "적기"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <ForecastProgress
          monthKey={month}
          forecast={current.amount}
          actual={actualNet}
          onReset={() =>
            deleteState.mutate(month, {
              onSuccess: () => toast.success("예측을 지웠어요"),
              onError: () => toast.error("지우지 못했어요"),
            })
          }
          resetting={deleteState.isPending}
        />
      )}

      {past.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-muted-foreground px-1 text-[13px] font-semibold">
            지난 기록
          </h2>
          <Card className="divide-border divide-y overflow-hidden p-0">
            {past.map((row) => (
              <PastRow
                key={row.monthKey}
                monthKey={row.monthKey}
                forecast={row.state.amount}
              />
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}

/** 진행 중인 달 — **결과가 아니라 경과**다. */
function ForecastProgress({
  monthKey,
  forecast,
  actual,
  onReset,
  resetting,
}: {
  monthKey: string;
  forecast: number;
  actual: number;
  onReset: () => void;
  resetting: boolean;
}) {
  const { diff, progress } = compareForecast(forecast, actual);
  const percent = Math.min(100, Math.max(2, Math.round(progress * 100)));
  const over = diff > 0;

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">
            {monthKey.slice(5)}월 예측 {formatWon(forecast)}
          </span>
          <span className="text-muted-foreground text-xs">
            지금 {formatWon(actual)}
          </span>
        </div>

        <div className="bg-muted h-9 w-full overflow-hidden rounded-lg">
          <div
            className={`h-full rounded-lg ${over ? "bg-warning" : "bg-primary/80"}`}
            style={{ width: `${percent}%` }}
          />
        </div>

        {/* 사실만 적는다. 달이 안 끝났으므로 "적게 썼다"고 말하지 않는다 —
            그건 아직 쓸 날이 남았다는 뜻일 뿐이다. */}
        <p className="text-sm">
          {over ? (
            <>
              예측보다{" "}
              <span className="font-semibold">
                <Money amount={diff} />
              </span>{" "}
              더 썼어요
            </>
          ) : (
            <>
              예측까지{" "}
              <span className="font-semibold">
                <Money amount={-diff} />
              </span>{" "}
              남았어요
            </>
          )}
          <span className="text-muted-foreground"> · 달이 끝나면 결과가 정해져요</span>
        </p>

        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-8 px-2 text-xs"
          onClick={onReset}
          disabled={resetting}
        >
          다시 적기
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * 끝난 달 한 줄.
 *
 * 실제 지출을 **월마다 따로 조회한다**(`useSpendSummary`). 목록에서 한 번에 받아오지
 * 않는 이유: 합계의 정의는 ADR-0026이 소유하고 그 API가 기간 하나를 받는다. 여기서
 * 여러 달을 합쳐 계산하면 같은 달 숫자가 화면마다 갈린다.
 */
function PastRow({
  monthKey,
  forecast,
}: {
  monthKey: string;
  forecast: number;
}) {
  const range = useMemo(() => monthRange(monthKey), [monthKey]);
  const { data, isLoading } = useSpendSummary(range);
  const actual = data?.totalNet ?? 0;
  const { diff, errorRate } = compareForecast(forecast, actual);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {monthKey.slice(0, 4)}년 {monthKey.slice(5)}월
        </span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          예측 {formatWon(forecast)}
          {isLoading ? "" : ` · 실제 ${formatWon(actual)}`}
        </span>
      </span>
      {isLoading ? (
        <Skeleton className="h-4 w-16" />
      ) : (
        <span className="shrink-0 text-right">
          <span className="block text-sm font-semibold tabular-nums">
            {diff > 0 ? "+" : diff < 0 ? "−" : ""}
            {formatWon(Math.abs(diff))}
          </span>
          {errorRate !== null ? (
            <span className="text-muted-foreground block text-xs tabular-nums">
              {Math.round(errorRate * 100)}% 차이
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}
