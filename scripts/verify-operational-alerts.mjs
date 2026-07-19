/** 격리 검증 DB와 로컬 mock webhook에서 운영 알림 생성·재시도·전달을 검증한다. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import { assertVerificationDatabaseSafety } from './lib/verification-database-guard.mjs';
import {
  createDbClient,
  schema,
  trackPipelineExecution,
} from '../packages/database/dist/index.mjs';

const databaseUrl = process.env.DATABASE_URL;
const { databaseName } = assertVerificationDatabaseSafety({
  databaseUrl,
  allowWrite: process.env.MODEL_GATE_VERIFY_ALLOW_WRITE,
  nodeEnv: process.env.NODE_ENV,
});
console.log(`[operational-alert] 검증 DB 안전 가드 통과: ${databaseName}`);

const require = createRequire(import.meta.url);
const { eq, sql } = require('../packages/database/node_modules/drizzle-orm');
const {
  OutboxDispatcherService,
} = require('../apps/worker/dist/outbox/outbox-dispatcher.service.js');
const {
  OperationalAlertDispatcherService,
} = require('../apps/api/dist/observability/operational-alert-dispatcher.service.js');

const { db, client } = createDbClient(databaseUrl, { max: 1 });
const receivedPayloads = [];
let retryFailurePending = true;
const webhook = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    receivedPayloads.push(payload);
    if (
      payload?.alert?.summary === 'retry verification' &&
      retryFailurePending
    ) {
      retryFailurePending = false;
      response.writeHead(500).end();
      return;
    }
    response.writeHead(204).end();
  });
});

try {
  await new Promise((resolve, reject) => {
    webhook.once('error', reject);
    webhook.listen(0, '127.0.0.1', resolve);
  });
  const address = webhook.address();
  assert.ok(address && typeof address === 'object');

  await assert.rejects(
    trackPipelineExecution(
      db,
      {
        pipelineName: 'alert-verification',
        pipelineVersion: 'v1',
        stepName: 'non-terminal-attempt',
        stepVersion: 'v1',
        trigger: 'bullmq',
        attempt: 1,
        maximumAttempts: 3,
      },
      async () => {
        throw new TypeError('verification failure body must not be stored');
      },
    ),
    TypeError,
  );
  const nonTerminalAlerts = await db
    .select({ id: schema.operationalAlerts.id })
    .from(schema.operationalAlerts)
    .where(eq(schema.operationalAlerts.kind, 'pipeline_failed'));
  assert.equal(nonTerminalAlerts.length, 0);

  await assert.rejects(
    trackPipelineExecution(
      db,
      {
        pipelineName: 'alert-verification',
        pipelineVersion: 'v1',
        stepName: 'terminal-attempt',
        stepVersion: 'v1',
        trigger: 'bullmq',
        attempt: 3,
        maximumAttempts: 3,
      },
      async () => {
        throw new TypeError('verification failure body must not be stored');
      },
    ),
    TypeError,
  );

  const dataEventId = randomUUID();
  await db.insert(schema.dataEvents).values({
    id: dataEventId,
    aggregateType: 'verification',
    aggregateId: randomUUID(),
    eventType: 'unsupported.verification.v1',
    payload: {},
    occurredAt: new Date(),
  });
  const queue = { add: async () => undefined };
  const outbox = new OutboxDispatcherService(
    db,
    queue,
    queue,
    queue,
    queue,
    queue,
    queue,
  );
  const outboxSummary = await outbox.dispatchPending();
  assert.equal(outboxSummary.quarantined, 1);

  const alertConfig = {
    get(key) {
      if (key !== 'observability') return undefined;
      return {
        alertWebhookUrl: `http://127.0.0.1:${address.port}`,
        alertWebhookFormat: 'generic',
        alertPollIntervalMs: 30_000,
        alertBatchSize: 20,
        alertRequestTimeoutMs: 5_000,
        alertMaxAttempts: 2,
      };
    },
  };
  const dispatcher = new OperationalAlertDispatcherService(db, alertConfig);
  const initialDelivery = await dispatcher.dispatchPending();
  assert.ok(initialDelivery.delivered >= 2);
  assert.equal(initialDelivery.retried, 0);

  const retryAlertId = randomUUID();
  await db.insert(schema.operationalAlerts).values({
    id: retryAlertId,
    dedupeKey: `verification-retry:${retryAlertId}`,
    kind: 'pipeline_failed',
    severity: 'warning',
    sourceType: 'verification',
    sourceId: retryAlertId,
    summary: 'retry verification',
    details: { errorCode: 'VerificationError' },
    occurredAt: new Date(),
  });
  const firstRetry = await dispatcher.dispatchPending();
  assert.equal(firstRetry.retried, 1);
  await db
    .update(schema.operationalAlerts)
    .set({ availableAt: sql`now()` })
    .where(eq(schema.operationalAlerts.id, retryAlertId));
  const recoveredRetry = await dispatcher.dispatchPending();
  assert.equal(recoveredRetry.delivered, 1);

  const statuses = await db
    .select({ status: schema.operationalAlerts.status })
    .from(schema.operationalAlerts);
  assert.ok(statuses.every((row) => row.status === 'delivered'));
  assert.ok(
    receivedPayloads.every(
      (payload) => payload?.schemaVersion === 'operational-alert-v1',
    ),
  );

  console.log(
    JSON.stringify({
      pipelineTerminalFailureAlerted: true,
      pipelineRetryFailureSuppressed: true,
      outboxQuarantineAlerted: true,
      webhookDeliveryRecovered: true,
      deliveredAlertCount: statuses.length,
    }),
  );
} finally {
  await new Promise((resolve) => webhook.close(resolve));
  await client.end({ timeout: 5 });
}
