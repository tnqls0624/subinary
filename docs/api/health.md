# Health / Dev API 명세

> Phase 0 기준. 계약 스키마의 단일 소스는 `@family/contracts`(zod)이며, 본 문서는 예시다.
> 모든 NestJS 앱(api/worker)은 전역 prefix `v1`을 사용한다. 타임스탬프는 ISO 8601 문자열이다.

## 포트 요약

| 서비스 | Base URL (호스트) | 헬스 엔드포인트 |
|---|---|---|
| api | `http://localhost:3001` | `GET /v1/health/live`, `GET /v1/health/ready` |
| worker | `http://localhost:3002` | `GET /v1/health/live`, `GET /v1/health/ready` |
| web | `http://localhost:3000` | `GET /api/health` |

---

## 1. Health — api (port 3001)

### `GET /v1/health/live`

Liveness 프로브. **의존성을 검사하지 않고** 프로세스 생존만 확인한다. Docker healthcheck가 사용한다.

```bash
curl -s http://localhost:3001/v1/health/live
```

응답 `200 OK` (`livezResponseSchema`):

```json
{
  "status": "ok",
  "service": "api",
  "timestamp": "2026-07-15T03:12:45.123Z"
}
```

### `GET /v1/health/ready`

Readiness 프로브. **db / pgvector / redis / storage** 4개 의존성을 병렬로 검사한다.

```bash
curl -s http://localhost:3001/v1/health/ready
```

모두 정상일 때 응답 `200 OK` (`readyzResponseSchema`):

```json
{
  "status": "ok",
  "service": "api",
  "timestamp": "2026-07-15T03:12:45.456Z",
  "checks": [
    { "name": "db",       "status": "up", "latencyMs": 4 },
    { "name": "pgvector", "status": "up", "latencyMs": 3 },
    { "name": "redis",    "status": "up", "latencyMs": 1 },
    { "name": "storage",  "status": "up", "latencyMs": 12 }
  ]
}
```

하나라도 실패하면 응답 `503 Service Unavailable` + `status: "degraded"`:

```json
{
  "status": "degraded",
  "service": "api",
  "timestamp": "2026-07-15T03:12:45.456Z",
  "checks": [
    { "name": "db",       "status": "up",   "latencyMs": 4 },
    { "name": "pgvector", "status": "up",   "latencyMs": 3 },
    { "name": "redis",    "status": "down", "detail": "connection refused", "latencyMs": 502 },
    { "name": "storage",  "status": "up",   "latencyMs": 12 }
  ]
}
```

check 항목 스키마 (`healthCheckItemSchema`):

| 필드 | 타입 | 비고 |
|---|---|---|
| `name` | `string` | `db` \| `pgvector` \| `redis` \| `storage` (api 기준) |
| `status` | `'up' \| 'down'` | |
| `detail` | `string?` | 실패 사유 등 (Secret/개인정보 미포함) |
| `latencyMs` | `number?` | 검사 소요 시간 |

---

## 2. Health — worker (port 3002)

### `GET /v1/health/live`

```bash
curl -s http://localhost:3002/v1/health/live
```

응답 `200 OK`:

```json
{
  "status": "ok",
  "service": "worker",
  "timestamp": "2026-07-15T03:12:45.123Z"
}
```

### `GET /v1/health/ready`

worker는 **redis + db** 2개 의존성을 검사한다.

```bash
curl -s http://localhost:3002/v1/health/ready
```

응답 `200 OK` (실패 시 `503` + `degraded`, api와 동일 규칙):

```json
{
  "status": "ok",
  "service": "worker",
  "timestamp": "2026-07-15T03:12:45.456Z",
  "checks": [
    { "name": "redis", "status": "up", "latencyMs": 1 },
    { "name": "db",    "status": "up", "latencyMs": 4 }
  ]
}
```

---

## 3. Health — web (port 3000)

### `GET /api/health`

Docker healthcheck 전용. api에 의존하지 않는다.

```bash
curl -s http://localhost:3000/api/health
```

응답 `200 OK`:

```json
{
  "status": "ok",
  "service": "web",
  "timestamp": "2026-07-15T03:12:45.123Z"
}
```

---

## 4. Dev 엔드포인트 — api (port 3001)

> `NODE_ENV !== 'production'`일 때만 `DevModule`이 로드된다. **프로덕션에는 존재하지 않는다.**

### `POST /v1/dev/echo`

요청 body를 그대로 반환한다.

```bash
curl -s -X POST http://localhost:3001/v1/dev/echo \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world","n":1}'
```

응답 `2xx`:

```json
{ "hello": "world", "n": 1 }
```

### `POST /v1/dev/test-job`

BullMQ `test` 큐(`QUEUE_NAMES.TEST`)에 테스트 잡을 등록한다. worker의 `TestProcessor`가 소비한다.

```bash
curl -s -X POST http://localhost:3001/v1/dev/test-job
```

응답 `2xx` (`testJobEnqueueResponseSchema`):

```json
{
  "jobId": "1",
  "queue": "test",
  "status": "queued"
}
```

### `GET /v1/dev/test-job/:id`

잡 상태/결과를 조회한다.

```bash
curl -s http://localhost:3001/v1/dev/test-job/1
```

응답 `200 OK` (`testJobStatusResponseSchema`) — 처리 완료 시:

```json
{
  "jobId": "1",
  "state": "completed",
  "result": {
    "processedAt": "2026-07-15T03:12:46.001Z",
    "echo": { "at": "2026-07-15T03:12:45.900Z" }
  }
}
```

처리 실패 시 예:

```json
{
  "jobId": "1",
  "state": "failed",
  "failedReason": "..."
}
```

`state`는 BullMQ 상태 문자열(`waiting`/`active`/`completed`/`failed` 등)이다.

### `POST /v1/dev/storage-test`

MinIO(S3 호환)에 랜덤 key로 put → get 왕복을 수행한다.

```bash
curl -s -X POST http://localhost:3001/v1/dev/storage-test
```

응답 `2xx` (`storageTestResponseSchema`):

```json
{
  "ok": true,
  "bucket": "family-memory",
  "key": "dev-test/1a2b3c4d5e.txt",
  "roundTripMs": 23
}
```

---

## 5. 검증 시나리오 (스펙 §9 요약)

`docker compose up --build` 후:

```bash
curl -s http://localhost:3001/v1/health/live     # 1) api liveness
curl -s http://localhost:3001/v1/health/ready    # 2) db/pgvector/redis/storage 모두 up
curl -s http://localhost:3002/v1/health/ready    # 3) worker: redis/db up
curl -s -X POST http://localhost:3001/v1/dev/test-job          # 4) jobId 획득
curl -s http://localhost:3001/v1/dev/test-job/<jobId>          #    state=completed 확인
curl -s -X POST http://localhost:3001/v1/dev/storage-test      # 5) {"ok":true}
curl -s http://localhost:3000/api/health         # 6) web healthcheck
```

관련 문서: [아키텍처 개요](../architecture/overview.md) · [Phase 0 빌드 스펙](../phase0-build-spec.md)
