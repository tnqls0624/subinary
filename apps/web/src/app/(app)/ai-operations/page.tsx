"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bot,
  Database,
  Gauge,
  Loader2,
  ShieldCheck,
} from "lucide-react";

import type { LearningOperationsMetricsResponse } from "@family/contracts";

import { Badge } from "@/components/ui/badge";
import { PageBackHeader } from "@/components/widgets";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";

const WINDOW_HOURS = 24;

function formatAge(seconds: number | null): string {
  if (seconds === null) return "대기 없음";
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}분`;
  return `${Math.floor(seconds / 3_600)}시간`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(1)}초`;
}

function formatRate(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/50 flex flex-col gap-1 rounded-lg px-3 py-2.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function Dashboard({ data }: { data: LearningOperationsMetricsResponse }) {
  const unhealthy =
    data.queues.unavailableQueues > 0 ||
    data.outbox.quarantinedInWindow > 0 ||
    data.alerts.failed > 0;
  const warning =
    data.queues.waiting + data.queues.delayed > 0 ||
    data.outbox.pending > 0 ||
    data.alerts.pending > 0 ||
    data.pipelines.failed > 0;

  return (
    <>
      <Card className="gap-3 p-4">
        <div className="flex items-center gap-3">
          <span
            className={`flex size-10 items-center justify-center rounded-full ${
              unhealthy
                ? "bg-destructive/10 text-destructive"
                : warning
                  ? "bg-warning/15 text-warning"
                  : "bg-success/15 text-success"
            }`}
          >
            {unhealthy || warning ? (
              <AlertTriangle className="size-5" />
            ) : (
              <ShieldCheck className="size-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              {unhealthy
                ? "확인이 필요한 항목이 있어요"
                : warning
                  ? "처리 중이거나 최근 실패가 있어요"
                  : "파이프라인이 정상이에요"}
            </div>
            <div className="text-muted-foreground text-xs">
              최근 {data.window.hours}시간 · 30초마다 자동 갱신
            </div>
          </div>
          <Badge variant={unhealthy ? "destructive" : warning ? "warning" : "success"}>
            {unhealthy ? "점검" : warning ? "주의" : "정상"}
          </Badge>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4" /> 큐와 지연
            </CardTitle>
            <CardDescription>서버 전체 BullMQ 현재 상태</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Metric label="대기" value={data.queues.waiting.toLocaleString()} />
            <Metric label="처리 중" value={data.queues.active.toLocaleString()} />
            <Metric label="지연" value={data.queues.delayed.toLocaleString()} />
            <Metric
              label="최장 대기"
              value={formatAge(data.queues.oldestPendingAgeSeconds)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="size-4" /> 실행 안정성
            </CardTitle>
            <CardDescription>선택한 가족 범위 파이프라인</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Metric label="실행" value={data.pipelines.total.toLocaleString()} />
            <Metric label="성공" value={data.pipelines.succeeded.toLocaleString()} />
            <Metric
              label="실패율"
              value={formatRate(data.pipelines.failureRateBasisPoints)}
            />
            <Metric label="p95 지연" value={formatDuration(data.pipelines.p95DurationMs)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4" /> AI 사용량
            </CardTitle>
            <CardDescription>토큰은 비용 추적용 프록시</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Metric label="호출" value={data.ai.invocations.toLocaleString()} />
            <Metric label="오류율" value={formatRate(data.ai.errorRateBasisPoints)} />
            <Metric label="입력 토큰" value={data.ai.inputTokens.toLocaleString()} />
            <Metric label="출력 토큰" value={data.ai.outputTokens.toLocaleString()} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="size-4" /> 학습 품질
            </CardTitle>
            <CardDescription>사람 라벨, 평가 gate, 학습 실행 상태</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Metric
              label="사람 라벨"
              value={data.quality.humanConfirmedLabels.toLocaleString()}
            />
            <Metric
              label="라벨 클래스"
              value={data.quality.distinctLabelClasses.toLocaleString()}
            />
            <Metric
              label="승인 데이터셋"
              value={data.quality.approvedDatasets.toLocaleString()}
            />
            <Metric
              label="평가 통과"
              value={data.quality.evaluationsPassed.toLocaleString()}
            />
            <Metric
              label="학습 성공"
              value={data.quality.trainingSucceeded.toLocaleString()}
            />
            <Metric
              label="학습 대기/실행"
              value={(
                data.quality.trainingQueued + data.quality.trainingRunning
              ).toLocaleString()}
            />
            <Metric
              label="학습 실패/차단"
              value={data.quality.trainingFailedOrBlocked.toLocaleString()}
            />
            <Metric
              label="학습 폐기"
              value={data.quality.trainingRevoked.toLocaleString()}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">전달 제어 평면</CardTitle>
          <CardDescription>가족 outbox와 서버 전체 운영 경보</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Outbox 대기" value={data.outbox.pending.toLocaleString()} />
          <Metric
            label="최근 격리"
            value={data.outbox.quarantinedInWindow.toLocaleString()}
          />
          <Metric label="경보 대기" value={data.alerts.pending.toLocaleString()} />
          <Metric label="경보 실패" value={data.alerts.failed.toLocaleString()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">큐 상세</CardTitle>
          <CardDescription>payload와 개별 job ID는 표시하지 않아요</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data.queues.items.map((queue) => (
            <div
              key={queue.name}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {queue.name}
              </span>
              {!queue.available ? (
                <Badge variant="destructive">연결 실패</Badge>
              ) : (
                <span className="text-muted-foreground text-xs tabular-nums">
                  대기 {queue.waiting} · 처리 {queue.active} · 실패 {queue.failed}
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

export default function AiOperationsPage() {
  const { authedFetch } = useAuth();
  const { householdId, activeMembership } = useHousehold();
  const canView =
    activeMembership?.role === "owner" || activeMembership?.role === "admin";
  const query = useQuery({
    queryKey: ["ai-pipeline-operations", householdId, WINDOW_HOURS],
    enabled: householdId !== null && canView,
    queryFn: () =>
      authedFetch((token) =>
        api.learning.operationsMetrics(token, {
          householdId: householdId as string,
          windowHours: WINDOW_HOURS,
        }),
      ),
    refetchInterval: 30_000,
  });

  if (!canView) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-5">
          <CardTitle>접근할 수 없어요</CardTitle>
          <CardDescription>가족 소유자 또는 관리자만 운영 지표를 볼 수 있어요.</CardDescription>
        </Card>
      </div>
    );
  }

  const errorMessage =
    query.error instanceof ApiError
      ? query.error.message
      : "운영 지표를 불러오지 못했어요.";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-4">
      <PageBackHeader
        title="AI 파이프라인 운영"
        subtitle="큐, 실행, 토큰, 데이터 품질을 원문 없이 확인해요."
      />

      {query.isLoading ? (
        <Card className="items-center p-8 text-sm">
          <Loader2 className="size-5 animate-spin" /> 운영 지표를 모으고 있어요…
        </Card>
      ) : query.isError ? (
        <Card className="border-destructive/40 p-5">
          <CardTitle className="text-destructive text-base">조회 실패</CardTitle>
          <CardDescription>{errorMessage}</CardDescription>
        </Card>
      ) : query.data ? (
        <Dashboard data={query.data} />
      ) : null}
    </div>
  );
}
