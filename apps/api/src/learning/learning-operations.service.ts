import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';

import type { AppConfig } from '@family/config';
import type {
  LearningOperationsMetricsQuery,
  LearningOperationsMetricsResponse,
  LearningQueueMetric,
} from '@family/contracts';
import { schema, type Db } from '@family/database';
import {
  calculatePendingAgeSeconds,
  calculateRateBasisPoints,
  QUEUE_NAMES,
  summarizeOperationalQueues,
} from '@family/shared';

import { DB } from '../database/database.constants';

const OPERATIONAL_QUEUE_NAMES = [
  QUEUE_NAMES.CARD_SMS_PARSE,
  QUEUE_NAMES.SLACK_IMPORT,
  QUEUE_NAMES.RAG_INDEX,
  QUEUE_NAMES.SOURCE_TOMBSTONE,
  QUEUE_NAMES.MEMORY_EXTRACT,
  QUEUE_NAMES.GRAPH_EXTRACT,
  QUEUE_NAMES.CATEGORY_SUGGEST,
] as const;

/** owner/admin에게 원문 없는 파이프라인 운영 집계를 제공한다. */
@Injectable()
export class LearningOperationsService implements OnModuleDestroy {
  private readonly logger = new Logger(LearningOperationsService.name);
  private readonly queues: ReadonlyArray<Queue>;

  constructor(
    @Inject(DB) private readonly db: Db,
    configService: ConfigService,
  ) {
    const redis = configService.get<AppConfig['redis']>('redis');
    const queue = configService.get<AppConfig['queue']>('queue');
    if (!redis || !queue) {
      throw new Error('Redis/queue configuration is missing');
    }
    this.queues = OPERATIONAL_QUEUE_NAMES.map(
      (name) =>
        new Queue(name, {
          connection: { host: redis.host, port: redis.port },
          prefix: queue.prefix,
        }),
    );
  }

