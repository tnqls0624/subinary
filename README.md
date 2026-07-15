# Family Memory AI

가족의 기록(대화, 소비, 일정, 추억)을 안전하게 축적하고 AI로 검색·요약하는 **모듈러 모놀리스** 서비스입니다.
Phase 0는 그 기반 골격으로, pnpm + Turborepo 모노레포 위에 NestJS(Fastify) API/Worker, Next.js Web,
PostgreSQL(pgvector), Redis(BullMQ), MinIO(S3 호환)를 `docker compose up` 한 번으로 전부 기동합니다.
AI 모델은 비종속 인터페이스(`LlmProvider`/`EmbeddingProvider`/`RerankerProvider`) + Mock 구현만 배치하며,
Phase 0에서는 LLM을 호출하지 않습니다. 기본 Timezone은 `Asia/Seoul`, 금액은 KRW 정수로 다룹니다.

## Quick Start

```bash
# 1) 환경변수 준비 (dev 기본값 그대로 동작)
cp .env.example .env

# 2) 전체 스택 기동
docker compose up --build
```

> 최초 빌드는 `pnpm-lock.yaml`이 필요합니다(`--frozen-lockfile`). lockfile이 없다면 호스트 Node 없이 생성할 수 있습니다:
>
> ```bash
> docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim \
>   sh -c "corepack enable && pnpm install --lockfile-only"
> ```

선택: 리버스 프록시(Caddy) 포함 기동은 `docker compose --profile proxy up`.

### 개발 시 주의

- 컨테이너에는 `apps/*/src` 만 바인드마운트됩니다(소스 핫리로드).
  `package.json`, `tsconfig`, `next.config.ts` 등 **설정 파일 변경 시** `docker compose up --build` 로 재빌드하세요.
- `packages/*` 는 이미지 빌드 시 dist로 컴파일됩니다. 패키지 코드 변경 시에도 `--build` 가 필요합니다.

## 포트

| 서비스 | 컨테이너 포트 | 호스트 포트 | 헬스 |
|---|---|---|---|
| web (Next.js) | 3000 | 3000 | `GET /api/health` |
| api (NestJS) | 3001 | 3001 | `GET /v1/health/live` |
| worker (NestJS) | 3002 | 3002 | `GET /v1/health/live` |
| postgres | 5432 | 5432 | `pg_isready` |
| redis | 6379 | 6379 | `redis-cli ping` |
| minio (S3) | 9000 | 9000 | (minio-setup 완료로 대체) |
| minio (console) | 9001 | 9001 | — |
| caddy (profile: proxy) | 80/443 | 80/443 | — |

## 검증

`docker compose up --build` 완료 후:

```bash
# 1. api liveness
curl http://localhost:3001/v1/health/live
# → 200 {"status":"ok","service":"api","timestamp":"..."}

# 2. api readiness — db/pgvector/redis/storage 모두 up
curl http://localhost:3001/v1/health/ready

# 3. worker readiness — redis/db up
curl http://localhost:3002/v1/health/ready

# 4. BullMQ end-to-end (enqueue → 처리 확인)
curl -X POST http://localhost:3001/v1/dev/test-job
# → {"jobId":"...","queue":"test","status":"queued"}
curl http://localhost:3001/v1/dev/test-job/<jobId>
# → {"jobId":"...","state":"completed","result":{...}}

# 5. MinIO put→get 왕복
curl -X POST http://localhost:3001/v1/dev/storage-test
# → {"ok":true,"bucket":"family-memory","key":"...","roundTripMs":...}

# 6. web 대시보드 + 헬스
open http://localhost:3000
curl http://localhost:3000/api/health

# 7. pgvector 확장 확인
docker compose exec postgres psql -U family -d family_memory \
  -c "select extname from pg_extension where extname='vector'"
```

## 구조

```
apps/        api(3001) · worker(3002) · web(3000) · mcp(Phase 10 자리표시자)
packages/    @family/config · shared · contracts · ai-providers · database
infrastructure/  docker(Dockerfile.dev) · postgres/init · minio · caddy
docs/        architecture · adr · api · phase0-build-spec.md
```

## Phase 로드맵

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 모노레포 기반, compose 스택, health/dev 엔드포인트, AI 경계(Mock) | ✅ 본 저장소 |
| 1+ | 도메인 스키마(가족/기록), 가족 초대, 장치 HMAC | 예정 |
| … | 카드 문자 Parser, Slack 연동, RAG / GraphRAG | 예정 |
| 10 | MCP 서버 (`apps/mcp`) | 예정 |

- 상세 스펙: [docs/phase0-build-spec.md](docs/phase0-build-spec.md)
- 아키텍처 개요: [docs/architecture/overview.md](docs/architecture/overview.md)
- ADR: [docs/adr/](docs/adr/)
- Health API: [docs/api/health.md](docs/api/health.md)
