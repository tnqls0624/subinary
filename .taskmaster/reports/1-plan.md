# 구현 계획 - Task 1

**생성일**: 2026-07-19
**태스크**: 외부 운영 경보 수신 채널 연결
**담당**: Codex

## 1. 개요

| 항목 | 값 |
|------|-----|
| 태스크 ID | 1 |
| 복잡도 | Standard |
| 우선순위 | High |
| 의존 태스크 | 없음 |
| 예상 변경량 | 100라인 초과 — Phase A/B/C로 분할 |

### 목적

기존 application outbox dispatcher를 유지하면서 외부 payload의 PII 신뢰 경계를 강화하고, 동일 Mac의
backup stale·disk low를 감지하는 최소 권한 sentinel을 같은 receiver에 연결할 수 있게 한다. Mac/tunnel
전체 다운은 Cloudflare 외부 notification이 담당하도록 운영 경계를 확정한다.

### 범위

- 포함: generic/Slack payload sanitization, local ops sentinel, Compose hardening, synthetic receiver probe,
  Cloudflare Tunnel Health 설정 runbook, 단위·격리 테스트
- 제외: DB enum/migration, 실제 receiver 계정 생성, Cloudflare dashboard/API 변경, application SLO monitor
  제품 선정(Task 16), 운영 Compose 재기동

## 2. 파일 변경 계획

### 생성할 파일

| 파일 | 목적 | 예상 라인 수 |
|------|------|-------------|
| `infrastructure/ops-sentinel/ops-sentinel.mjs` | backup/disk 측정, 상태 전이, retry, webhook 전달 CLI/daemon | ~350 |
| `infrastructure/ops-sentinel/ops-sentinel.verify.mjs` | Node test runner 기반 Happy/Edge/Error 단위 테스트 | ~280 |
| `infrastructure/ops-sentinel/Dockerfile` | Node built-in 전용 non-root 최소 이미지 | ~25 |
| `docs/adr/0022-external-operational-alert-boundary.md` | app outbox/local sentinel/Cloudflare 책임 경계 ADR | ~80 |

### 수정할 파일

| 파일 | 변경 내용 | 영향 범위 |
|------|----------|----------|
| `packages/shared/src/operational-alert.ts` | local alert kind와 kind별 safe detail projection 추가 | shared webhook contract |
| `packages/shared/src/operational-alert.test.ts` | unknown/nested/secret detail 제거와 신규 kind 테스트 | shared tests |
| `docker-compose.prod.yml` | hardened `ops-sentinel`, egress-only network, read-only backup/state volume 추가 | production config |
| `package.json` | sentinel 단위 검증과 실제 receiver probe 명령 추가 | root scripts |
| `.env.example` | sentinel interval/threshold 설정 예시 추가 | operator config |
| `docs/operations/ai-pipeline-alerting.md` | receiver 연결·synthetic probe·Cloudflare host-down·recovery runbook | operations docs |
| `docs/production-deploy.md` | 운영 체크리스트에 sentinel/Cloudflare alert gate 추가 | deploy docs |
| `scripts/ops/verify-ai-pipeline-infrastructure.sh` | sentinel 실행 상태와 URL 미설정 경계를 표시 | infra verification |

### 삭제할 파일

없음.

## 3. 타입·스키마 정의

### 공용 TypeScript 계약

```ts
export type OperationalAlertKind =
  | 기존 4개 kind
  | 'backup_stale'
  | 'disk_low';

export type OperationalAlertTransition = 'firing' | 'recovered';

export function sanitizeOperationalAlertEnvelope(
  alert: OperationalAlertEnvelope,
): OperationalAlertEnvelope;
```

- `details`는 kind별 allowlist에 있는 scalar(`string | number | boolean | null`)만 보존한다.
- 문자열은 제어문자 제거와 길이 상한을 적용한다.
- unknown key, object, array, `token`, `secret`, `raw`, `payload` 계열은 제거한다.
- generic과 Slack 모두 sanitization 이후 payload를 만든다.

### Sentinel JSDoc 계약

