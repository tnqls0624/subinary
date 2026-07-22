import assert from 'node:assert/strict';
import test from 'node:test';

import { validateEnv } from '../../packages/config/dist/index.mjs';

function requiredEnv() {
  return {
    NODE_ENV: 'test',
    API_PORT: '3001',
    WORKER_PORT: '3002',
    WEB_PORT: '3000',
    DATABASE_URL: 'postgresql://family:secret@localhost:5432/family',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    BULLMQ_PREFIX: 'config-test',
    STORAGE_ENDPOINT: 'http://localhost:9000',
    STORAGE_REGION: 'us-east-1',
    STORAGE_ACCESS_KEY: 'access-key',
    STORAGE_SECRET_KEY: 'secret-key',
    STORAGE_BUCKET: 'family-memory',
    STORAGE_FORCE_PATH_STYLE: 'true',
    JWT_ACCESS_SECRET: '0123456789abcdef',
    DEVICE_SECRET_ENC_KEY: '0'.repeat(64),
    CORS_ORIGIN: 'http://localhost:3000',
  };
}

test('env_file의 빈 FCM 선택값을 미설정으로 처리한다', () => {
  const config = validateEnv({
    ...requiredEnv(),
    FCM_PROJECT_ID: '',
    FCM_CLIENT_EMAIL: '',
    FCM_PRIVATE_KEY: '',
  });

  assert.equal(config.notifications.fcmProjectId, undefined);
  assert.equal(config.notifications.fcmClientEmail, undefined);
  assert.equal(config.notifications.fcmPrivateKey, undefined);
});

test('설정된 FCM private key의 이스케이프 개행을 복원한다', () => {
  const config = validateEnv({
    ...requiredEnv(),
    FCM_PROJECT_ID: 'family-project',
    FCM_CLIENT_EMAIL: 'firebase@example.com',
    FCM_PRIVATE_KEY: 'line-one\\nline-two',
  });

  assert.equal(config.notifications.fcmPrivateKey, 'line-one\nline-two');
});

test('env_file의 빈 Webhook 선택값을 미설정으로 처리한다', () => {
  const config = validateEnv({
    ...requiredEnv(),
    PIPELINE_ALERT_WEBHOOK_URL: '',
    PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN: '',
    PIPELINE_ALERT_WEBHOOK_FORMAT: 'slack',
  });

  assert.equal(config.observability.alertWebhookUrl, undefined);
  assert.equal(config.observability.alertWebhookBearerToken, undefined);
  assert.equal(config.observability.alertWebhookFormat, 'slack');
});

test('설정된 Webhook URL과 Bearer Token을 보존한다', () => {
  const config = validateEnv({
    ...requiredEnv(),
    PIPELINE_ALERT_WEBHOOK_URL: 'https://alerts.example.com/subinary',
    PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN: 'receiver-secret',
  });

  assert.equal(
    config.observability.alertWebhookUrl,
    'https://alerts.example.com/subinary',
  );
  assert.equal(
    config.observability.alertWebhookBearerToken,
    'receiver-secret',
  );
});

test('잘못된 Webhook URL은 비밀값 없이 설정 경로만 보고한다', () => {
  assert.throws(
    () =>
      validateEnv({
        ...requiredEnv(),
        PIPELINE_ALERT_WEBHOOK_URL: 'not-a-webhook-url',
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /observability\.alertWebhookUrl/u);
      assert.doesNotMatch(error.message, /not-a-webhook-url/u);
      return true;
    },
  );
});
