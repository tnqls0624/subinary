/** 승인된 production alias의 로컬 가맹점 분류 artifact를 검증·실행한다. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import {
  createDbAiInvocationObserver,
  schema,
  type Db,
} from '@family/database';
import { canonicalJson, sha256Hex } from '@family/rag';
import {
  assertMerchantClassifierModel,
  DEFAULT_MODEL_SERVING_ALIAS,
  MERCHANT_CLASSIFIER_TRAINER_VERSION,
  MODEL_SERVING_TASKS,
  predictMerchantCategory,
  type MerchantClassifierModel,
} from '@family/shared';

import { DB } from '../database/database.module';
import { ObjectStorageService } from '../storage/object-storage.service';

interface CachedModel {
  artifactHash: string;
  model: MerchantClassifierModel;
}

export interface LocalMerchantPrediction {
  categoryId: string;
  categorySlug: string;
  confidence: number;
  traceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

@Injectable()
export class LocalMerchantClassifierService {
  private readonly cache = new Map<string, CachedModel>();
  private readonly observer: ReturnType<typeof createDbAiInvocationObserver>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {
    this.observer = createDbAiInvocationObserver(db);
  }

  /** 로컬 production alias가 없으면 null, 있으면 검증된 예측과 trace를 반환한다. */
  async predict(
    householdId: string,
    merchantPattern: string,
    pipelineRunId: string,
  ): Promise<LocalMerchantPrediction | null> {
    const [serving] = await this.db
      .select({
        aliasId: schema.modelAliases.id,
        aliasRevision: schema.modelAliases.revision,
        modelRegistryId: schema.modelRegistry.id,
        modelName: schema.modelRegistry.model,
        artifactHash: schema.modelRegistry.artifactHash,
        artifactKey: schema.trainingRuns.artifactKey,
        trainingArtifactHash: schema.trainingRuns.artifactHash,
        datasetSnapshotId: schema.trainingRuns.datasetSnapshotId,
      })
      .from(schema.modelAliases)
      .innerJoin(
        schema.modelRegistry,
        eq(schema.modelAliases.modelRegistryId, schema.modelRegistry.id),
      )
      .innerJoin(
        schema.trainingRuns,
        eq(schema.trainingRuns.modelRegistryId, schema.modelRegistry.id),
      )
      .innerJoin(
        schema.datasetSnapshots,
        eq(
          schema.trainingRuns.datasetSnapshotId,
          schema.datasetSnapshots.id,
        ),
      )
      .where(
        and(
          eq(schema.modelAliases.householdId, householdId),
          eq(schema.modelAliases.task, MODEL_SERVING_TASKS.MERCHANT_CATEGORY),
          eq(schema.modelAliases.alias, DEFAULT_MODEL_SERVING_ALIAS),
          isNull(schema.modelAliases.suspendedAt),
          eq(schema.modelRegistry.provider, 'subinary-local'),
          eq(schema.modelRegistry.status, 'approved'),
          eq(schema.trainingRuns.status, 'succeeded'),
          isNull(schema.trainingRuns.artifactPurgedAt),
          eq(schema.datasetSnapshots.status, 'approved'),
        ),
      )
      .limit(1);
    if (!serving) {
      return null;
    }
    if (
      serving.artifactHash === null ||
      serving.artifactKey === null ||
      serving.trainingArtifactHash !== serving.artifactHash
    ) {
      throw new Error('local merchant model artifact metadata is incomplete');
    }

    const startedAt = new Date();
    const started = performance.now();
    const traceId = randomUUID();
    try {
      const model = await this.loadModel(
        serving.modelRegistryId,
        serving.artifactKey,
        serving.artifactHash,
        serving.datasetSnapshotId,
      );
      const prediction = predictMerchantCategory(model, merchantPattern);
      const finishedAt = new Date();
      await this.observer.record({
        traceId,
        pipelineRunId,
        modelAliasId: serving.aliasId,
        modelAliasRevision: serving.aliasRevision,
        modelRegistryId: serving.modelRegistryId,
        trafficPolicyId: null,
        trafficMode: null,
        trafficRole: null,
        trafficBucket: null,
        trafficSelected: null,
        task: MODEL_SERVING_TASKS.MERCHANT_CATEGORY,
        operation: 'classification',
        provider: 'subinary-local',
        model: serving.modelName,
        promptVersion: MERCHANT_CLASSIFIER_TRAINER_VERSION,
        inputFingerprint: sha256Hex(
          canonicalJson([householdId, merchantPattern]),
        ),
        inputCount: 1,
        inputTokens: null,
        outputTokens: null,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        outcome: 'succeeded',
        errorCode: null,
        startedAt,
        finishedAt,
      });
      return { ...prediction, traceId };
    } catch (error: unknown) {
      const finishedAt = new Date();
      try {
        await this.observer.record({
          traceId,
          pipelineRunId,
          modelAliasId: serving.aliasId,
          modelAliasRevision: serving.aliasRevision,
          modelRegistryId: serving.modelRegistryId,
          trafficPolicyId: null,
          trafficMode: null,
          trafficRole: null,
          trafficBucket: null,
          trafficSelected: null,
          task: MODEL_SERVING_TASKS.MERCHANT_CATEGORY,
          operation: 'classification',
          provider: 'subinary-local',
          model: serving.modelName,
          promptVersion: MERCHANT_CLASSIFIER_TRAINER_VERSION,
          inputFingerprint: sha256Hex(
            canonicalJson([householdId, merchantPattern]),
          ),
          inputCount: 1,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          outcome: 'failed',
          errorCode: error instanceof Error ? error.name : 'UnknownError',
          startedAt,
          finishedAt,
        });
      } catch {
        // 원래 artifact/추론 오류를 보존한다.
      }
      throw error;
    }
  }

  private async loadModel(
    modelRegistryId: string,
    artifactKey: string,
    expectedHash: string,
    datasetSnapshotId: string,
  ): Promise<MerchantClassifierModel> {
    const cached = this.cache.get(modelRegistryId);
    if (cached?.artifactHash === expectedHash) {
      return cached.model;
    }
    const bytes = await this.storage.getObject(artifactKey);
    if (sha256Hex(bytes) !== expectedHash) {
      throw new Error('local merchant model checksum mismatch');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('local merchant model JSON is invalid');
    }
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 'merchant-model-artifact-v1' ||
      parsed.task !== 'merchant-category' ||
      !isRecord(parsed.dataset) ||
      parsed.dataset.snapshotId !== datasetSnapshotId ||
      !isRecord(parsed.trainer) ||
      parsed.trainer.version !== MERCHANT_CLASSIFIER_TRAINER_VERSION
    ) {
      throw new Error('local merchant model metadata is invalid');
    }
    assertMerchantClassifierModel(parsed.model);
    const model = parsed.model;
    this.cache.set(modelRegistryId, { artifactHash: expectedHash, model });
    return model;
  }
}