```js
/** @typedef {'backup_stale'|'disk_low'} SentinelAlertKind */
/** @typedef {'firing'|'recovered'} SentinelTransition */
/** @typedef {{ version: 1, observed: Record<SentinelAlertKind, boolean>, pending: AlertEnvelope[] }} SentinelState */

export function parseSentinelConfig(env) {}
export async function collectSentinelConditions(config, adapters) {}
export function applyConditionTransitions(state, conditions, now) {}
export async function deliverPendingAlerts(state, config, adapters) {}
export async function runSentinelCycle(config, adapters) {}
```

외부 설정:

- `PIPELINE_ALERT_WEBHOOK_URL`, `PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN`, `PIPELINE_ALERT_WEBHOOK_FORMAT`
- `OPS_SENTINEL_INTERVAL_MS` 기본 60000, 최소 30000
- `OPS_SENTINEL_REQUEST_TIMEOUT_MS` 기본 5000
- `OPS_SENTINEL_BACKUP_MAX_AGE_SECONDS` 기본 90000
- `OPS_SENTINEL_DISK_MIN_FREE_BYTES` 기본 42949672960(40GiB)
- `OPS_SENTINEL_DISK_MIN_FREE_PERCENT` 기본 10

## 4. 구현 순서

### Phase A — 공용 webhook PII 경계

#### A1. RED 테스트

- generic payload에서 unknown `userId`, `rawText`, `secret`, nested object가 제거되는 테스트를 먼저 작성한다.
- 허용된 pipeline/quarantine/canary 집계가 유지되는지 작성한다.
- backup/disk firing/recovered detail만 유지되는지 작성한다.
- 기존 Slack markup escape와 retry 테스트를 보존한다.

검증:

```bash
pnpm --filter @family/shared test -- operational-alert.test.ts
```

새 테스트가 구현 전 실패하는 것을 확인한다.

#### A2. GREEN 구현

- kind별 `ReadonlySet<string>` allowlist와 scalar projection을 구현한다.
- generic/Slack builder 시작점에서 sanitize한다.
- 공개 함수에 JSDoc을 작성하고 명시적 타입을 사용한다.

검증:

```bash
pnpm --filter @family/shared test -- operational-alert.test.ts
pnpm --filter @family/shared typecheck
```

### Phase B — 최소 권한 local ops sentinel

#### B1. 인터페이스와 RED 테스트

- 설정 parsing, backup age, `statfs` BigInt disk 계산, initial/firing/recovered transition, dedupe, retry queue,
  corrupted state, timeout, HTTP 4xx/5xx, URL 미설정 disabled 상태 테스트를 먼저 작성한다.
- filesystem, clock, random UUID, fetch를 adapter로 주입해 실제 운영 파일/네트워크 없이 테스트한다.

검증:

```bash
node --test infrastructure/ops-sentinel/ops-sentinel.verify.mjs
```

#### B2. GREEN 구현

- Node.js built-in만 사용해 sentinel daemon과 `send-test`, `once`, `healthcheck` 명령을 구현한다.
- condition 전이를 state에 atomic write한 뒤 네트워크 전송한다.
- 성공한 pending event만 제거하고 실패 시 다음 cycle에 재시도한다.
- URL/token/response body/path는 로그하지 않고 error code와 kind/transition만 기록한다.
- invalid config는 exit 64, state/file I/O는 명확한 code로 실패한다.

#### B3. Container/Compose hardening

- pinned Node image, `USER node`, read-only rootfs, `/state` named volume, backup bind read-only를 적용한다.
- `cap_drop: ALL`, `no-new-privileges`, PID/CPU/memory 제한을 적용한다.
- DB/Redis/MinIO/Docker socket과 전체 `.env`를 전달하지 않는다.
- 외부 송신 전용 bridge network만 연결한다.
- URL 미설정 시 공개 서비스에 영향을 주지 않고 disabled heartbeat를 유지한다.

검증:

```bash
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml config
docker build -f infrastructure/ops-sentinel/Dockerfile -t subinary/ops-sentinel:test .
docker run --rm subinary/ops-sentinel:test node --test /app/ops-sentinel.verify.mjs
```

### Phase C — 운영 검증·문서·ADR

