import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  applyConditionTransitions,
  buildSentinelWebhookPayload,
  collectSentinelConditions,
  createInitialSentinelState,
  deliverPendingAlerts,
  parseSentinelConfig,
  pingHeartbeat,
  runSentinelCycle,
} from './ops-sentinel.mjs';

const NOW_MS = Date.parse('2026-07-19T12:00:00.000Z');

function validEnv(overrides = {}) {
  return {
    PIPELINE_ALERT_WEBHOOK_URL: 'https://hooks.example.com/alerts',
    PIPELINE_ALERT_WEBHOOK_FORMAT: 'generic',
    OPS_SENTINEL_INTERVAL_MS: '60000',
    OPS_SENTINEL_REQUEST_TIMEOUT_MS: '5000',
    OPS_SENTINEL_BACKUP_MAX_AGE_SECONDS: '90000',
    OPS_SENTINEL_DISK_MIN_FREE_BYTES: '42949672960',
    OPS_SENTINEL_DISK_MIN_FREE_PERCENT: '10',
    ...overrides,
  };
}

function healthyAdapters() {
  return {
    nowMs: () => NOW_MS,
    readFile: async () => String(Math.floor(NOW_MS / 1000) - 3600),
    statfs: async () => ({
      blocks: 1_000n,
      bavail: 500n,
      bsize: 1_000_000_000n,
    }),
  };
}

describe('ops sentinel 설정', () => {
  it('정상 환경변수를 타입이 지정된 설정으로 변환한다', () => {
    const config = parseSentinelConfig(validEnv());

    assert.equal(config.enabled, true);
    assert.equal(config.webhookUrl, 'https://hooks.example.com/alerts');
    assert.equal(config.format, 'generic');
    assert.equal(config.intervalMs, 60_000);
    assert.equal(config.backupMaxAgeSeconds, 90_000);
    assert.equal(config.diskMinFreeBytes, 42_949_672_960);
    assert.equal(config.diskMinFreePercent, 10);
  });

  it('웹훅이 없으면 서비스는 disabled 상태로 측정만 계속한다', () => {
    const config = parseSentinelConfig(
      validEnv({ PIPELINE_ALERT_WEBHOOK_URL: '' }),
    );

    assert.equal(config.enabled, false);
    assert.equal(config.webhookUrl, null);
  });

  it('heartbeatUrl은 미설정 시 null, 설정 시 trim되어 파싱된다', () => {
    assert.equal(parseSentinelConfig(validEnv()).heartbeatUrl, null);
    const config = parseSentinelConfig(
      validEnv({ OPS_SENTINEL_HEARTBEAT_URL: '  https://hc.example.com/ping/uuid  ' }),
    );
    assert.equal(config.heartbeatUrl, 'https://hc.example.com/ping/uuid');
  });

  it('비 HTTPS URL과 범위를 벗어난 숫자를 거부한다', () => {
    assert.throws(
      () =>
        parseSentinelConfig(
          validEnv({ PIPELINE_ALERT_WEBHOOK_URL: 'http://example.com/hook' }),
        ),
      /PIPELINE_ALERT_WEBHOOK_URL must use https/,
    );
    assert.throws(
      () => parseSentinelConfig(validEnv({ OPS_SENTINEL_INTERVAL_MS: '1000' })),
      /OPS_SENTINEL_INTERVAL_MS/,
    );
    assert.throws(
      () =>
        parseSentinelConfig(
          validEnv({ OPS_SENTINEL_DISK_MIN_FREE_PERCENT: '101' }),
        ),
      /OPS_SENTINEL_DISK_MIN_FREE_PERCENT/,
    );
  });
});

