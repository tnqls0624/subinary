/** 별도 컨테이너에서 단일 training run을 실행하는 진입점. */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';

import { and, eq, sql } from 'drizzle-orm';

import {
  createDbClient,
  schema,
  trackPipelineExecution,
  type Db,
  type Sql,
} from '@family/database';
import { canonicalJson, sha256Hex } from '@family/rag';
import {
  evaluateMerchantClassifier,
  MERCHANT_CLASSIFIER_TRAINER_VERSION,
  MERCHANT_TRAINING_READINESS,
  trainMerchantClassifier,
  type MerchantClassifierMetrics,
  type MerchantClassifierModel,
  type MerchantClassifierTrainingRow,
} from '@family/shared';

const LOCAL_MODEL_PROVIDER = 'subinary-local';
const LOCAL_MODEL_NAME = 'merchant-char-ngram-nb';

interface TrainerConfig {
  trainingRunId: string;
  databaseUrl: string;
  storageEndpoint: string;
  storageRegion: string;
  storageAccessKey: string;
  storageSecretKey: string;
  storageBucket: string;
  storageForcePathStyle: boolean;
}

interface MerchantDatasetRow extends MerchantClassifierTrainingRow {
  feedbackEventId: string;
  targetType: 'merchant-category';
  targetId: string;
  merchantCategoryRuleId: string;
  labelSchemaVersion: string;
  source: 'human_confirmed';
  occurredAt: string;
  splitGroupHash: string;
}

interface DatasetManifest {
  task: 'merchant-category';
  version: string;
  schemaVersion: string;
  scope: { type: 'household'; id: string };
  artifact: { key: string; format: 'jsonl'; sha256: string };
  rowCount: number;
  splitPolicy: Record<string, unknown>;
  leakageAudit: Record<string, unknown>;
  labelSources: string[];
  consentScope: Record<string, unknown>;
}

interface TrainingEnvironment extends Record<string, unknown> {
  codeHash: string;
  dependencyLockHash: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
}

interface TrainingMetrics extends Record<string, unknown> {
  training: MerchantClassifierMetrics;
  validation: MerchantClassifierMetrics;
  test: MerchantClassifierMetrics;
}

interface MerchantModelArtifact {
  schemaVersion: 'merchant-model-artifact-v1';
  task: 'merchant-category';
  dataset: {
    snapshotId: string;
    version: string;
    artifactHash: string;
    manifestHash: string;
  };
  trainer: {
    version: string;
    codeHash: string;
    dependencyLockHash: string;
  };
  runtime: {
    nodeVersion: string;
    platform: string;
    architecture: string;
  };
  model: MerchantClassifierModel;
  metrics: TrainingMetrics;
}

interface TrainingResult {
  rowCount: number;
  classCount: number;
  artifactHash: string;
  modelRegistryId: string;
  metrics: TrainingMetrics;
}

class TrainingBlockedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TrainingBlockedError';
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function booleanEnvironment(name: string): boolean {
  const value = requiredEnvironment(name).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(value)) {
    return false;
  }
  throw new Error(`${name} must be a boolean`);
}

function loadConfig(): TrainerConfig {
  const trainingRunId = requiredEnvironment('TRAINING_RUN_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trainingRunId)) {
    throw new Error('TRAINING_RUN_ID must be a UUID');
  }
  return {
    trainingRunId,
    databaseUrl: requiredEnvironment('DATABASE_URL'),
    storageEndpoint: requiredEnvironment('STORAGE_ENDPOINT'),
    storageRegion: requiredEnvironment('STORAGE_REGION'),
    storageAccessKey: requiredEnvironment('STORAGE_ACCESS_KEY'),
    storageSecretKey: requiredEnvironment('STORAGE_SECRET_KEY'),
    storageBucket: requiredEnvironment('STORAGE_BUCKET'),
    storageForcePathStyle: booleanEnvironment('STORAGE_FORCE_PATH_STYLE'),
  };
}