  /** 큐 연결을 API 종료 시 명시적으로 정리한다. */
  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.queues.map((queue) => queue.close()));
  }

  /** household 범위 집계와 서버 전체 큐·경보 집계를 조회한다. */
  async getMetrics(
    userId: string,
    query: LearningOperationsMetricsQuery,
  ): Promise<LearningOperationsMetricsResponse> {
    await this.assertHouseholdOperator(userId, query.householdId);

    const generatedAt = new Date();
    const windowStartedAt = new Date(
      generatedAt.getTime() - query.windowHours * 60 * 60 * 1_000,
    );
    const windowStartedAtIso = windowStartedAt.toISOString();
    const pipelineScope = and(
      eq(schema.pipelineRuns.scopeType, 'household'),
      eq(schema.pipelineRuns.scopeId, query.householdId),
      gte(schema.pipelineRuns.startedAt, windowStartedAt),
    );

    const [
      queueItems,
      pipelineRows,
      aiRows,
      outboxRows,
      qualityRows,
      datasetRows,
      evaluationRows,
      trainingRows,
      alertRows,
    ] = await Promise.all([
      this.readQueues(generatedAt.getTime()),
      this.db
        .select({
          total: count(),
          succeeded: sql<number>`count(*) filter (where ${schema.pipelineRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${schema.pipelineRuns.status} in ('failed', 'quarantined'))::int`,
          running: sql<number>`count(*) filter (where ${schema.pipelineRuns.status} in ('queued', 'running'))::int`,
          p95DurationMs: sql<number>`coalesce(ceil(percentile_cont(0.95) within group (order by extract(epoch from (${schema.pipelineRuns.finishedAt} - ${schema.pipelineRuns.startedAt})) * 1000) filter (where ${schema.pipelineRuns.finishedAt} is not null)), 0)::int`,
        })
        .from(schema.pipelineRuns)
        .where(pipelineScope),
      this.db
        .select({
          invocations: count(schema.aiInvocations.id),
          failed: sql<number>`count(*) filter (where ${schema.aiInvocations.outcome} = 'failed')::int`,
          p95DurationMs: sql<number>`coalesce(ceil(percentile_cont(0.95) within group (order by ${schema.aiInvocations.durationMs})), 0)::int`,
          inputTokens: sql<number>`coalesce(sum(${schema.aiInvocations.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${schema.aiInvocations.outputTokens}), 0)::int`,
          meteredInvocations: sql<number>`count(*) filter (where ${schema.aiInvocations.inputTokens} is not null and ${schema.aiInvocations.outputTokens} is not null)::int`,
        })
        .from(schema.aiInvocations)
        .innerJoin(
          schema.pipelineRuns,
          eq(schema.aiInvocations.pipelineRunId, schema.pipelineRuns.id),
        )
        .where(pipelineScope),
      this.db
        .select({
          pending: sql<number>`count(*) filter (where ${schema.dataEvents.publishedAt} is null and ${schema.dataEvents.quarantinedAt} is null)::int`,
          quarantinedInWindow: sql<number>`count(*) filter (where ${schema.dataEvents.quarantinedAt} >= cast(${windowStartedAtIso} as timestamptz))::int`,
          publishedInWindow: sql<number>`count(*) filter (where ${schema.dataEvents.publishedAt} >= cast(${windowStartedAtIso} as timestamptz))::int`,
          oldestPendingAgeSeconds: sql<number | null>`greatest(0, floor(extract(epoch from (now() - min(${schema.dataEvents.createdAt}) filter (where ${schema.dataEvents.publishedAt} is null and ${schema.dataEvents.quarantinedAt} is null)))))::int`,
        })
        .from(schema.dataEvents)
        .where(eq(schema.dataEvents.householdId, query.householdId)),
      this.db
        .select({
          humanConfirmedLabels: sql<number>`count(distinct ${schema.feedbackEvents.targetId}) filter (where ${schema.feedbackEvents.targetType} = 'merchant-category' and ${schema.feedbackEvents.source} = 'human_confirmed')::int`,
          distinctLabelClasses: sql<number>`count(distinct (${schema.feedbackEvents.label} ->> 'categoryId')) filter (where ${schema.feedbackEvents.targetType} = 'merchant-category' and ${schema.feedbackEvents.source} = 'human_confirmed')::int`,
        })
        .from(schema.feedbackEvents)
        .where(eq(schema.feedbackEvents.householdId, query.householdId)),
      this.db
        .select({
          approvedDatasets: sql<number>`count(*) filter (where ${schema.datasetSnapshots.status} = 'approved')::int`,
          revokedDatasets: sql<number>`count(*) filter (where ${schema.datasetSnapshots.status} = 'revoked')::int`,
        })
        .from(schema.datasetSnapshots)
        .where(eq(schema.datasetSnapshots.householdId, query.householdId)),
      this.db
        .select({
          evaluationsPassed: sql<number>`count(*) filter (where ${schema.evaluationRuns.status} = 'succeeded' and ${schema.evaluationRuns.gateResult} = 'passed')::int`,
          evaluationsFailed: sql<number>`count(*) filter (where ${schema.evaluationRuns.status} = 'succeeded' and ${schema.evaluationRuns.gateResult} = 'failed')::int`,
        })
        .from(schema.evaluationRuns)
        .innerJoin(
          schema.datasetSnapshots,
          eq(
            schema.evaluationRuns.datasetSnapshotId,
            schema.datasetSnapshots.id,
          ),
        )
        .where(eq(schema.datasetSnapshots.householdId, query.householdId)),
      this.db
        .select({
          trainingQueued: sql<number>`count(*) filter (where ${schema.trainingRuns.status} = 'queued')::int`,
          trainingRunning: sql<number>`count(*) filter (where ${schema.trainingRuns.status} = 'running')::int`,
          trainingSucceeded: sql<number>`count(*) filter (where ${schema.trainingRuns.status} = 'succeeded')::int`,
          trainingFailedOrBlocked: sql<number>`count(*) filter (where ${schema.trainingRuns.status} in ('failed', 'blocked'))::int`,
          trainingRevoked: sql<number>`count(*) filter (where ${schema.trainingRuns.status} = 'revoked')::int`,
        })
        .from(schema.trainingRuns)
        .innerJoin(
          schema.datasetSnapshots,
          eq(
            schema.trainingRuns.datasetSnapshotId,
            schema.datasetSnapshots.id,
          ),
        )
        .where(eq(schema.datasetSnapshots.householdId, query.householdId)),
      this.db
        .select({
          pending: sql<number>`count(*) filter (where ${schema.operationalAlerts.status} = 'pending')::int`,
          failed: sql<number>`count(*) filter (where ${schema.operationalAlerts.status} = 'failed')::int`,
          deliveredInWindow: sql<number>`count(*) filter (where ${schema.operationalAlerts.status} = 'delivered' and ${schema.operationalAlerts.deliveredAt} >= cast(${windowStartedAtIso} as timestamptz))::int`,
          oldestPendingAgeSeconds: sql<number | null>`greatest(0, floor(extract(epoch from (now() - min(${schema.operationalAlerts.createdAt}) filter (where ${schema.operationalAlerts.status} = 'pending')))))::int`,
        })
        .from(schema.operationalAlerts),
    ]);

    const pipeline = pipelineRows[0] ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      running: 0,
      p95DurationMs: 0,
    };
    const ai = aiRows[0] ?? {
      invocations: 0,
      failed: 0,
      p95DurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      meteredInvocations: 0,
    };
    const outbox = outboxRows[0] ?? {
      pending: 0,
      quarantinedInWindow: 0,
      publishedInWindow: 0,
      oldestPendingAgeSeconds: null,
    };
    const quality = qualityRows[0] ?? {
      humanConfirmedLabels: 0,
      distinctLabelClasses: 0,
    };
    const datasets = datasetRows[0] ?? {
      approvedDatasets: 0,
      revokedDatasets: 0,
    };
    const evaluations = evaluationRows[0] ?? {
      evaluationsPassed: 0,
      evaluationsFailed: 0,
    };
    const training = trainingRows[0] ?? {
      trainingQueued: 0,
      trainingRunning: 0,
      trainingSucceeded: 0,
      trainingFailedOrBlocked: 0,
      trainingRevoked: 0,
    };
    const alerts = alertRows[0] ?? {
      pending: 0,
      failed: 0,
      deliveredInWindow: 0,
      oldestPendingAgeSeconds: null,
    };
    const queueSummary = summarizeOperationalQueues(queueItems);

    return {
      generatedAt: generatedAt.toISOString(),
      window: {
        hours: query.windowHours,
        startedAt: windowStartedAt.toISOString(),
      },
      queues: {
        scope: 'server',
        items: queueItems,
        ...queueSummary,
        unavailableQueues: queueItems.filter((item) => !item.available).length,
      },
      outbox,
      pipelines: {
        ...pipeline,
        failureRateBasisPoints: calculateRateBasisPoints(
          pipeline.failed,
          pipeline.total,
        ),
      },
      ai: {
        ...ai,
        errorRateBasisPoints: calculateRateBasisPoints(
          ai.failed,
          ai.invocations,
        ),
      },
      quality: { ...quality, ...datasets, ...evaluations, ...training },
      alerts: { scope: 'server', ...alerts },
    };
  }

  private async readQueues(nowMs: number): Promise<LearningQueueMetric[]> {
    return Promise.all(
      this.queues.map(async (queue): Promise<LearningQueueMetric> => {
        try {
          const [counts, pendingJobs] = await Promise.all([
            queue.getJobCounts(
              'waiting',
              'prioritized',
              'waiting-children',
              'active',
              'delayed',
              'failed',
            ),
            queue.getJobs(
              ['waiting', 'prioritized', 'waiting-children', 'delayed'],
              0,
              0,
              true,
            ),
          ]);
          const oldestTimestamp = pendingJobs[0]?.timestamp ?? null;
          return {
            name: queue.name,
            available: true,
            waiting:
              (counts.waiting ?? 0) +
              (counts.prioritized ?? 0) +
              (counts['waiting-children'] ?? 0),
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            oldestPendingAgeSeconds: calculatePendingAgeSeconds(
              oldestTimestamp,
              nowMs,
            ),
          };
        } catch (error: unknown) {
          const errorCode =
            error instanceof Error ? error.name : 'UnknownQueueMetricsError';
          this.logger.warn(
            `queue metrics unavailable queue=${queue.name} errorCode=${errorCode}`,
          );
          return {
            name: queue.name,
            available: false,
            waiting: 0,
            active: 0,
            delayed: 0,
            failed: 0,
            oldestPendingAgeSeconds: null,
          };
        }
      }),
    );
  }

  private async assertHouseholdOperator(
    userId: string,
    householdId: string,
  ): Promise<void> {
    const [member] = await this.db
      .select({ role: schema.householdMembers.role })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
          inArray(schema.householdMembers.role, ['owner', 'admin']),
        ),
      )
      .limit(1);
    if (!member) {
      throw new ForbiddenException('household owner or admin required');
    }
  }
}