describe('ops sentinel 측정', () => {
  it('fresh backup과 충분한 disk를 정상으로 판정한다', async () => {
    const config = parseSentinelConfig(validEnv());
    const conditions = await collectSentinelConditions(
      config,
      healthyAdapters(),
    );

    assert.equal(conditions.backup_stale.firing, false);
    assert.equal(conditions.backup_stale.details.observedAgeSeconds, 3600);
    assert.equal(conditions.disk_low.firing, false);
    assert.equal(conditions.disk_low.details.availablePercent, 50);
  });

  it('backup age가 상한을 초과할 때만 stale로 판정한다', async () => {
    const config = parseSentinelConfig(validEnv());
    const atBoundary = healthyAdapters();
    atBoundary.readFile = async () =>
      String(Math.floor(NOW_MS / 1000) - config.backupMaxAgeSeconds);
    const overBoundary = healthyAdapters();
    overBoundary.readFile = async () =>
      String(Math.floor(NOW_MS / 1000) - config.backupMaxAgeSeconds - 1);

    assert.equal(
      (await collectSentinelConditions(config, atBoundary)).backup_stale.firing,
      false,
    );
    assert.equal(
      (await collectSentinelConditions(config, overBoundary)).backup_stale.firing,
      true,
    );
  });

  it('backup marker 누락·손상·미래 시각을 안전하게 stale로 판정한다', async () => {
    const config = parseSentinelConfig(validEnv());
    const missing = healthyAdapters();
    missing.readFile = async () => {
      const error = new Error('missing path must not be logged');
      error.code = 'ENOENT';
      throw error;
    };
    const invalid = healthyAdapters();
    invalid.readFile = async () => 'not-an-epoch';
    const future = healthyAdapters();
    future.readFile = async () => String(Math.floor(NOW_MS / 1000) + 301);

    assert.equal(
      (await collectSentinelConditions(config, missing)).backup_stale.details
        .errorCode,
      'BackupMarkerMissing',
    );
    assert.equal(
      (await collectSentinelConditions(config, invalid)).backup_stale.details
        .errorCode,
      'BackupMarkerInvalid',
    );
    assert.equal(
      (await collectSentinelConditions(config, future)).backup_stale.details
        .errorCode,
      'BackupMarkerFuture',
    );
  });

  it('free bytes 또는 percent 중 하나라도 하한 미만이면 disk low다', async () => {
    const config = parseSentinelConfig(validEnv());
    const lowBytes = healthyAdapters();
    lowBytes.statfs = async () => ({
      blocks: 1_000n,
      bavail: 42n,
      bsize: 1_000_000_000n,
    });
    const atBoundary = healthyAdapters();
    atBoundary.statfs = async () => ({
      blocks: 100n,
      bavail: 10n,
      bsize: 4_294_967_296n,
    });

    assert.equal(
      (await collectSentinelConditions(config, lowBytes)).disk_low.firing,
      true,
    );
    assert.equal(
      (await collectSentinelConditions(config, atBoundary)).disk_low.firing,
      false,
    );
  });

  it('filesystem 측정 실패를 원문 없이 disk 경보로 변환한다', async () => {
    const config = parseSentinelConfig(validEnv());
    const adapters = healthyAdapters();
    adapters.statfs = async () => {
      throw new Error('/private/path must not be exposed');
    };

    const condition = (await collectSentinelConditions(config, adapters))
      .disk_low;
    assert.equal(condition.firing, true);
    assert.equal(condition.details.errorCode, 'DiskMeasurementError');
    assert.equal(JSON.stringify(condition.details).includes('/private'), false);
  });
});

describe('ops sentinel 상태 전이', () => {
  const firingConditions = {
    backup_stale: {
      firing: true,
      details: { observedAgeSeconds: 90_001, maxAgeSeconds: 90_000 },
    },
    disk_low: {
      firing: false,
      details: {
        availableBytes: 50_000_000_000,
        totalBytes: 500_000_000_000,
        availablePercent: 10,
        minFreeBytes: 42_949_672_960,
        minFreePercent: 10,
      },
    },
  };

  it('첫 정상 관측은 알리지 않고 첫 firing만 한 번 enqueue한다', () => {
    const state = createInitialSentinelState();
    const first = applyConditionTransitions(
      state,
      firingConditions,
      '2026-07-19T12:00:00.000Z',
      () => 'event-1',
    );
    const second = applyConditionTransitions(
      first,
      firingConditions,
      '2026-07-19T12:01:00.000Z',
      () => 'event-2',
    );

    assert.equal(first.pending.length, 1);
    assert.equal(first.pending[0].kind, 'backup_stale');
    assert.equal(first.pending[0].details.transition, 'firing');
    assert.equal(second.pending.length, 1);
  });

  it('회복 시 recovered를 firing 뒤에 보존한다', () => {
    const firing = applyConditionTransitions(
      createInitialSentinelState(),
      firingConditions,
      '2026-07-19T12:00:00.000Z',
      () => 'event-1',
    );
    const recovered = applyConditionTransitions(
      firing,
      {
        ...firingConditions,
        backup_stale: {
          firing: false,
          details: { observedAgeSeconds: 60, maxAgeSeconds: 90_000 },
        },
      },
      '2026-07-19T12:02:00.000Z',
      () => 'event-2',
    );

    assert.deepEqual(
      recovered.pending.map((event) => event.details.transition),
      ['firing', 'recovered'],
    );
  });

  it('receiver 장애 중 반복 flap은 kind별 첫 event와 최신 상태로 축약한다', () => {
    const firing = applyConditionTransitions(
      createInitialSentinelState(),
      firingConditions,
      '2026-07-19T12:00:00.000Z',
      () => 'event-1',
    );
    const recovered = applyConditionTransitions(
      firing,
      {
        ...firingConditions,
        backup_stale: {
          firing: false,
          details: { observedAgeSeconds: 60, maxAgeSeconds: 90_000 },
        },
      },
      '2026-07-19T12:01:00.000Z',
      () => 'event-2',
    );
    const firingAgain = applyConditionTransitions(
      recovered,
      firingConditions,
      '2026-07-19T12:02:00.000Z',
      () => 'event-3',
    );

    assert.deepEqual(
      firingAgain.pending.map((event) => event.id),
      ['event-1'],
    );
    assert.equal(firingAgain.pending[0].details.transition, 'firing');
  });
});