function hashFiles(paths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    hash.update(path.split('/').pop() ?? path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(readFileSync(path));
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function dependencyLockPath(): string {
  const candidates = [
    resolve(process.cwd(), 'pnpm-lock.yaml'),
    '/app/pnpm-lock.yaml',
    resolve(__dirname, '../../../pnpm-lock.yaml'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error('pnpm-lock.yaml is unavailable');
  }
  return found;
}

function trainingEnvironment(): TrainingEnvironment {
  const sharedEntry = require.resolve('@family/shared');
  const codeHash = hashFiles([__filename, sharedEntry]);
  return {
    codeHash,
    dependencyLockHash: hashFiles([dependencyLockPath()]),
    nodeVersion: process.version,
    platform: platform(),
    architecture: arch(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordString(
  value: Record<string, unknown>,
  key: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new TrainingBlockedError(`invalid_${key}`);
  }
  return candidate;
}

function parseManifest(buffer: Buffer): DatasetManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new TrainingBlockedError('invalid_manifest_json');
  }
  if (!isRecord(parsed) || !isRecord(parsed.scope) || !isRecord(parsed.artifact)) {
    throw new TrainingBlockedError('invalid_manifest_shape');
  }
  const labelSources = parsed.labelSources;
  if (
    parsed.task !== 'merchant-category' ||
    parsed.scope.type !== 'household' ||
    parsed.artifact.format !== 'jsonl' ||
    typeof parsed.rowCount !== 'number' ||
    !Number.isInteger(parsed.rowCount) ||
    !isRecord(parsed.splitPolicy) ||
    !isRecord(parsed.leakageAudit) ||
    !Array.isArray(labelSources) ||
    !isRecord(parsed.consentScope)
  ) {
    throw new TrainingBlockedError('invalid_manifest_shape');
  }
  return {
    task: 'merchant-category',
    version: recordString(parsed, 'version'),
    schemaVersion: recordString(parsed, 'schemaVersion'),
    scope: {
      type: 'household',
      id: recordString(parsed.scope, 'id'),
    },
    artifact: {
      key: recordString(parsed.artifact, 'key'),
      format: 'jsonl',
      sha256: recordString(parsed.artifact, 'sha256'),
    },
    rowCount: parsed.rowCount,
    splitPolicy: parsed.splitPolicy,
    leakageAudit: parsed.leakageAudit,
    labelSources: labelSources.map((source) => {
      if (typeof source !== 'string') {
        throw new TrainingBlockedError('invalid_label_source');
      }
      return source;
    }),
    consentScope: parsed.consentScope,
  };
}

function parseDatasetRow(line: string): MerchantDatasetRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new TrainingBlockedError('invalid_dataset_jsonl');
  }
  if (!isRecord(parsed)) {
    throw new TrainingBlockedError('invalid_dataset_row');
  }
  const split = parsed.split;
  if (
    parsed.targetType !== 'merchant-category' ||
    parsed.source !== 'human_confirmed' ||
    (split !== 'train' && split !== 'validation' && split !== 'test')
  ) {
    throw new TrainingBlockedError('ineligible_dataset_row');
  }
  const occurredAt = recordString(parsed, 'occurredAt');
  if (!Number.isFinite(new Date(occurredAt).getTime())) {
    throw new TrainingBlockedError('invalid_occurred_at');
  }
  const splitGroupHash = recordString(parsed, 'splitGroupHash');
  if (!/^[a-f0-9]{64}$/.test(splitGroupHash)) {
    throw new TrainingBlockedError('invalid_split_group_hash');
  }
  return {
    feedbackEventId: recordString(parsed, 'feedbackEventId'),
    targetType: 'merchant-category',
    targetId: recordString(parsed, 'targetId'),
    merchantCategoryRuleId: recordString(parsed, 'merchantCategoryRuleId'),
    merchantPattern: recordString(parsed, 'merchantPattern'),
    categoryId: recordString(parsed, 'categoryId'),
    categorySlug: recordString(parsed, 'categorySlug'),
    labelSchemaVersion: recordString(parsed, 'labelSchemaVersion'),
    source: 'human_confirmed',
    occurredAt,
    splitGroupHash,
    split,
  };
}

function parseDataset(buffer: Buffer): MerchantDatasetRow[] {
  const text = buffer.toString('utf8');
  if (!text.endsWith('\n')) {
    throw new TrainingBlockedError('dataset_missing_final_newline');
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseDatasetRow);
}

function validateReadiness(
  rows: readonly MerchantDatasetRow[],
  manifest: DatasetManifest,
): number {
  const blockers: string[] = [];
  if (
    rows.length !== manifest.rowCount ||
    rows.length < MERCHANT_TRAINING_READINESS.minimumLabels
  ) {
    blockers.push('insufficient_or_mismatched_labels');
  }
  if (
    manifest.splitPolicy.strategy !== 'group_time' ||
    manifest.leakageAudit.status !== 'passed' ||
    manifest.labelSources.length !== 1 ||
    manifest.labelSources[0] !== 'human_confirmed' ||
    manifest.consentScope.mode !== 'household-only' ||
    manifest.consentScope.crossHousehold !== false
  ) {
    blockers.push('invalid_training_policy');
  }

  const countsByClass = new Map<string, number>();
  const slugByClass = new Map<string, string>();
  const trainClasses = new Set<string>();
  const splitCounts = { train: 0, validation: 0, test: 0 };
  const groupSplits = new Map<string, Set<string>>();
  const targetSplits = new Map<string, Set<string>>();
  const feedbackIds = new Set<string>();
  for (const row of rows) {
    if (feedbackIds.has(row.feedbackEventId)) {
      blockers.push('duplicate_feedback');
    }
    feedbackIds.add(row.feedbackEventId);
    const previousSlug = slugByClass.get(row.categoryId);
    if (previousSlug !== undefined && previousSlug !== row.categorySlug) {
      blockers.push('inconsistent_category_identity');
    }
    slugByClass.set(row.categoryId, row.categorySlug);
    countsByClass.set(
      row.categoryId,
      (countsByClass.get(row.categoryId) ?? 0) + 1,
    );
    splitCounts[row.split] += 1;
    if (row.split === 'train') {
      trainClasses.add(row.categoryId);
    }
    const group = groupSplits.get(row.splitGroupHash) ?? new Set<string>();
    group.add(row.split);
    groupSplits.set(row.splitGroupHash, group);
    const target = targetSplits.get(row.targetId) ?? new Set<string>();
    target.add(row.split);
    targetSplits.set(row.targetId, target);
  }
  if (countsByClass.size < MERCHANT_TRAINING_READINESS.minimumClasses) {
    blockers.push('insufficient_classes');
  }
  if (
    [...countsByClass.values()].some(
      (count) =>
        count < MERCHANT_TRAINING_READINESS.minimumLabelsPerClass,
    )
  ) {
    blockers.push('insufficient_labels_per_class');
  }
  if (trainClasses.size !== countsByClass.size) {
    blockers.push('training_split_missing_class');
  }
  if (
    splitCounts.train === 0 ||
    splitCounts.validation === 0 ||
    splitCounts.test === 0
  ) {
    blockers.push('empty_dataset_split');
  }
  if (
    [...groupSplits.values()].some((splits) => splits.size !== 1) ||
    [...targetSplits.values()].some((splits) => splits.size !== 1)
  ) {
    blockers.push('dataset_split_leakage');
  }
  if (blockers.length > 0) {
    throw new TrainingBlockedError([...new Set(blockers)].join('_'));
  }
  return countsByClass.size;
}

class TrainingRunner {
  constructor(
    private readonly config: TrainerConfig,
    private readonly db: Db,
    private readonly s3: S3Client,
  ) {}

  async run(): Promise<TrainingResult | null> {
    const context = await this.loadContext();
    if (context.run.status === 'succeeded') {
      return null;
    }
    if (context.run.status !== 'queued') {
      throw new Error(`training run is not executable: ${context.run.status}`);
    }
    const environment = trainingEnvironment();
    return trackPipelineExecution<TrainingResult>(
      this.db,
      {
        pipelineName: 'model-training',
        pipelineVersion: MERCHANT_CLASSIFIER_TRAINER_VERSION,
        stepName: 'verify-train-publish',
        stepVersion: MERCHANT_CLASSIFIER_TRAINER_VERSION,
        trigger: 'system',
        scopeType: 'household',
        scopeId: context.dataset.householdId ?? undefined,
        externalRunId: context.run.id,
        codeSha: environment.codeHash,
        configHash: environment.dependencyLockHash,
        summarize: (result) => ({
          inputCount: result.rowCount,
          outputCount: 1,
          rejectedCount: 0,
          metrics: {
            classCount: result.classCount,
            validationAccuracy: result.metrics.validation.accuracy,
            testAccuracy: result.metrics.test.accuracy,
          },
        }),
      },
      ({ pipelineRunId }) =>
        this.execute(context, environment, pipelineRunId),
    );
  }

  private async loadContext() {
    const [row] = await this.db
      .select({
        run: schema.trainingRuns,
        dataset: schema.datasetSnapshots,
      })
      .from(schema.trainingRuns)
      .innerJoin(
        schema.datasetSnapshots,
        eq(
          schema.trainingRuns.datasetSnapshotId,
          schema.datasetSnapshots.id,
        ),
      )
      .where(eq(schema.trainingRuns.id, this.config.trainingRunId))
      .limit(1);
    if (!row) {
      throw new Error('training run not found');
    }
    return row;
  }

  private async execute(
    initial: Awaited<ReturnType<TrainingRunner['loadContext']>>,
    environment: TrainingEnvironment,
    pipelineRunId: string,
  ): Promise<TrainingResult> {
    let claimed = false;
    let artifactKey: string | null = null;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`training-run:${initial.run.id}`}))`,
        );
        const [current] = await tx
          .select({
            runStatus: schema.trainingRuns.status,
            datasetStatus: schema.datasetSnapshots.status,
          })
          .from(schema.trainingRuns)
          .innerJoin(
            schema.datasetSnapshots,
            eq(
              schema.trainingRuns.datasetSnapshotId,
              schema.datasetSnapshots.id,
            ),
          )
          .where(eq(schema.trainingRuns.id, initial.run.id))
          .limit(1);
        if (!current || current.runStatus !== 'queued') {
          throw new TrainingBlockedError('training_run_not_queued');
        }
        if (current.datasetStatus !== 'approved') {
          throw new TrainingBlockedError('dataset_not_approved');
        }
        const [updated] = await tx
          .update(schema.trainingRuns)
          .set({
            status: 'running',
            pipelineRunId,
            startedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.trainingRuns.id, initial.run.id),
              eq(schema.trainingRuns.status, 'queued'),
            ),
          )
          .returning({ id: schema.trainingRuns.id });
        if (!updated) {
          throw new TrainingBlockedError('training_claim_conflict');
        }
        claimed = true;
      });

      const [datasetBytes, manifestBytes] = await Promise.all([
        this.getObject(initial.dataset.artifactKey),
        this.getObject(initial.dataset.manifestKey),
      ]);
      if (sha256Hex(datasetBytes) !== initial.dataset.artifactHash) {
        throw new TrainingBlockedError('dataset_checksum_mismatch');
      }
      if (sha256Hex(manifestBytes) !== initial.dataset.manifestHash) {
        throw new TrainingBlockedError('manifest_checksum_mismatch');
      }
      const manifest = parseManifest(manifestBytes);
      if (
        manifest.artifact.key !== initial.dataset.artifactKey ||
        manifest.artifact.sha256 !== initial.dataset.artifactHash ||
        manifest.version !== initial.dataset.version ||
        manifest.scope.id !== initial.dataset.householdId
      ) {
        throw new TrainingBlockedError('dataset_manifest_mismatch');
      }
      const rows = parseDataset(datasetBytes);
      const classCount = validateReadiness(rows, manifest);
      const model = trainMerchantClassifier(rows);
      const metrics: TrainingMetrics = {
        training: evaluateMerchantClassifier(model, rows, 'train'),
        validation: evaluateMerchantClassifier(model, rows, 'validation'),
        test: evaluateMerchantClassifier(model, rows, 'test'),
      };
      const artifact: MerchantModelArtifact = {
        schemaVersion: 'merchant-model-artifact-v1',
        task: 'merchant-category',
        dataset: {
          snapshotId: initial.dataset.id,
          version: initial.dataset.version,
          artifactHash: initial.dataset.artifactHash,
          manifestHash: initial.dataset.manifestHash,
        },
        trainer: {
          version: MERCHANT_CLASSIFIER_TRAINER_VERSION,
          codeHash: environment.codeHash,
          dependencyLockHash: environment.dependencyLockHash,
        },
        runtime: {
          nodeVersion: environment.nodeVersion,
          platform: environment.platform,
          architecture: environment.architecture,
        },
        model,
        metrics,
      };
      const artifactJson = `${canonicalJson(artifact)}\n`;
      const artifactHash = sha256Hex(artifactJson);
      artifactKey =
        `models/merchant-category/${initial.dataset.householdId}/` +
        `${initial.run.id}/model.json`;
      await this.putObject(artifactKey, artifactJson);

      const modelRegistryId = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`training-run:${initial.run.id}`}))`,
        );
        const [dataset] = await tx
          .select({ status: schema.datasetSnapshots.status })
          .from(schema.datasetSnapshots)
          .where(eq(schema.datasetSnapshots.id, initial.dataset.id))
          .limit(1);
        if (dataset?.status !== 'approved') {
          throw new TrainingBlockedError('dataset_revoked_during_training');
        }
        const modelVersion = `${initial.dataset.version}-${artifactHash.slice(0, 12)}`;
        const [createdModel] = await tx
          .insert(schema.modelRegistry)
          .values({
            householdId: initial.dataset.householdId,
            task: 'merchant-category',
            provider: LOCAL_MODEL_PROVIDER,
            model: LOCAL_MODEL_NAME,
            version: modelVersion,
            artifactHash,
            createdBy: initial.run.requestedBy,
          })
          .onConflictDoNothing()
          .returning({ id: schema.modelRegistry.id });
        const modelRow =
          createdModel ??
          (
            await tx
              .select({
                id: schema.modelRegistry.id,
                artifactHash: schema.modelRegistry.artifactHash,
              })
              .from(schema.modelRegistry)
              .where(
                and(
                  eq(
                    schema.modelRegistry.householdId,
                    initial.dataset.householdId!,
                  ),
                  eq(schema.modelRegistry.task, 'merchant-category'),
                  eq(schema.modelRegistry.provider, LOCAL_MODEL_PROVIDER),
                  eq(schema.modelRegistry.model, LOCAL_MODEL_NAME),
                  eq(schema.modelRegistry.version, modelVersion),
                ),
              )
              .limit(1)
          )[0];
        if (!modelRow || ('artifactHash' in modelRow && modelRow.artifactHash !== artifactHash)) {
          throw new Error('model registry identity conflict');
        }
        await tx
          .insert(schema.lineageEdges)
          .values([
            {
              fromNodeType: 'dataset_snapshot',
              fromNodeId: initial.dataset.id,
              toNodeType: 'training_run',
              toNodeId: initial.run.id,
              transformVersion: MERCHANT_CLASSIFIER_TRAINER_VERSION,
              pipelineRunId,
            },
            {
              fromNodeType: 'training_run',
              fromNodeId: initial.run.id,
              toNodeType: 'model_registry',
              toNodeId: modelRow.id,
              transformVersion: MERCHANT_CLASSIFIER_TRAINER_VERSION,
              pipelineRunId,
            },
          ])
          .onConflictDoNothing();
        const [completed] = await tx
          .update(schema.trainingRuns)
          .set({
            status: 'succeeded',
            modelRegistryId: modelRow.id,
            artifactKey,
            artifactHash,
            environment,
            metrics,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.trainingRuns.id, initial.run.id),
              eq(schema.trainingRuns.status, 'running'),
            ),
          )
          .returning({ id: schema.trainingRuns.id });
        if (!completed) {
          throw new Error('training run completion conflict');
        }
        return modelRow.id;
      });
      return {
        rowCount: rows.length,
        classCount,
        artifactHash,
        modelRegistryId,
        metrics,
      };
    } catch (error: unknown) {
      if (artifactKey !== null) {
        await this.deleteObjectQuietly(artifactKey);
      }
      if (claimed) {
        await this.markTerminal(
          error instanceof TrainingBlockedError ? 'blocked' : 'failed',
          error instanceof TrainingBlockedError ? error.code : 'TrainingFailed',
        );
      }
      throw error;
    }
  }

  private async markTerminal(
    status: 'blocked' | 'failed',
    errorCode: string,
  ): Promise<void> {
    await this.db
      .update(schema.trainingRuns)
      .set({
        status,
        errorCode: errorCode.slice(0, 200),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.trainingRuns.id, this.config.trainingRunId),
          eq(schema.trainingRuns.status, 'running'),
        ),
      );
  }

  private async getObject(key: string): Promise<Buffer> {
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.storageBucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error('storage object body is empty');
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  private async putObject(key: string, body: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.storageBucket,
        Key: key,
        Body: body,
        ContentType: 'application/json; charset=utf-8',
      }),
    );
  }

  private async deleteObjectQuietly(key: string): Promise<void> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.config.storageBucket,
          Key: key,
        }),
      );
    } catch {
      // 원래 학습 오류를 보존한다. key나 storage 오류 원문은 로그하지 않는다.
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, client }: { db: Db; client: Sql } = createDbClient(
    config.databaseUrl,
    { max: 2 },
  );
  const s3 = new S3Client({
    endpoint: config.storageEndpoint,
    region: config.storageRegion,
    credentials: {
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecretKey,
    },
    forcePathStyle: config.storageForcePathStyle,
  });
  try {
    const result = await new TrainingRunner(config, db, s3).run();
    if (result === null) {
      console.log('training run already completed');
      return;
    }
    console.log(
      `training completed: rows=${result.rowCount} classes=${result.classCount} ` +
        `model=${result.modelRegistryId} artifact=${result.artifactHash.slice(0, 12)}`,
    );
  } finally {
    s3.destroy();
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  const code =
    error instanceof TrainingBlockedError
      ? error.code
      : error instanceof Error
        ? error.name
        : 'UnknownError';
  console.error(`training failed: ${code}`);
  process.exit(1);
});
