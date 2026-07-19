import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';
import { LearningModelService } from './learning-model.service';

/** 한 번의 canary monitor poll 결과. */
export interface LearningCanaryMonitorSummary {
  scanned: number;
  monitoring: number;
  passed: number;
  rolledBack: number;
  suspended: number;
  failed: number;
}

const EMPTY_SUMMARY: LearningCanaryMonitorSummary = {
  scanned: 0,
  monitoring: 0,
  passed: 0,
  rolledBack: 0,
  suspended: 0,
  failed: 0,
};

/**
 * monitoring canary를 주기적으로 판정하는 API 제어 평면 monitor.
 * 다중 API instance가 같은 run을 보더라도 alias advisory lock과 판정 결과의
 * 멱등 응답이 중복 rollback을 막는다.
 */
@Injectable()
export class LearningCanaryMonitorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(LearningCanaryMonitorService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private evaluating = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly modelService: LearningModelService,
    configService: ConfigService,
  ) {
    const ai = configService.get<AppConfig['ai']>('ai');
    this.enabled = ai?.modelCanaryMonitorEnabled ?? false;
    this.intervalMs = ai?.modelCanaryMonitorIntervalMs ?? 30_000;
    this.batchSize = ai?.modelCanaryMonitorBatchSize ?? 50;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.evaluatePending().catch((error: unknown) => {
        this.logger.error(
          `scheduled canary poll failed: ${this.errorCode(error)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref();
    void this.evaluatePending().catch((error: unknown) => {
      this.logger.error(
        `initial canary poll failed: ${this.errorCode(error)}`,
      );
    });
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 현재 monitoring 상태인 canary batch를 오래된 관측 창부터 평가한다. */
  async evaluatePending(): Promise<LearningCanaryMonitorSummary> {
    if (this.evaluating) {
      return { ...EMPTY_SUMMARY };
    }
    this.evaluating = true;
    try {
      const rows = await this.db
        .select({
          modelAliasId: schema.modelAliases.id,
          workspaceId: schema.modelAliases.workspaceId,
          householdId: schema.modelAliases.householdId,
          task: schema.modelAliases.task,
          alias: schema.modelAliases.alias,
          revision: schema.modelCanaryRuns.aliasRevision,
          createdBy: schema.modelCanaryRuns.createdBy,
        })
        .from(schema.modelCanaryRuns)
        .innerJoin(
          schema.modelAliases,
          eq(schema.modelCanaryRuns.modelAliasId, schema.modelAliases.id),
        )
        .where(
          and(
            eq(schema.modelCanaryRuns.status, 'monitoring'),
            isNull(schema.modelAliases.suspendedAt),
          ),
        )
        .orderBy(
          asc(schema.modelCanaryRuns.windowEndsAt),
          asc(schema.modelCanaryRuns.createdAt),
        )
        .limit(this.batchSize);

      const summary: LearningCanaryMonitorSummary = {
        ...EMPTY_SUMMARY,
        scanned: rows.length,
      };
      for (const row of rows) {
        try {
          const hasWorkspace = row.workspaceId !== null;
          const hasHousehold = row.householdId !== null;
          if (Number(hasWorkspace) + Number(hasHousehold) !== 1) {
            throw new Error('model canary scope is invalid');
          }
          const scope = hasWorkspace
            ? { workspaceId: row.workspaceId ?? undefined }
            : { householdId: row.householdId ?? undefined };
          const result = await this.modelService.evaluateCanaryScheduled(
            row.createdBy,
            row.alias,
            {
              ...scope,
              task: row.task,
              expectedRevision: row.revision,
            },
          );
          switch (result.status) {
            case 'monitoring':
              summary.monitoring += 1;
              break;
            case 'passed':
              summary.passed += 1;
              break;
            case 'rolled_back':
              summary.rolledBack += 1;
              break;
            case 'suspended':
              summary.suspended += 1;
              break;
          }
        } catch (error: unknown) {
          summary.failed += 1;
          this.logger.error(
            `scheduled canary evaluation failed alias=${row.modelAliasId} ` +
              `revision=${row.revision} errorCode=${this.errorCode(error)}`,
          );
        }
      }
      if (summary.scanned > 0) {
        this.logger.log(
          `scheduled canary batch scanned=${summary.scanned} ` +
            `monitoring=${summary.monitoring} passed=${summary.passed} ` +
            `rolledBack=${summary.rolledBack} suspended=${summary.suspended} ` +
            `failed=${summary.failed}`,
        );
      }
      return summary;
    } finally {
      this.evaluating = false;
    }
  }

  private errorCode(error: unknown): string {
    return error instanceof Error && error.name.length > 0
      ? error.name
      : 'UnknownError';
  }
}