describe('ops sentinel webhook 전달', () => {
  it('generic과 Slack payload에 고정된 안전한 필드만 만든다', () => {
    const event = {
      id: 'event-1',
      kind: 'backup_stale',
      severity: 'critical',
      sourceType: 'host_monitor',
      sourceId: 'backup',
      summary: 'backup freshness threshold exceeded',
      details: {
        transition: 'firing',
        observedAgeSeconds: 90_001,
        maxAgeSeconds: 90_000,
      },
      occurredAt: '2026-07-19T12:00:00.000Z',
    };

    assert.equal(buildSentinelWebhookPayload(event, 'generic').schemaVersion, 'operational-alert-v1');
    assert.match(buildSentinelWebhookPayload(event, 'slack').text, /backup_stale/);
  });

  it('state에서 변조된 id·timestamp·summary를 외부 payload에 그대로 내보내지 않는다', () => {
    const payload = buildSentinelWebhookPayload(
      {
        id: '<!channel>',
        kind: 'disk_low',
        severity: 'critical',
        sourceType: 'tampered',
        sourceId: 'user-id',
        summary: '<!channel> secret',
        details: {
          transition: 'firing',
          availableBytes: 1,
          rawText: 'private',
        },
        occurredAt: '<!channel>',
      },
      'generic',
    );

    assert.equal(payload.alert.id, 'channel');
    assert.equal(payload.alert.summary, 'host disk free space threshold breached');
    assert.equal(payload.alert.sourceType, 'host_monitor');
    assert.equal(payload.alert.sourceId, 'host-disk');
    assert.equal(payload.alert.occurredAt, 'invalid-timestamp');
    assert.equal('rawText' in payload.alert.details, false);
  });

  it('성공한 pending만 순서대로 제거하고 bearer token을 보낸다', async () => {
    const requests = [];
    const state = {
      ...createInitialSentinelState(),
      pending: [
        {
          id: 'event-1',
          kind: 'backup_stale',
          severity: 'critical',
          sourceType: 'host_monitor',
          sourceId: 'backup',
          summary: 'backup stale',
          details: { transition: 'firing' },
          occurredAt: '2026-07-19T12:00:00.000Z',
        },
      ],
    };
    const config = parseSentinelConfig(
      validEnv({ PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN: 'receiver-token' }),
    );

    const delivered = await deliverPendingAlerts(state, config, {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, status: 204 };
      },
    });

    assert.equal(delivered.pending.length, 0);
    assert.equal(requests[0].url, 'https://hooks.example.com/alerts');
    assert.equal(requests[0].init.headers.authorization, 'Bearer receiver-token');
  });

  it('HTTP 오류와 timeout에서 pending을 유지하고 응답 본문을 읽지 않는다', async () => {
    let bodyRead = false;
    const state = {
      ...createInitialSentinelState(),
      pending: [
        {
          id: 'event-1',
          kind: 'disk_low',
          severity: 'critical',
          sourceType: 'host_monitor',
          sourceId: 'host-disk',
          summary: 'disk low',
          details: { transition: 'firing' },
          occurredAt: '2026-07-19T12:00:00.000Z',
        },
      ],
    };
    const config = parseSentinelConfig(validEnv());

    await assert.rejects(
      () =>
        deliverPendingAlerts(state, config, {
          fetch: async () => ({
            ok: false,
            status: 503,
            text: async () => {
              bodyRead = true;
              return 'secret response';
            },
          }),
        }),
      /WebhookHttp5xx/,
    );
    assert.equal(state.pending.length, 1);
    assert.equal(bodyRead, false);
  });
});

