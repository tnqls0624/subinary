import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATE_VERSION = 1;
const SENTINEL_KINDS = ['backup_stale', 'disk_low'];
const MAX_PENDING_ALERTS = SENTINEL_KINDS.length * 2;
const MAX_CLOCK_SKEW_SECONDS = 300;

/** @typedef {'generic' | 'slack'} WebhookFormat */
/** @typedef {'backup_stale' | 'disk_low'} SentinelAlertKind */
/** @typedef {'firing' | 'recovered'} SentinelTransition */

/**
 * @typedef {object} SentinelConfig
 * @property {boolean} enabled
 * @property {string | null} webhookUrl
 * @property {string | null} bearerToken
 * @property {WebhookFormat} format
 * @property {number} intervalMs
 * @property {number} requestTimeoutMs
 * @property {number} backupMaxAgeSeconds
 * @property {number} diskMinFreeBytes
 * @property {number} diskMinFreePercent
 * @property {string} backupRoot
 * @property {string} stateFile
 * @property {string | null} heartbeatUrl
 */

/**
 * @typedef {object} SentinelAlertEnvelope
 * @property {string} id
 * @property {'backup_stale' | 'disk_low' | 'receiver_test'} kind
 * @property {'warning' | 'critical'} severity
 * @property {string} sourceType
 * @property {string} sourceId
 * @property {string} summary
 * @property {Record<string, unknown>} details
 * @property {string} occurredAt
 */

/**
 * @typedef {object} SentinelState
 * @property {1} version
 * @property {{ backup_stale: boolean | null, disk_low: boolean | null }} observed
 * @property {SentinelAlertEnvelope[]} pending
 * @property {string | null} lastCycleAt
 */

/**
 * @typedef {object} SentinelCondition
 * @property {boolean} firing
 * @property {Record<string, unknown>} details
 */

