/**
 * AI/데이터 파이프라인 제어 평면 저장 헬퍼(ADR-0017 P0).
 *
 * 외부 AI 패키지에 의존하지 않고 구조적 타입으로 observer 경계를 제공해
 * database 패키지의 하위 계층성을 유지한다.
 */
import { and, eq } from 'drizzle-orm';

import type { Db } from './client.js';
import {
  aiInvocations,
  operationalAlerts,
  pipelineRuns,
  pipelineStepRuns,
} from './schema.js';

/** AI Provider observer가 DB에 기록할 수 있는 원문 없는 이벤트 형태. */
export interface AiInvocationTelemetry {
  traceId: string;
  pipelineRunId: string | null;
  modelAliasId: string | null;
  modelAliasRevision: number | null;
  modelRegistryId: string | null;
  trafficPolicyId: string | null;
  trafficMode: 'shadow' | 'live' | null;
  trafficRole: 'primary' | 'candidate' | null;
  trafficBucket: number | null;
  trafficSelected: boolean | null;
  task: string;
  operation: 'llm_generate' | 'embedding' | 'rerank' | 'classification';
  provider: string;
  model: string;
  promptVersion: string | null;
  inputFingerprint: string;
  inputCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  outcome: 'succeeded' | 'failed';
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date;
}

/** 구조적 타입으로 `AiInvocationObserver`와 호환되는 DB observer. */
export function createDbAiInvocationObserver(db: Db): {
  record(event: AiInvocationTelemetry): Promise<void>;
} {
  return {
    async record(event: AiInvocationTelemetry): Promise<void> {
      await db.insert(aiInvocations).values({
        id: event.traceId,
        pipelineRunId: event.pipelineRunId,
        modelAliasId: event.modelAliasId,
        modelAliasRevision: event.modelAliasRevision,
        modelRegistryId: event.modelRegistryId,
        trafficPolicyId: event.trafficPolicyId,
        trafficMode: event.trafficMode,
        trafficRole: event.trafficRole,
        trafficBucket: event.trafficBucket,
        trafficSelected: event.trafficSelected,
        task: event.task,
        operation: event.operation,
        provider: event.provider,
        model: event.model,
        promptVersion: event.promptVersion,
        inputFingerprint: event.inputFingerprint,
        inputCount: event.inputCount,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        durationMs: event.durationMs,
        outcome: event.outcome,
        errorCode: event.errorCode,
        startedAt: event.startedAt,
        finishedAt: event.finishedAt,
      });
    },
  };
}

/** pipeline/step 성공 시 저장할 원문 없는 count/metric 집계. */
export interface PipelineExecutionSummary {
  inputCount?: number;
  outputCount?: number;
  rejectedCount?: number;
  metrics?: Record<string, unknown>;
}

/** 단일 BullMQ/API 실행을 pipeline run + 하나의 step으로 기록하는 옵션. */
export interface TrackPipelineExecutionOptions<T> {
  pipelineName: string;
  pipelineVersion: string;
  stepName: string;
  stepVersion: string;
  trigger: 'api' | 'bullmq' | 'scheduled' | 'backfill' | 'system';
  scopeType?: string;
  scopeId?: string;
  externalRunId?: string;
  attempt?: number;
  /** BullMQ 전체 시도 횟수. 마지막 실패에만 외부 운영 알림을 만든다. */
  maximumAttempts?: number;
  codeSha?: string;
  configHash?: string;
  summarize?: (result: T) => PipelineExecutionSummary;
}

/** 작업 내부에서 AI trace와 연결할 pipeline run id. */
export interface PipelineExecutionContext {
  pipelineRunId: string;
}

/** 오류 메시지 대신 class/name만 보존한다. */
function sanitizedErrorCode(error: unknown): string {
  return error instanceof Error && error.name.length > 0
    ? error.name
    : 'UnknownError';
}

/**
 * 실행 시작/종료를 pipeline_runs와 pipeline_step_runs에 원자적으로 기록한다.
 * 시작 기록 실패 시 작업을 실행하지 않는다. 작업 실패 기록이 실패하더라도 원래
 * 오류를 보존해 BullMQ 재시도 판단을 오염시키지 않는다.
 */
export async function trackPipelineExecution<T>(
  db: Db,
  options: TrackPipelineExecutionOptions<T>,
  execute: (context: PipelineExecutionContext) => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  const attempt = options.attempt ?? 1;
  const maximumAttempts = options.maximumAttempts ?? 1;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < attempt) {
    throw new Error('maximumAttempts must be an integer greater than or equal to attempt');
  }

  const run = await db.transaction(async (tx) => {
    const [createdRun] = await tx
      .insert(pipelineRuns)
      .values({
        pipelineName: options.pipelineName,
        pipelineVersion: options.pipelineVersion,
        scopeType: options.scopeType,
        scopeId: options.scopeId,
        trigger: options.trigger,
        externalRunId: options.externalRunId,
        codeSha: options.codeSha,
        configHash: options.configHash,
        status: 'running',
        startedAt,
      })
      .returning({ id: pipelineRuns.id });

    if (!createdRun) {
      throw new Error('pipeline run insert returned no row');
    }
    await tx.insert(pipelineStepRuns).values({
      pipelineRunId: createdRun.id,
      stepName: options.stepName,
      stepVersion: options.stepVersion,
      attempt,
      status: 'running',
      startedAt,
    });
    return createdRun;
  });

  try {
    const result = await execute({ pipelineRunId: run.id });
    const finishedAt = new Date();
    const summary = options.summarize?.(result) ?? {};
    await db.transaction(async (tx) => {
      await tx
        .update(pipelineStepRuns)
        .set({
          status: 'succeeded',
          inputCount: summary.inputCount,
          outputCount: summary.outputCount,
          rejectedCount: summary.rejectedCount,
          metrics: summary.metrics ?? {},
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(
          and(
            eq(pipelineStepRuns.pipelineRunId, run.id),
            eq(pipelineStepRuns.stepName, options.stepName),
            eq(pipelineStepRuns.attempt, attempt),
          ),
        );
      await tx
        .update(pipelineRuns)
        .set({
          status: 'succeeded',
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(eq(pipelineRuns.id, run.id));
    });
    return result;
  } catch (error: unknown) {
    const finishedAt = new Date();
    const errorCode = sanitizedErrorCode(error);
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(pipelineStepRuns)
          .set({
            status: 'failed',
            errorCode,
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(
            and(
              eq(pipelineStepRuns.pipelineRunId, run.id),
              eq(pipelineStepRuns.stepName, options.stepName),
              eq(pipelineStepRuns.attempt, attempt),
            ),
          );
        await tx
          .update(pipelineRuns)
          .set({
            status: 'failed',
            errorCode,
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(eq(pipelineRuns.id, run.id));
        if (attempt >= maximumAttempts) {
          await tx
            .insert(operationalAlerts)
            .values({
              dedupeKey: `pipeline-run:${run.id}`,
              kind: 'pipeline_failed',
              severity: 'critical',
              sourceType: 'pipeline_run',
              sourceId: run.id,
              summary: `${options.pipelineName} pipeline failed`,
              details: {
                pipelineName: options.pipelineName,
                pipelineVersion: options.pipelineVersion,
                stepName: options.stepName,
                stepVersion: options.stepVersion,
                trigger: options.trigger,
                attempt,
                errorCode,
              },
              occurredAt: finishedAt,
            })
            .onConflictDoNothing({ target: operationalAlerts.dedupeKey });
        }
      });
    } catch {
      // 원래 작업 오류를 보존한다. DB 관측 오류 메시지도 로그하지 않는다.
    }
    throw error;
  }
}