describe('ops sentinel 전체 cycle', () => {
  it('condition 전이를 atomic state에 먼저 저장한 뒤 전달 완료를 반영한다', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'ops-sentinel-'));
    try {
      const backupRoot = join(temporaryRoot, 'backups');
      const stateFile = join(temporaryRoot, 'state', 'state.json');
      await mkdir(backupRoot, { recursive: true });
      await writeFile(
        join(backupRoot, '.last-success'),
        String(Math.floor(NOW_MS / 1000) - 90_001),
      );
      const config = parseSentinelConfig(
        validEnv({
          OPS_SENTINEL_BACKUP_ROOT: backupRoot,
          OPS_SENTINEL_STATE_FILE: stateFile,
        }),
      );
      const payloads = [];

      const summary = await runSentinelCycle(config, {
        nowMs: () => NOW_MS,
        statfs: async () => ({
          blocks: 1_000n,
          bavail: 500n,
          bsize: 1_000_000_000n,
        }),
        fetch: async (_url, init) => {
          payloads.push(JSON.parse(init.body));
          return { ok: true, status: 204 };
        },
      });

      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      assert.deepEqual(summary, {
        enabled: true,
        pending: 0,
        backupStale: true,
        diskLow: false,
      });
      assert.equal(state.version, 1);
      assert.equal(state.observed.backup_stale, true);
      assert.equal(state.pending.length, 0);
      assert.equal(state.lastCycleAt, '2026-07-19T12:00:00.000Z');
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].alert.kind, 'backup_stale');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('손상 state를 폐기하고 URL 미설정 상태에서도 heartbeat를 복구한다', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'ops-sentinel-'));
    try {
      const backupRoot = join(temporaryRoot, 'backups');
      const stateFile = join(temporaryRoot, 'state', 'state.json');
      await mkdir(join(temporaryRoot, 'state'), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(
        join(backupRoot, '.last-success'),
        String(Math.floor(NOW_MS / 1000) - 60),
      );
      await writeFile(stateFile, '{broken-json');
      const config = parseSentinelConfig(
        validEnv({
          PIPELINE_ALERT_WEBHOOK_URL: '',
          OPS_SENTINEL_BACKUP_ROOT: backupRoot,
          OPS_SENTINEL_STATE_FILE: stateFile,
        }),
      );

      const summary = await runSentinelCycle(config, {
        nowMs: () => NOW_MS,
        statfs: async () => ({
          blocks: 100n,
          bavail: 50n,
          bsize: 1_000_000_000n,
        }),
        fetch: async () => {
          throw new Error('disabled sentinel must not call fetch');
        },
      });

      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      assert.equal(summary.enabled, false);
      assert.equal(summary.pending, 0);
      assert.equal(state.observed.backup_stale, false);
      assert.equal(state.observed.disk_low, false);
      assert.equal(state.lastCycleAt, '2026-07-19T12:00:00.000Z');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('ops sentinel 외부 하트비트(DMS)', () => {
  it('heartbeatUrl이 없으면 no-op — fetch를 호출하지 않고 false를 반환한다', async () => {
    const config = parseSentinelConfig(validEnv());
    let called = false;
    const result = await pingHeartbeat(config, true, {
      fetch: async () => {
        called = true;
        return { ok: true };
      },
    });
    assert.equal(called, false);
    assert.equal(result, false);
  });

  it('성공 사이클은 base URL로, 실패 사이클은 /fail로 POST한다', async () => {
    const config = parseSentinelConfig(
      validEnv({ OPS_SENTINEL_HEARTBEAT_URL: 'https://hc.example.com/ping/uuid' }),
    );
    /** @type {{url: string, method: string}[]} */
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, method: init.method });
      return { ok: true };
    };
    assert.equal(await pingHeartbeat(config, true, { fetch: fetchFn }), true);
    assert.equal(await pingHeartbeat(config, false, { fetch: fetchFn }), true);
    assert.deepEqual(calls, [
      { url: 'https://hc.example.com/ping/uuid', method: 'POST' },
      { url: 'https://hc.example.com/ping/uuid/fail', method: 'POST' },
    ]);
  });

  it('전송 오류를 삼켜 false를 반환하고 절대 throw하지 않는다(감시 루프 보호)', async () => {
    const config = parseSentinelConfig(
      validEnv({ OPS_SENTINEL_HEARTBEAT_URL: 'https://hc.example.com/ping/uuid' }),
    );
    const result = await pingHeartbeat(config, true, {
      fetch: async () => {
        throw new Error('network down');
      },
    });
    assert.equal(result, false);
  });

  it('non-2xx 응답은 false로 취급한다(재시도는 다음 사이클)', async () => {
    const config = parseSentinelConfig(
      validEnv({ OPS_SENTINEL_HEARTBEAT_URL: 'https://hc.example.com/ping/uuid' }),
    );
    const result = await pingHeartbeat(config, true, {
      fetch: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(result, false);
  });
});