export class SentinelConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SentinelConfigError';
    this.code = 'SENTINEL_CONFIG_ERROR';
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} key
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 */
function parseInteger(env, key, fallback, minimum, maximum) {
  const raw = env[key]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SentinelConfigError(
      `${key} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/**
 * 환경변수를 검증된 sentinel 설정으로 변환한다. 오류에는 secret 값을 포함하지 않는다.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {SentinelConfig}
 */
export function parseSentinelConfig(env) {
  const rawUrl = env.PIPELINE_ALERT_WEBHOOK_URL?.trim() ?? '';
  let webhookUrl = null;
  if (rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new SentinelConfigError(
        'PIPELINE_ALERT_WEBHOOK_URL must be a valid URL',
      );
    }
    if (parsed.protocol !== 'https:') {
      throw new SentinelConfigError(
        'PIPELINE_ALERT_WEBHOOK_URL must use https',
      );
    }
    if (parsed.username || parsed.password) {
      throw new SentinelConfigError(
        'PIPELINE_ALERT_WEBHOOK_URL must not contain credentials',
      );
    }
    webhookUrl = parsed.toString();
  }

  const rawFormat = env.PIPELINE_ALERT_WEBHOOK_FORMAT?.trim() || 'generic';
  if (rawFormat !== 'generic' && rawFormat !== 'slack') {
    throw new SentinelConfigError(
      'PIPELINE_ALERT_WEBHOOK_FORMAT must be generic or slack',
    );
  }

  const bearerToken =
    env.PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN?.trim() || null;
  return {
    enabled: webhookUrl !== null,
    webhookUrl,
    bearerToken,
    format: rawFormat,
    intervalMs: parseInteger(
      env,
      'OPS_SENTINEL_INTERVAL_MS',
      60_000,
      30_000,
      3_600_000,
    ),
    requestTimeoutMs: parseInteger(
      env,
      'OPS_SENTINEL_REQUEST_TIMEOUT_MS',
      5_000,
      1_000,
      30_000,
    ),
    backupMaxAgeSeconds: parseInteger(
      env,
      'OPS_SENTINEL_BACKUP_MAX_AGE_SECONDS',
      90_000,
      300,
      2_592_000,
    ),
    diskMinFreeBytes: parseInteger(
      env,
      'OPS_SENTINEL_DISK_MIN_FREE_BYTES',
      42_949_672_960,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    diskMinFreePercent: parseInteger(
      env,
      'OPS_SENTINEL_DISK_MIN_FREE_PERCENT',
      10,
      1,
      100,
    ),
    backupRoot:
      env.OPS_SENTINEL_BACKUP_ROOT?.trim() || '/monitored/backups',
    stateFile: env.OPS_SENTINEL_STATE_FILE?.trim() || '/state/state.json',
    // 외부(맥 밖) dead-man's-switch 핑 URL. 미설정이면 무동작. webhook(enabled)과 독립 —
    // ops-sentinel(맥 안 감시자)이 통째로 죽으면 이 핑이 끊겨 맥 밖에서 감지된다(disk_low 사각지대 폐쇄).
    heartbeatUrl: env.OPS_SENTINEL_HEARTBEAT_URL?.trim() || null,
  };
}

/** @returns {SentinelState} */
export function createInitialSentinelState() {
  return {
    version: STATE_VERSION,
    observed: { backup_stale: null, disk_low: null },
    pending: [],
    lastCycleAt: null,
  };
}

/**
 * @param {bigint} value
 * @param {string} errorCode
 */
function bigintToSafeNumber(value, errorCode) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    const error = new Error(errorCode);
    error.name = errorCode;
    throw error;
  }
  return Number(value);
}

/**
 * backup freshness와 backup mount의 filesystem 여유 공간을 측정한다.
 *
 * @param {SentinelConfig} config
 * @param {{
 *   nowMs?: () => number,
 *   readFile?: typeof readFile,
 *   statfs?: typeof statfs,
 * }} [adapters]
 * @returns {Promise<Record<SentinelAlertKind, SentinelCondition>>}
 */
export async function collectSentinelConditions(config, adapters = {}) {
  const nowMs = adapters.nowMs?.() ?? Date.now();
  const readFileFn = adapters.readFile ?? readFile;
  const statfsFn = adapters.statfs ?? statfs;
  const nowEpochSeconds = Math.floor(nowMs / 1000);

  /** @type {SentinelCondition} */
  let backupCondition;
  try {
    const marker = (await readFileFn(
      `${config.backupRoot}/.last-success`,
      'utf8',
    )).trim();
    if (!/^\d+$/.test(marker)) {
      backupCondition = {
        firing: true,
        details: {
          observedAgeSeconds: null,
          maxAgeSeconds: config.backupMaxAgeSeconds,
          errorCode: 'BackupMarkerInvalid',
        },
      };
    } else {
      const markerEpochSeconds = Number(marker);
      const ageSeconds = nowEpochSeconds - markerEpochSeconds;
      if (!Number.isSafeInteger(markerEpochSeconds)) {
        backupCondition = {
          firing: true,
          details: {
            observedAgeSeconds: null,
            maxAgeSeconds: config.backupMaxAgeSeconds,
            errorCode: 'BackupMarkerInvalid',
          },
        };
      } else if (ageSeconds < -MAX_CLOCK_SKEW_SECONDS) {
        backupCondition = {
          firing: true,
          details: {
            observedAgeSeconds: 0,
            maxAgeSeconds: config.backupMaxAgeSeconds,
            errorCode: 'BackupMarkerFuture',
          },
        };
      } else {
        const observedAgeSeconds = Math.max(0, ageSeconds);
        backupCondition = {
          firing: observedAgeSeconds > config.backupMaxAgeSeconds,
          details: {
            observedAgeSeconds,
            maxAgeSeconds: config.backupMaxAgeSeconds,
          },
        };
      }
    }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    backupCondition = {
      firing: true,
      details: {
        observedAgeSeconds: null,
        maxAgeSeconds: config.backupMaxAgeSeconds,
        errorCode:
          code === 'ENOENT' ? 'BackupMarkerMissing' : 'BackupMarkerReadError',
      },
    };
  }

  /** @type {SentinelCondition} */
  let diskCondition;
  try {
    const stats = await statfsFn(config.backupRoot, { bigint: true });
    if (stats.blocks <= 0n || stats.bsize <= 0n || stats.bavail < 0n) {
      const error = new Error('DiskStatsInvalid');
      error.name = 'DiskStatsInvalid';
      throw error;
    }
    const totalBytes = bigintToSafeNumber(
      stats.blocks * stats.bsize,
      'DiskSizeOutOfRange',
    );
    const availableBytes = bigintToSafeNumber(
      stats.bavail * stats.bsize,
      'DiskSizeOutOfRange',
    );
    const availablePercent =
      Math.floor((availableBytes / totalBytes) * 10_000) / 100;
    // ⚠️ Docker Desktop(맥) 주의: 이 컨테이너는 virtiofs/gRPC-FUSE bind-mount를 statfs하므로
    // availableBytes/totalBytes는 진짜 맥 APFS가 아니라 VM 가상 디스크값(예: total ~126TB)을 반환한다.
    // 따라서 diskMinFreeBytes(절대 바이트) 절은 사실상 죽은 조건 — VM이 늘 거대한 여유를 보고해 절대 발화 안 함.
    // 반면 virtiofs가 채움 비율(%)은 그대로 통과시켜 availablePercent는 실제 맥 여유를 정확히 반영한다.
    // → 실효 가드는 diskMinFreePercent(퍼센트)다. OR 조합이라 죽은 바이트 절은 거짓 경보를 내지 않아 무해하며,
    //   BACKUP_DIR이 진짜 passthrough 볼륨인 non-Docker-Desktop 환경에선 바이트 절도 정상 동작한다(그래서 유지).
    //   절대 바이트 실측이 필요하면 맥 네이티브 beszel-agent가 올바른 소유자(진짜 APFS). 근거: docs GAP-3 감사.
    diskCondition = {
      firing:
        availableBytes < config.diskMinFreeBytes ||
        availablePercent < config.diskMinFreePercent,
      details: {
        availableBytes,
        totalBytes,
        availablePercent,
        minFreeBytes: config.diskMinFreeBytes,
        minFreePercent: config.diskMinFreePercent,
      },
    };
  } catch {
    diskCondition = {
      firing: true,
      details: {
        availableBytes: null,
        totalBytes: null,
        availablePercent: null,
        minFreeBytes: config.diskMinFreeBytes,
        minFreePercent: config.diskMinFreePercent,
        errorCode: 'DiskMeasurementError',
      },
    };
  }

  return {
    backup_stale: backupCondition,
    disk_low: diskCondition,
  };
}

/**
 * @param {SentinelAlertKind} kind
 * @param {SentinelTransition} transition
 */
function fixedSummary(kind, transition) {
  if (kind === 'backup_stale') {
    return transition === 'firing'
      ? 'backup freshness threshold exceeded'
      : 'backup freshness recovered';
  }
  return transition === 'firing'
    ? 'host disk free space threshold breached'
    : 'host disk free space recovered';
}

/**
 * receiver 장애 중 반복 flap이 state를 무한히 키우지 않도록 kind별 첫 event와 최신 상태만 보존한다.
 *
 * @param {SentinelAlertEnvelope[]} pending
 * @param {SentinelAlertEnvelope} event
 * @returns {SentinelAlertEnvelope[]}
 */
function enqueueConditionEvent(pending, event) {
  const firstIndex = pending.findIndex((candidate) => candidate.kind === event.kind);
  if (firstIndex < 0) return [...pending, event];

  const first = pending[firstIndex];
  const firstTransition = first.details.transition;
  const nextTransition = event.details.transition;
  const withoutLaterSameKind = pending.filter(
    (candidate, index) => candidate.kind !== event.kind || index === firstIndex,
  );
  return firstTransition === nextTransition
    ? withoutLaterSameKind
    : [...withoutLaterSameKind, event];
}

/**
 * 조건 관측값의 전이만 pending queue에 추가한다.
 *
 * @param {SentinelState} state
 * @param {Record<SentinelAlertKind, SentinelCondition>} conditions
 * @param {string} nowIso
 * @param {() => string} [createId]
 * @returns {SentinelState}
 */
export function applyConditionTransitions(
  state,
  conditions,
  nowIso,
  createId = randomUUID,
) {
  /** @type {SentinelState} */
  const next = {
    version: STATE_VERSION,
    observed: { ...state.observed },
    pending: [...state.pending],
    lastCycleAt: nowIso,
  };

  for (const kind of SENTINEL_KINDS) {
    const condition = conditions[kind];
    const previous = next.observed[kind];
    next.observed[kind] = condition.firing;
    if ((previous === null && !condition.firing) || previous === condition.firing) {
      continue;
    }
    const transition = condition.firing ? 'firing' : 'recovered';
    next.pending = enqueueConditionEvent(next.pending, {
      id: createId(),
      kind,
      severity: condition.firing ? 'critical' : 'warning',
      sourceType: 'host_monitor',
      sourceId: kind === 'backup_stale' ? 'backup' : 'host-disk',
      summary: fixedSummary(kind, transition),
      details: { ...condition.details, transition },
      occurredAt: nowIso,
    });
  }
  return next;
}

/**
 * @param {SentinelAlertEnvelope} alert
 */
function sanitizeSentinelAlert(alert) {
  const transition =
    alert.details.transition === 'recovered' ? 'recovered' : 'firing';
  const allowedKeys =
    alert.kind === 'backup_stale'
      ? new Set([
          'transition',
          'observedAgeSeconds',
          'maxAgeSeconds',
          'errorCode',
        ])
      : alert.kind === 'disk_low'
        ? new Set([
            'transition',
            'availableBytes',
            'totalBytes',
            'availablePercent',
            'minFreeBytes',
            'minFreePercent',
            'errorCode',
          ])
        : new Set(['transition', 'test']);
  /** @type {Record<string, string | number | boolean | null>} */
  const details = {};
  for (const [key, value] of Object.entries(alert.details)) {
    if (!allowedKeys.has(key)) continue;
    if (key === 'transition') {
      details[key] = transition;
    } else if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      value === null ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      details[key] =
        typeof value === 'string'
          ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256)
          : value;
    }
  }

  const kind = alert.kind;
  const isTest = kind === 'receiver_test';
  const occurredAtMs = Date.parse(alert.occurredAt);
  return {
    id:
      alert.id.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 128) ||
      'invalid-alert-id',
    kind,
    severity: isTest ? 'warning' : transition === 'firing' ? 'critical' : 'warning',
    sourceType: isTest ? 'synthetic_probe' : 'host_monitor',
    sourceId: isTest
      ? 'receiver'
      : kind === 'backup_stale'
        ? 'backup'
        : 'host-disk',
    summary: isTest
      ? 'external alert receiver synthetic test'
      : fixedSummary(kind, transition),
    details,
    occurredAt: Number.isFinite(occurredAtMs)
      ? new Date(occurredAtMs).toISOString()
      : 'invalid-timestamp',
  };
}

/**
 * @param {SentinelAlertEnvelope} alert
 * @param {WebhookFormat} format
 * @returns {Record<string, unknown>}
 */
export function buildSentinelWebhookPayload(alert, format) {
  const sanitized = sanitizeSentinelAlert(alert);
  if (format === 'slack') {
    const severity = sanitized.severity === 'critical' ? 'CRITICAL' : 'WARNING';
    return {
      text:
        `[subinary ${severity}] ${sanitized.summary}\n` +
        `kind=${sanitized.kind} transition=${String(sanitized.details.transition ?? 'firing')} ` +
        `occurredAt=${sanitized.occurredAt}`,
    };
  }
  return { schemaVersion: 'operational-alert-v1', alert: sanitized };
}

/**
 * pending alert를 순서대로 전달한다. 응답 본문은 읽지 않는다.
 *
 * @param {SentinelState} state
 * @param {SentinelConfig} config
 * @param {{
 *   fetch?: typeof fetch,
 *   onDelivered?: (state: SentinelState) => Promise<void>,
 * }} [adapters]
 * @returns {Promise<SentinelState>}
 */
export async function deliverPendingAlerts(state, config, adapters = {}) {
  if (!config.enabled || config.webhookUrl === null) return state;
  const fetchFn = adapters.fetch ?? fetch;
  /** @type {SentinelState} */
  const next = {
    ...state,
    observed: { ...state.observed },
    pending: [...state.pending],
  };
  while (next.pending.length > 0) {
    const alert = next.pending[0];
    const headers = { 'content-type': 'application/json' };
    if (config.bearerToken) {
      headers.authorization = `Bearer ${config.bearerToken}`;
    }
    const response = await fetchFn(config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildSentinelWebhookPayload(alert, config.format)),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) {
      const family = Math.floor(response.status / 100);
      throw new Error(`WebhookHttp${family}xx`);
    }
    next.pending.shift();
    await adapters.onDelivered?.(next);
  }
  return next;
}

/**
 * @param {unknown} value
 * @returns {value is SentinelState}
 */
function isSentinelState(value) {
  if (!value || typeof value !== 'object') return false;
  const candidate = value;
  return (
    candidate.version === STATE_VERSION &&
    candidate.observed &&
    typeof candidate.observed === 'object' &&
    [true, false, null].includes(candidate.observed.backup_stale) &&
    [true, false, null].includes(candidate.observed.disk_low) &&
    Array.isArray(candidate.pending) &&
    candidate.pending.length <= MAX_PENDING_ALERTS &&
    candidate.pending.every(isPersistedSentinelAlert) &&
    (candidate.lastCycleAt === null || typeof candidate.lastCycleAt === 'string')
  );
}

/**
 * @param {unknown} value
 * @returns {value is SentinelAlertEnvelope}
 */
function isPersistedSentinelAlert(value) {
  if (!value || typeof value !== 'object') return false;
  const candidate = value;
  return (
    typeof candidate.id === 'string' &&
    (candidate.kind === 'backup_stale' || candidate.kind === 'disk_low') &&
    typeof candidate.details === 'object' &&
    candidate.details !== null &&
    typeof candidate.occurredAt === 'string' &&
    Number.isFinite(Date.parse(candidate.occurredAt))
  );
}

/**
 * @param {string} stateFile
 * @param {typeof readFile} [readFileFn]
 */
async function loadSentinelState(stateFile, readFileFn = readFile) {
  try {
    const parsed = JSON.parse(await readFileFn(stateFile, 'utf8'));
    return isSentinelState(parsed) ? parsed : createInitialSentinelState();
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT' || error instanceof SyntaxError) {
      return createInitialSentinelState();
    }
    throw error;
  }
}

/**
 * @param {string} stateFile
 * @param {SentinelState} state
 * @param {{ mkdir?: typeof mkdir, writeFile?: typeof writeFile, rename?: typeof rename }} [adapters]
 */
async function saveSentinelState(stateFile, state, adapters = {}) {
  const mkdirFn = adapters.mkdir ?? mkdir;
  const writeFileFn = adapters.writeFile ?? writeFile;
  const renameFn = adapters.rename ?? rename;
  await mkdirFn(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFileFn(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await renameFn(temporary, stateFile);
}

/**
 * 측정→전이 저장→pending 전달의 한 cycle을 실행한다.
 *
 * @param {SentinelConfig} config
 * @param {{
 *   nowMs?: () => number,
 *   readFile?: typeof readFile,
 *   statfs?: typeof statfs,
 *   fetch?: typeof fetch,
 *   saveState?: (state: SentinelState) => Promise<void>,
 *   loadState?: () => Promise<SentinelState>,
 * }} [adapters]
 */
export async function runSentinelCycle(config, adapters = {}) {
  const nowMs = adapters.nowMs?.() ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const loadState =
    adapters.loadState ??
    (() => loadSentinelState(config.stateFile, adapters.readFile));
  const saveState =
    adapters.saveState ??
    ((state) => saveSentinelState(config.stateFile, state));
  const state = await loadState();
  const conditions = await collectSentinelConditions(config, {
    nowMs: () => nowMs,
    readFile: adapters.readFile,
    statfs: adapters.statfs,
  });
  let next = applyConditionTransitions(state, conditions, nowIso);
  await saveState(next);
  next = await deliverPendingAlerts(next, config, {
    fetch: adapters.fetch,
    onDelivered: saveState,
  });
  return {
    enabled: config.enabled,
    pending: next.pending.length,
    backupStale: conditions.backup_stale.firing,
    diskLow: conditions.disk_low.firing,
  };
}

/**
 * @param {SentinelConfig} config
 */
async function sendSyntheticTest(config) {
  if (!config.enabled) {
    throw new SentinelConfigError(
      'PIPELINE_ALERT_WEBHOOK_URL is required for send-test',
    );
  }
  const state = createInitialSentinelState();
  state.pending.push({
    id: randomUUID(),
    kind: 'receiver_test',
    severity: 'warning',
    sourceType: 'synthetic_probe',
    sourceId: 'receiver',
    summary: 'external alert receiver synthetic test',
    details: { transition: 'firing', test: true },
    occurredAt: new Date().toISOString(),
  });
  await deliverPendingAlerts(state, config);
}

/**
 * @param {SentinelConfig} config
 */
async function assertHealthy(config) {
  const state = await loadSentinelState(config.stateFile);
  if (!state.lastCycleAt) throw new Error('SentinelHeartbeatMissing');
  const heartbeatMs = Date.parse(state.lastCycleAt);
  const maximumAgeMs = Math.max(config.intervalMs * 3, 180_000);
  if (!Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > maximumAgeMs) {
    throw new Error('SentinelHeartbeatStale');
  }
}

/** @param {unknown} error */
function errorCode(error) {
  if (error instanceof SentinelConfigError) return error.code;
  if (error instanceof Error && error.message.startsWith('WebhookHttp')) {
    return error.message;
  }
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

/**
 * 외부 dead-man's-switch(healthchecks.io 등)에 하트비트를 보낸다. 성공 사이클마다 base URL로,
 * 사이클 실패 시 `${url}/fail`로 POST한다. ops-sentinel(맥 안)이 통째로 죽으면 핑이 끊겨 맥 밖에서 감지된다.
 * 생존 신호일 뿐이므로 best-effort다 — 전송 실패는 절대 감시 루프를 중단시키지 않고 삼킨다(다음 사이클 재시도).
 * backup 서비스의 HEALTHCHECK_PING_URL과 동일한 규약(성공=base, 실패=/fail).
 * @param {SentinelConfig} config
 * @param {boolean} ok 직전 사이클 성공 여부
 * @param {{ fetch?: typeof fetch }} [adapters]
 * @returns {Promise<boolean>} 핑 성공 여부(테스트용)
 */
export async function pingHeartbeat(config, ok, adapters = {}) {
  if (!config.heartbeatUrl) return false;
  const fetchFn = adapters.fetch ?? fetch;
  const url = ok ? config.heartbeatUrl : `${config.heartbeatUrl}/fail`;
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    return response.ok === true;
  } catch {
    return false;
  }
}

/** @param {number} milliseconds @param {AbortSignal} signal */
function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function main() {
  const config = parseSentinelConfig(process.env);
  const command = process.argv[2] ?? 'daemon';
  if (command === 'send-test') {
    await sendSyntheticTest(config);
    console.log(JSON.stringify({ event: 'receiver_test_delivered' }));
    return;
  }
  if (command === 'once') {
    console.log(JSON.stringify(await runSentinelCycle(config)));
    return;
  }
  if (command === 'healthcheck') {
    await assertHealthy(config);
    return;
  }
  if (command !== 'daemon') {
    throw new SentinelConfigError(
      'command must be daemon, once, send-test, or healthcheck',
    );
  }

  console.log(
    JSON.stringify({
      event: 'ops_sentinel_started',
      enabled: config.enabled,
      format: config.format,
      intervalMs: config.intervalMs,
    }),
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!controller.signal.aborted) {
    try {
      const summary = await runSentinelCycle(config);
      console.log(JSON.stringify({ event: 'ops_sentinel_cycle', ...summary }));
      // 성공 사이클 = 감시가 실제로 돌았다는 생존 신호. 경보 발화 여부와 무관하게 핑(sentinel은 정상 동작).
      await pingHeartbeat(config, true);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'ops_sentinel_cycle_failed',
          errorCode: errorCode(error),
        }),
      );
      // 사이클 자체 실패(측정 오류 등) → /fail 핑으로 외부 DMS 즉시 경보.
      await pingHeartbeat(config, false);
    }
    await wait(config.intervalMs, controller.signal);
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error) => {
    console.error(
      JSON.stringify({ event: 'ops_sentinel_failed', errorCode: errorCode(error) }),
    );
    process.exitCode = error instanceof SentinelConfigError ? 64 : 1;
  });
}