- root scripts에 local test와 실제 `send-test` 명령을 추가한다.
- infra verify는 sentinel container 상태와 webhook configured 여부를 secret 없이 표시한다.
- 문서에 generic `alert.id` 멱등 계약, Slack 설정, timeout/retry, firing/recovered, actual test alert 확인,
  Cloudflare Tunnel Health notification(email/webhook) 구성과 장애 도메인 경계를 기록한다.
- ADR에 application outbox만 durable DB path이고 local sentinel은 condition-persistent retry path임을 기록한다.
- GitHub Actions schedule은 5분 host-down 주 감시자로 사용하지 않는 이유를 기록한다.

검증:

```bash
pnpm test:operational-alerting
pnpm typecheck
pnpm build
sh scripts/ops/verify-ai-pipeline-infrastructure.sh
```

실제 receiver URL이 없으므로 `send-test`는 이번 자동 검증에서 실행하지 않는다. URL 제공 후 운영자가 명시적으로
실행하고 수신 시각·payload를 확인한다.

## 5. 테스트 전략

### Happy path

1. 허용된 application detail만 generic payload에 유지된다.
2. fresh backup과 충분한 disk에서 event가 없다.
3. backup age 초과 시 firing 1건이 enqueue·전달된다.
4. disk free threshold 미달 시 firing 1건이 전달된다.
5. 상태 회복 시 recovered 1건이 전달된다.
6. generic/Slack payload가 각각 수신된다.

### Edge case

1. 정확히 threshold인 backup age/disk percent/bytes 경계
2. 0 blocks, BigInt 큰 filesystem 값
3. 첫 실행부터 정상인 상태에서 recovered를 보내지 않음
4. 두 condition 동시 firing과 전송 순서
5. daemon 재시작 후 동일 condition 중복 없음
6. pending event가 있는 동안 condition이 회복되어 firing→recovered 순서 보존

### Error case

1. missing/invalid `.last-success`
2. state JSON 손상과 atomic write 실패
3. invalid URL/protocol/format/numeric config
4. webhook timeout, fetch network error, HTTP 4xx/5xx
5. URL 미설정 상태에서 secret 출력 없이 disabled
6. payload에 PII/secret/원문/nested object 삽입 시 제거

## 6. 에러 처리·보안·롤백

- 설정 오류: `SentinelConfigError`, exit 64, key 이름만 출력
- 측정 오류: 해당 condition을 경보 가능한 실패로 취급하되 민감 경로/본문 미로그
- 전송 오류: HTTP status family 또는 Error name만 state/log에 기록하고 pending 유지
- state 오류: 손상 파일을 민감 내용 없이 격리하고 새 state로 재평가
- rollback: Compose에서 `ops-sentinel` 서비스와 volume 참조를 제거하면 기존 API outbox 경로는 그대로 유지된다.
- 실제 deploy 전에는 `docker compose config`, unit test, image inspect를 통과해야 한다.

## 7. 체크리스트

- [ ] Phase A RED 확인
- [ ] Phase A GREEN/typecheck 통과
- [ ] Phase B RED 확인
- [ ] Phase B GREEN 테스트 통과
- [ ] container non-root/read-only/제한 검증
- [ ] Compose config 통과
- [ ] 문서·ADR 업데이트
- [ ] 전체 typecheck/build 회귀 검증
- [ ] 실제 receiver URL secret 주입
- [ ] synthetic test alert 외부 수신 확인
- [ ] Cloudflare Tunnel Health notification 활성화 확인

## 8. 완료 경계

코드 완료 조건은 unit/typecheck/build/Compose 검증 통과다. Task Master `done` 처리는 여기에 더해 실제 외부
receiver의 synthetic alert 수신과 Cloudflare Tunnel Health notification 활성화 증거가 필요하다. 현재 URL이
없으므로 구현 리뷰는 완료할 수 있지만 Task 자체는 실제 운영 입력 전까지 `in-progress`로 유지한다.

## 자체 계획 검토

현재 도구 목록에 context7와 sequential-thinking MCP가 없어 호출하지 못했다. 대신 저장소의 실제 interface,
Node runtime capability, 공식 Cloudflare 문서와 실패 시나리오를 대조했다. DB migration을 피하고 외부 credential을
코드와 분리해 현재 사용자 작업과 운영 서비스의 회귀 위험을 낮췄다.
