/** 실제 MinIO와 격리 DB에서 Training Runner 재현성·계보·삭제 전파를 검증한다. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { assertVerificationDatabaseSafety } from './lib/verification-database-guard.mjs';

import {
  createDbClient,
  schema,
} from '../packages/database/dist/index.mjs';
import {
  buildMerchantCategoryDatasetArtifact,
  canonicalJson,
  DEFAULT_DATASET_TIME_SPLIT_POLICY,
  sha256Hex,
} from '../packages/rag/dist/index.mjs';
import { assertMerchantClassifierModel } from '../packages/shared/dist/index.mjs';

const databaseUrl = process.env.DATABASE_URL;
const { databaseName } = assertVerificationDatabaseSafety({
  databaseUrl,
  allowWrite: process.env.MODEL_GATE_VERIFY_ALLOW_WRITE,
  nodeEnv: process.env.NODE_ENV,
});
console.log(`[trainer] 검증 DB 안전 가드 통과: ${databaseName}`);

const require = createRequire(import.meta.url);
const { and, eq } = require('../packages/database/node_modules/drizzle-orm');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('../apps/trainer/node_modules/@aws-sdk/client-s3');
const { LocalMerchantClassifierService } = require(
  '../apps/worker/dist/model-serving/local-merchant-classifier.service.js',
);
const { LearningDatasetService } = require(
  '../apps/api/dist/learning/learning-dataset.service.js',
);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const storageBucket = requiredEnvironment('STORAGE_BUCKET');
const s3 = new S3Client({
  endpoint: requiredEnvironment('STORAGE_ENDPOINT'),
  region: requiredEnvironment('STORAGE_REGION'),
  credentials: {
    accessKeyId: requiredEnvironment('STORAGE_ACCESS_KEY'),
    secretAccessKey: requiredEnvironment('STORAGE_SECRET_KEY'),
  },
  forcePathStyle: requiredEnvironment('STORAGE_FORCE_PATH_STYLE') === 'true',
});
const { db, client } = createDbClient(databaseUrl, { max: 2 });
const userId = randomUUID();
const householdId = randomUUID();
const datasetSnapshotId = randomUUID();
const suffix = randomUUID().replaceAll('-', '');
const objectKeys = new Set();

function merchantTargetId(merchantPattern) {
  return createHash('sha256')
    .update(JSON.stringify([householdId, merchantPattern]), 'utf8')
    .digest('hex');
}

async function putObject(key, body, contentType) {
  objectKeys.add(key);
  await s3.send(
    new PutObjectCommand({
      Bucket: storageBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function getObject(key) {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: storageBucket, Key: key }),
  );
  assert(response.Body, `object body missing: ${key}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

async function deleteObject(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: storageBucket, Key: key }));
  objectKeys.delete(key);
}

function runTrainer(trainingRunId) {
  const result = spawnSync('node', ['apps/trainer/dist/main.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, TRAINING_RUN_ID: trainingRunId },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Training Runner 실패: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
}

try {
  await db.insert(schema.users).values({
    id: userId,
    email: `trainer-${suffix}@example.test`,
    passwordHash: 'verification-only',
    name: 'Trainer Verify',
  });
  await db.insert(schema.households).values({
    id: householdId,
    name: 'Trainer Verify',
    createdBy: userId,
  });
  await db.insert(schema.householdMembers).values({
    householdId,
    userId,
    role: 'owner',
    status: 'active',
  });

  const categories = ['cafe', 'store', 'transit'].map((slug) => ({
    id: randomUUID(),
    householdId,
    slug: `${slug}-${suffix.slice(0, 8)}`,
    name: slug,
  }));
  await db.insert(schema.expenseCategories).values(categories);

  const now = Date.now();
  const inputs = [];
  const itemRows = [];
  for (let classIndex = 0; classIndex < categories.length; classIndex += 1) {
    const category = categories[classIndex];
    for (let index = 0; index < 40; index += 1) {
      const ruleId = randomUUID();
      const feedbackEventId = randomUUID();
      const merchantPattern = `${category.name}-merchant-${String(index).padStart(2, '0')}`;
      const occurredAt = new Date(
        now -
          (index < 30 ? 60 : index < 35 ? 20 : 0) * 24 * 60 * 60 * 1_000 -
          classIndex * 1_000,
      );
      const targetId = merchantTargetId(merchantPattern);
      await db.insert(schema.merchantCategoryRules).values({
        id: ruleId,
        householdId,
        merchantPattern,
        categoryId: category.id,
        source: 'human_confirmed',
        confirmedAt: occurredAt,
        createdBy: userId,
      });
      await db.insert(schema.feedbackEvents).values({
        id: feedbackEventId,
        householdId,
        targetType: 'merchant-category',
        targetId,
        labelSchemaVersion: 'merchant-category-v1',
        label: { categoryId: category.id },
        source: 'human_confirmed',
        actorUserId: userId,
        occurredAt,
      });
      inputs.push({
        feedbackEventId,
        targetId,
        merchantCategoryRuleId: ruleId,
        merchantPattern,
        categoryId: category.id,
        categorySlug: category.slug,
        occurredAt,
        labelSchemaVersion: 'merchant-category-v1',
        source: 'human_confirmed',
      });
      itemRows.push({ feedbackEventId, ruleId });
    }
  }

  const artifact = buildMerchantCategoryDatasetArtifact(
    inputs,
    DEFAULT_DATASET_TIME_SPLIT_POLICY,
  );
  assert.equal(artifact.rows.length, 120);
  assert.equal(artifact.splitCounts.train, 90);
  assert.equal(artifact.splitCounts.validation, 15);
  assert.equal(artifact.splitCounts.test, 15);
  const baseKey = `verification/training/${suffix}`;
  const artifactKey = `${baseKey}/examples.jsonl`;
  const manifestKey = `${baseKey}/manifest.json`;
  const version = `verify-${artifact.artifactHash.slice(0, 16)}`;
  const manifest = {
    task: 'merchant-category',
    version,
    schemaVersion: 'merchant-category-dataset-v2',
    featureSchemaVersion: 'merchant-normalized-v1',
    scope: { type: 'household', id: householdId },
    artifact: {
      key: artifactKey,
      format: 'jsonl',
      sha256: artifact.artifactHash,
    },
    rowCount: artifact.rows.length,
    splitPolicy: artifact.splitPolicy,
    splitCounts: artifact.splitCounts,
    leakageAudit: artifact.leakageAudit,
    labelSources: ['human_confirmed'],
    inputNodeType: 'merchant_category_rule',
    consentScope: { mode: 'household-only', crossHousehold: false },
  };
  const manifestJson = `${canonicalJson(manifest)}\n`;
  await putObject(
    artifactKey,
    artifact.jsonl,
    'application/x-ndjson; charset=utf-8',
  );
  await putObject(manifestKey, manifestJson, 'application/json; charset=utf-8');

  await db.insert(schema.datasetSnapshots).values({
    id: datasetSnapshotId,
    householdId,
    task: 'merchant-category',
    version,
    schemaVersion: 'merchant-category-dataset-v2',
    artifactKey,
    artifactHash: artifact.artifactHash,
    manifestKey,
    manifestHash: sha256Hex(manifestJson),
    splitPolicy: {
      ...artifact.splitPolicy,
      leakageAudit: artifact.leakageAudit,
    },
    consentScope: { mode: 'household-only', crossHousehold: false },
    rowCount: artifact.rows.length,
    status: 'approved',
    createdBy: userId,
    approvedAt: new Date(),
  });
  const artifactByFeedback = new Map(
    artifact.rows.map((row) => [row.feedbackEventId, row]),
  );
  await db.insert(schema.datasetSnapshotItems).values(
    itemRows.map((item) => {
      const row = artifactByFeedback.get(item.feedbackEventId);
      assert(row);
      return {
        datasetSnapshotId,
        feedbackEventId: item.feedbackEventId,
        merchantCategoryRuleId: item.ruleId,
        targetType: 'merchant-category',
        targetId: row.targetId,
        split: row.split,
        splitGroupHash: row.splitGroupHash,
        occurredAt: new Date(row.occurredAt),
      };
    }),
  );

  const runIds = [randomUUID(), randomUUID()];
  for (const runId of runIds) {
    await db.insert(schema.trainingRuns).values({
      id: runId,
      datasetSnapshotId,
      task: 'merchant-category',
      trainerVersion: 'merchant-char-ngram-nb-v1',
      requestedBy: userId,
    });
    runTrainer(runId);
  }

  const completedRuns = await db
    .select()
    .from(schema.trainingRuns)
    .where(and(
      eq(schema.trainingRuns.datasetSnapshotId, datasetSnapshotId),
      eq(schema.trainingRuns.status, 'succeeded'),
    ));
  assert.equal(completedRuns.length, 2);
  assert.equal(completedRuns[0].artifactHash, completedRuns[1].artifactHash);
  assert.equal(completedRuns[0].modelRegistryId, completedRuns[1].modelRegistryId);
  for (const run of completedRuns) {
    assert(run.artifactKey);
    objectKeys.add(run.artifactKey);
  }
  const modelBytes = await getObject(completedRuns[0].artifactKey);
  assert.equal(sha256Hex(modelBytes), completedRuns[0].artifactHash);
  const modelArtifact = JSON.parse(modelBytes.toString('utf8'));
  assertMerchantClassifierModel(modelArtifact.model);
  assert.equal(modelArtifact.metrics.validation.accuracy, 1);
  assert.equal(modelArtifact.metrics.test.accuracy, 1);
  assert.match(modelArtifact.trainer.codeHash, /^[a-f0-9]{64}$/u);
  assert.match(modelArtifact.trainer.dependencyLockHash, /^[a-f0-9]{64}$/u);

  const approvedAt = new Date();
  await db
    .update(schema.modelRegistry)
    .set({
      status: 'approved',
      approvedBy: userId,
      approvedAt,
      updatedAt: approvedAt,
    })
    .where(eq(schema.modelRegistry.id, completedRuns[0].modelRegistryId));
  const aliasId = randomUUID();
  await db.insert(schema.modelAliases).values({
    id: aliasId,
    householdId,
    task: 'merchant-category',
    alias: 'production',
    modelRegistryId: completedRuns[0].modelRegistryId,
    revision: 1,
    lastChangeType: 'promotion',
    activatedBy: userId,
    activatedAt: approvedAt,
  });
  const localClassifier = new LocalMerchantClassifierService(db, { getObject });
  const servingPrediction = await localClassifier.predict(
    householdId,
    'cafe-merchant-39',
    null,
  );
  assert(servingPrediction);
  assert.equal(servingPrediction.categoryId, categories[0].id);
  assert.equal(servingPrediction.categorySlug, categories[0].slug);
  assert(servingPrediction.confidence > 0.9);
  const [servingInvocation] = await db
    .select()
    .from(schema.aiInvocations)
    .where(eq(schema.aiInvocations.id, servingPrediction.traceId));
  assert.equal(servingInvocation.operation, 'classification');
  assert.equal(servingInvocation.provider, 'subinary-local');
  assert.equal(servingInvocation.modelAliasId, aliasId);
  assert.equal(servingInvocation.outcome, 'succeeded');

  const lineage = await db
    .select()
    .from(schema.lineageEdges)
    .where(eq(schema.lineageEdges.fromNodeId, datasetSnapshotId));
  assert.equal(
    lineage.filter((edge) => edge.toNodeType === 'training_run').length,
    2,
  );

  const datasetService = new LearningDatasetService(db, { deleteObject });
  const revoked = await datasetService.revokeSnapshot(
    userId,
    datasetSnapshotId,
    'privacy_request',
  );
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revokedTrainingRunCount, 2);
  assert.equal(revoked.purgedArtifactCount, 4);
  const revokedRuns = await db
    .select()
    .from(schema.trainingRuns)
    .where(eq(schema.trainingRuns.datasetSnapshotId, datasetSnapshotId));
  assert(revokedRuns.every((run) => run.status === 'revoked'));
  assert(revokedRuns.every((run) => run.artifactPurgedAt !== null));
  const [model] = await db
    .select()
    .from(schema.modelRegistry)
    .where(eq(schema.modelRegistry.id, completedRuns[0].modelRegistryId));
  assert.equal(model.status, 'retired');
  assert.equal(
    await localClassifier.predict(householdId, 'cafe-merchant-39', null),
    null,
  );
  assert.equal(objectKeys.size, 0);

  console.log(
    '[trainer] 실제 학습 2회 재현성·checksum·계보·로컬 서빙·API artifact 삭제 전파 검증 통과',
  );
} finally {
  for (const key of objectKeys) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: storageBucket, Key: key }));
    } catch {
      // 격리 검증 DB 폐기와 원래 오류를 보존한다.
    }
  }
  s3.destroy();
  await client.end({ timeout: 5 });
}
