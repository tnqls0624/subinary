# Phase 0 Build Spec — Family Memory AI Monorepo

> 이 문서는 Phase 0(프로젝트 기반) 구현의 **단일 진실 소스(SSOT)** 다.
> 모든 파일은 이 스펙과 **정확히** 일치해야 한다. 버전, 패키지명, export 시그니처, 포트, 환경변수를 임의로 바꾸지 않는다.

---

## 0. 설계 원칙 (Phase 0에 직접 적용)

- 모듈러 모놀리스. `docker compose up`으로 전체가 안정적으로 실행되는 기반까지만.
- **이번 단계에서 구현하지 않음**: 가족 초대, 장치 HMAC, 카드 문자 Parser, Slack, RAG, GraphRAG, MCP.
- 모델 비종속: `LlmProvider/EmbeddingProvider/RerankerProvider` 인터페이스 + Mock 구현만 배치(경계 확보).
- 계산은 SQL/앱 로직. LLM은 Phase 0에서 호출하지 않음.
- 개인정보/Secret 로그 금지. 기본 Timezone `Asia/Seoul`. 금액은 KRW 정수.

---

## 1. 도구 & 버전 (고정)

- 패키지매니저: **pnpm** (workspaces). `packageManager: "pnpm@9.15.4"`.
- 태스크러너: **Turborepo** `^2.3.3`.
- 언어: **TypeScript** `^5.7.3`.
- Node(런타임/컨테이너): **Node 22 LTS** (`node:22-bookworm-slim`). 호스트 Node 버전과 무관.
- Backend: **NestJS 11** + **Fastify 5** 어댑터.
- Queue: **BullMQ 5** + **ioredis 5**, Nest 래퍼 `@nestjs/bullmq ^11`.
- DB: **PostgreSQL 17 (pgvector 이미지)**, ORM **drizzle-orm ^0.38** + **drizzle-kit ^0.30**, 드라이버 **postgres (postgres.js) ^3.4**.
- Object Storage: **@aws-sdk/client-s3 ^3** (MinIO=S3 호환, dev/prod 동일 클라이언트).
- Frontend: **Next.js 15** (App Router) + **React 19** + **@tanstack/react-query ^5**.
- 검증: **zod ^3.24**.
- 로깅: **pino ^9** + **pino-pretty ^13**(dev).
- 패키지 빌드: **tsup ^8** (dist: esm+cjs+dts).
- NestJS 빌드/실행: **@nestjs/cli ^11** + **@swc/core ^1.10** + **@swc/cli ^0.5** (`nest start -b swc`).
- 날짜: **date-fns ^4** + **date-fns-tz ^3**.

> 정확한 patch가 존재하지 않으면 해당 major/minor의 최신 안정 버전을 caret(`^`)으로 사용한다. major는 위 값을 지킨다.

---

## 2. 디렉터리 구조 (루트 = 현재 작업 디렉터리)

```
subinary/                     # 루트 (프로젝트명: family-memory-ai)
├── apps/
│   ├── api/                  # NestJS + Fastify (HTTP API), port 3001
│   ├── worker/               # NestJS + Fastify (BullMQ 프로세서 + health), port 3002
│   ├── web/                  # Next.js (App Router), port 3000
│   └── mcp/                  # Phase 10 자리표시자 (README만, 실행 서비스 아님)
├── packages/
│   ├── config/               # @family/config  (zod 환경변수 스키마/로더)
│   ├── shared/               # @family/shared  (logger, money, time, 상수, 공통 타입)
│   ├── contracts/            # @family/contracts (zod 스키마 + 추론 타입, API 계약)
│   ├── ai-providers/         # @family/ai-providers (LLM/Embedding/Reranker 인터페이스 + Mock)
│   └── database/             # @family/database (drizzle 클라이언트, 헬스체크 쿼리, 마이그레이션 툴링)
├── infrastructure/
│   ├── docker/               # Dockerfile.dev (공용 dev 이미지)
│   ├── postgres/init/        # 01-extensions.sql (pgvector, pg_trgm, timezone)
│   ├── minio/                # (설명 README; 버킷 생성은 compose의 minio-setup가 담당)
│   └── caddy/                # Caddyfile (reverse proxy, compose profile: proxy)
├── docs/
│   ├── architecture/overview.md
│   ├── adr/000{1..4}-*.md
│   ├── api/health.md
│   └── phase0-build-spec.md  # (본 문서)
├── docker-compose.yml
├── .env.example
├── .gitignore
├── .dockerignore
├── .npmrc
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── package.json              # 루트(private, workspaces 스크립트)
└── README.md
```

npm scope: **`@family/`**. 앱 패키지명: `@family/api`, `@family/worker`, `@family/web`.

---

## 3. 루트 파일

### `package.json` (root, private)
- `"private": true`, `"name": "family-memory-ai"`, `"packageManager": "pnpm@9.15.4"`.
- `engines.node: ">=22"`.
- scripts (turbo 위임):
  - `"build": "turbo run build"`
  - `"dev": "turbo run dev"`
  - `"lint": "turbo run lint"`
  - `"typecheck": "turbo run typecheck"`
  - `"build:packages": "turbo run build --filter=./packages/*"`
- devDependencies: `turbo`, `typescript`, `@types/node`.

### `pnpm-workspace.yaml`
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### `.npmrc`
```
auto-install-peers=true
strict-peer-dependencies=false
```
(node-linker 기본값 사용. Docker에서는 이미지 내 설치본을 쓰고 소스만 바인드마운트하므로 심링크 이슈 없음.)

### `turbo.json` (schema 2.x, `tasks` 키 사용)
- `build`: `dependsOn: ["^build"]`, `outputs: ["dist/**", ".next/**"]`
- `dev`: `cache: false`, `persistent: true`
- `lint`: `{}`
- `typecheck`: `dependsOn: ["^build"]`

### `tsconfig.base.json`
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "sourceMap": true
  }
}
```
(각 앱/패키지 tsconfig가 이를 extends 하고 필요한 override 적용. Next.js는 자체 tsconfig 규칙을 따르되 base를 extends.)

### `.gitignore`
node_modules, dist, .next, .turbo, .env, *.log, coverage, .DS_Store, build 산출물.

### `.dockerignore`
node_modules, **/node_modules, dist, .next, .turbo, .git, .env, *.log.

### `README.md`
프로젝트 개요(1문단) + Quick Start(`cp .env.example .env` → `docker compose up --build`) + 포트 표 + 검증 명령 + Phase 로드맵 링크.

---

## 4. 포트 맵

| 서비스 | 컨테이너 포트 | 호스트 포트 | 헬스 |
|---|---|---|---|
| web (Next.js) | 3000 | 3000 | `GET /api/health` |
| api (NestJS) | 3001 | 3001 | `GET /v1/health/live` |
| worker (NestJS) | 3002 | 3002 | `GET /v1/health/live` |
| postgres | 5432 | 5432 | `pg_isready` |
| redis | 6379 | 6379 | `redis-cli ping` |
| minio (S3) | 9000 | 9000 | (setup 컨테이너 완료로 대체) |
| minio (console) | 9001 | 9001 | — |
| caddy (profile: proxy) | 80/443 | 80/443 | — |

앱 컨테이너 헬스체크는 외부 도구 의존을 피해 **node fetch**로 수행:
`test: ["CMD","node","-e","fetch('http://localhost:PORT/PATH').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`

---

## 5. 환경변수 — `.env.example`

```dotenv
# --- App ---
NODE_ENV=development
TZ=Asia/Seoul
API_PORT=3001
WORKER_PORT=3002
WEB_PORT=3000

# --- PostgreSQL ---
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=family
POSTGRES_PASSWORD=family_dev_pw
POSTGRES_DB=family_memory
# 앱이 사용하는 연결 문자열(컨테이너 내부 네트워크 기준)
DATABASE_URL=postgresql://family:family_dev_pw@postgres:5432/family_memory

# --- Redis / BullMQ ---
REDIS_HOST=redis
REDIS_PORT=6379
BULLMQ_PREFIX=fma

# --- Object Storage (MinIO=S3 호환) ---
STORAGE_ENDPOINT=http://minio:9000
STORAGE_REGION=us-east-1
STORAGE_ACCESS_KEY=minioadmin
STORAGE_SECRET_KEY=minioadmin_dev_pw
STORAGE_BUCKET=family-memory
STORAGE_FORCE_PATH_STYLE=true

# --- Web (브라우저에서 API 접근; 호스트 published 포트) ---
NEXT_PUBLIC_API_URL=http://localhost:3001

# --- AI Providers (Phase 0는 mock) ---
AI_PROVIDER=mock
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
```

MinIO 컨테이너 자격증명은 `STORAGE_ACCESS_KEY/SECRET_KEY`를 `MINIO_ROOT_USER/PASSWORD`로 매핑.

---

## 6. packages 상세 (정확한 public export)

각 package는: `package.json`(tsup 빌드, exports dist), `tsconfig.json`(extends base, `outDir dist`, `rootDir src`), `tsup.config.ts`(`format:['esm','cjs'], dts:true, clean:true, sourcemap:true, entry:['src/index.ts']`), `src/index.ts`(배럴 export).

package.json 공통 형태:
```jsonc
{
  "name": "@family/<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs", "require": "./dist/index.js" } },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "lint": "echo 'lint: noop'"
  }
}
```

### 6.1 `@family/config`
deps: `zod`.
export:
- `const configSchema` — zod object. 구조(그룹):
  - `app: { nodeEnv: 'development'|'test'|'production', tz: string(default 'Asia/Seoul'), apiPort:number, workerPort:number, webPort:number }`
  - `database: { url: string }`
  - `redis: { host:string, port:number }`
  - `queue: { prefix:string }`
  - `storage: { endpoint:string, region:string, accessKey:string, secretKey:string, bucket:string, forcePathStyle:boolean }`
  - `ai: { provider: 'mock'|'openai'|'anthropic'|'google'(default 'mock') }`
- `type AppConfig = z.infer<typeof configSchema>`
- `function validateEnv(env: NodeJS.ProcessEnv): AppConfig` — env 문자열을 위 구조로 파싱/검증(coerce number/boolean), 실패 시 명확한 에러 throw.
- `function loadConfig(): AppConfig` — `validateEnv(process.env)`.

NestJS는 `ConfigModule.forRoot({ isGlobal:true, load:[() => loadConfig()] })` 로 사용. 앱에서는 `ConfigService.get<AppConfig['database']>('database')` 형태 또는 주입 토큰으로 접근. (구현체는 `load: [loadConfig]` 로 최상위 그룹 키가 config 루트가 되게 한다.)

### 6.2 `@family/shared`
deps: `pino`, `pino-pretty`, `date-fns`, `date-fns-tz`.
export:
- `const DEFAULT_TIMEZONE = 'Asia/Seoul'`
- `const QUEUE_NAMES = { TEST: 'test' } as const`  ← api/worker가 공유하는 큐 이름
- `function createLogger(name: string, opts?: { level?: string; pretty?: boolean }): Logger` — pino 인스턴스. 민감 필드 redact: `['req.headers.authorization','*.password','*.secret','*.accessKey','*.secretKey','*.signature','*.content']`. dev(pretty)일 때 pino-pretty transport.
- 금액(KRW 정수) 헬퍼:
  - `function assertKrwInteger(v: number): void` — 정수 아니면 throw.
  - `function sumKrw(values: number[]): number` — 정수 합.
- 시간 헬퍼(Asia/Seoul):
  - `function nowUtc(): Date`
  - `function toSeoulString(date: Date, fmt?: string): string` (date-fns-tz `formatInTimeZone`, 기본 `yyyy-MM-dd HH:mm:ssXXX`)
- 공통 타입(문자열 유니온):
  - `type Visibility = 'private'|'household'|'summary_only'`
  - `type Sensitivity = 'normal'|'private'|'confidential'`
  - `type WorkspaceKind = 'personal'|'company'`

### 6.3 `@family/contracts`
deps: `zod`.
export (zod 스키마 + 추론 타입):
- `healthCheckItemSchema` = `{ name:string, status:'up'|'down', detail?:string, latencyMs?:number }`
- `livezResponseSchema` = `{ status:'ok', service:string, timestamp:string }`
- `readyzResponseSchema` = `{ status:'ok'|'degraded', service:string, timestamp:string, checks: healthCheckItem[] }`
- `testJobEnqueueResponseSchema` = `{ jobId:string, queue:string, status:string }`
- `testJobStatusResponseSchema` = `{ jobId:string, state:string, result?:unknown, failedReason?:string }`
- `storageTestResponseSchema` = `{ ok:boolean, bucket:string, key:string, roundTripMs:number }`
- 각 스키마의 추론 타입 export: `LivezResponse`, `ReadyzResponse`, `HealthCheckItem`, `TestJobEnqueueResponse`, `TestJobStatusResponse`, `StorageTestResponse`.

### 6.4 `@family/ai-providers`
deps: 없음(순수 TS). 
export:
- 요청/응답 타입: `GenerateRequest`, `GenerateResponse`, `EmbedRequest`(또는 `embed(texts:string[])`), `RerankRequest`, `RerankResponse`.
- 인터페이스(PRD 3.4):
  ```ts
  interface LlmProvider { generate(req: GenerateRequest): Promise<GenerateResponse>; }
  interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]>; }
  interface RerankerProvider { rerank(req: RerankRequest): Promise<RerankResponse>; }
  ```
- Mock 구현: `MockLlmProvider`(고정 문자열 + echo), `MockEmbeddingProvider`(결정적 의사 벡터, 예: 텍스트 길이/문자코드 기반 고정차원 8), `MockRerankerProvider`(입력 순서 유지).
- 팩토리: `function createProviders(cfg: { provider: string }): { llm: LlmProvider; embedding: EmbeddingProvider; reranker: RerankerProvider }` — Phase 0에서는 provider 값과 무관하게 Mock 반환(단, 구조상 확장 지점 명시 주석).

### 6.5 `@family/database`
deps: `drizzle-orm`, `postgres`. devDeps: `drizzle-kit`, `tsup`, `typescript`.
export:
- `type Db = PostgresJsDatabase<typeof schema>`
- `function createDbClient(databaseUrl: string, opts?: { max?: number }): { db: Db; client: Sql }` — `postgres(databaseUrl, { max, prepare:false })` + `drizzle(client, { schema })`.
- `async function checkConnection(db: Db): Promise<boolean>` — `SELECT 1` (`sql\`select 1\``). 성공 true.
- `async function checkPgVector(db: Db): Promise<boolean>` — `select 1 from pg_extension where extname='vector'` 존재 여부.
- `schema` 배럴(Phase 0는 비어있음; 주석으로 Phase 1 도메인 테이블 예정 명시).
- `drizzle.config.ts`(루트 package 폴더): `dialect:'postgresql', schema:'./src/schema.ts', out:'./drizzle'`. scripts: `db:generate`(drizzle-kit generate), `db:migrate`(drizzle-kit migrate). **Phase 0에서는 실제 마이그레이션 파일 없음** — 툴링만 배치. pgvector 확장은 postgres init SQL이 생성.

> `postgres.js` 사용 시 `prepare:false`(트랜잭션 풀러 호환). drizzle import 경로: `drizzle-orm/postgres-js`, `sql` from `drizzle-orm`.

---

## 7. apps 상세

### 공통(NestJS api/worker)
- `tsconfig.json`: extends base, `module: commonjs`(SWC 런타임 CJS와 정합), `experimentalDecorators/emitDecoratorMetadata true`, `outDir dist`, `baseUrl .`.
  - NOTE: base가 NodeNext라서 앱 tsconfig는 `module:"commonjs", moduleResolution:"node"`로 override(Nest+SWC 표준).
- `.swcrc`:
  ```json
  { "$schema":"https://swc.rs/schema.json",
    "sourceMaps": true,
    "jsc": { "target":"es2022", "parser":{ "syntax":"typescript","decorators":true },
             "transform":{ "legacyDecorator":true, "decoratorMetadata":true } },
    "module": { "type":"commonjs" } }
  ```
- `nest-cli.json`: `{ "collection":"@nestjs/schematics", "sourceRoot":"src", "compilerOptions": { "builder":"swc", "typeCheck": false } }`
- `package.json` scripts:
  - `"dev": "nest start --watch --preserveWatchOutput -b swc"`
  - `"build": "nest build -b swc"`
  - `"start": "node dist/main.js"`
  - `"typecheck": "tsc --noEmit"`, `"lint":"echo noop"`
- `main.ts`: Fastify 어댑터, `app.listen(port, '0.0.0.0')`, 전역 prefix `v1`, `reflect-metadata` import 최상단. graceful shutdown hooks.
- 워크스페이스 의존: `"@family/config":"workspace:*"` 등 필요한 것만.

### 7.1 `apps/api` (port 3001)
runtime deps: `@nestjs/common`,`@nestjs/core`,`@nestjs/platform-fastify`,`@nestjs/config`,`@nestjs/bullmq`,`bullmq`,`ioredis`,`@aws-sdk/client-s3`,`drizzle-orm`,`postgres`,`zod`,`reflect-metadata`,`rxjs`, `@family/config`,`@family/shared`,`@family/contracts`,`@family/database`,`@family/ai-providers`.
dev deps: `@nestjs/cli`,`@swc/core`,`@swc/cli`,`typescript`,`@types/node`.

모듈:
- `ConfigModule.forRoot({ isGlobal:true, load:[loadConfig] })`.
- `DatabaseModule`(global): provider `DB`(=createDbClient(config.database.url).db). onModuleDestroy에서 client.end().
- `StorageModule`: provider `S3Client`(endpoint/region/creds/forcePathStyle from config.storage). `ObjectStorageService`:
  - `ensureBucket()` (onModuleInit에서 headBucket→없으면 createBucket; 실패해도 부팅 막지 않도록 warn 로그).
  - `putObject(key, body, contentType?)`, `getObject(key)`, `headBucket()`.
- `QueueModule`: `BullModule.forRoot({ connection:{ host, port } , prefix })` + `BullModule.registerQueue({ name: QUEUE_NAMES.TEST })`. `QueueService.enqueueTest(payload)`→`queue.add('test', payload)`, `getTestJob(id)`→state/result.
- `AiModule`: provider `AI_PROVIDERS`(=createProviders(config.ai)). (엔드포인트 없음, 경계만.)
- `HealthModule`: `HealthService`가 병렬로 db(checkConnection)+pgvector(checkPgVector)+redis(ioredis ping)+storage(headBucket) 검사. 컨트롤러:
  - `GET /v1/health/live` → `{ status:'ok', service:'api', timestamp }` (의존성 미검사, liveness).
  - `GET /v1/health/ready` → readyz 스키마(각 check up/down + latencyMs). 하나라도 down이면 `status:'degraded'` + HTTP 503.
- `DevModule`(NODE_ENV!=='production'일 때만 import):
  - `POST /v1/dev/echo` → body 그대로 반환.
  - `POST /v1/dev/test-job` → `QueueService.enqueueTest({at:...})`, `{jobId,queue,status:'queued'}`.
  - `GET /v1/dev/test-job/:id` → 상태/결과.
  - `POST /v1/dev/storage-test` → 랜덤 key에 put→get 왕복, `{ok,bucket,key,roundTripMs}`.
- `AppModule`이 위 모듈 조합. main.ts 전역 prefix `v1`.

Docker healthcheck: `/v1/health/live`.

### 7.2 `apps/worker` (port 3002)
runtime deps: api와 유사하되 `@aws-sdk/client-s3` 불필요, `@nestjs/platform-fastify`(health용) 포함, `@nestjs/bullmq`,`bullmq`,`ioredis`,`drizzle-orm`,`postgres`,`@family/config`,`@family/shared`,`@family/database`.
- Fastify 앱, port 3002, 전역 prefix `v1`.
- `QueueModule`: `BullModule.forRoot(connection,prefix)`.
- `ProcessorsModule`: `TestProcessor extends WorkerHost`(`@Processor(QUEUE_NAMES.TEST)`), `process(job)`: 로그(민감정보 없음) + 짧은 지연 + `{ processedAt, echo: job.data }` 반환.
- `HealthModule`: live(`/v1/health/live`) + ready(redis ping + db checkConnection).
- Bull Board 미포함(의존성 리스크 축소). 테스트 잡 검증은 api dev 엔드포인트로 수행.

Docker healthcheck: `/v1/health/live`.

### 7.3 `apps/web` (port 3000)
deps: `next`,`react`,`react-dom`,`@tanstack/react-query`,`@family/contracts`,`@family/shared`. dev: `typescript`,`@types/node`,`@types/react`,`@types/react-dom`.
- App Router, `src/app` 구조.
- `next.config.ts`: `{ transpilePackages:['@family/contracts','@family/shared'], reactStrictMode:true, output:'standalone' }`.
- `src/app/layout.tsx`: 루트 레이아웃 + `<Providers>`.
- `src/app/providers.tsx`("use client"): QueryClientProvider.
- `src/app/page.tsx`: 대시보드. 클라이언트에서 `NEXT_PUBLIC_API_URL + /v1/health/ready`를 React Query로 폴링(5s), 서비스별 상태(DB/pgvector/Redis/Storage) 배지 표시. 심플/깔끔한 인라인 스타일 또는 최소 CSS. 상단에 "Family Memory AI — Phase 0" 헤더 + 실행 안내.
- `src/app/api/health/route.ts`: `GET` → `{status:'ok',service:'web',timestamp}` (Docker healthcheck 전용, api 비의존).
- `package.json` scripts: `"dev":"next dev -H 0.0.0.0 -p 3000"`, `"build":"next build"`, `"start":"next start -H 0.0.0.0 -p 3000"`, `"typecheck":"tsc --noEmit"`, `"lint":"next lint || echo noop"`.
- `tsconfig.json`: Next 표준(`jsx:preserve`, `module:esnext`, `moduleResolution:bundler`, `plugins:[{name:'next'}]`) — base를 extends하되 Next 요구사항 우선.
- `next-env.d.ts` 포함.

Docker healthcheck: `/api/health`.

### 7.4 `apps/mcp` (자리표시자)
- `README.md`만: "Phase 10에서 구현. 현재 비활성." + 예정 도구 목록(memory_search 등). compose에 포함하지 않음. workspace에는 포함되나 빈 package.json(`private`, scripts noop) 배치해 pnpm 인식.

---

## 8. Docker

### `infrastructure/docker/Dockerfile.dev` (공용 dev 이미지)
```dockerfile
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# 패키지만 dist로 빌드(앱은 dev에서 소스 실행)
RUN pnpm -r --filter "./packages/*" build
EXPOSE 3000 3001 3002
CMD ["node","-e","console.log('override in compose')"]
```
- 실제 실행 커맨드는 compose의 `command`로 지정(서비스별 pnpm filter dev).
- `--frozen-lockfile` 사용 → **사전에 `pnpm-lock.yaml` 생성 필요**(검증 단계에서 컨테이너로 생성 후 커밋). lockfile 없으면 `pnpm install`(non-frozen)로 폴백 가능하도록 Dockerfile 주석 명시.

### `docker-compose.yml`
- `name: family-memory-ai`.
- 공용 이미지: `api` 서비스가 `build: {context:., dockerfile:infrastructure/docker/Dockerfile.dev}` + `image: family-memory-ai/dev:local`. `worker`,`web`도 **동일** build+image 지정(같은 태그 → 레이어 캐시 재사용).
- 서비스:
  - `postgres`: image `pgvector/pgvector:pg17`, env POSTGRES_*, volume `pgdata:/var/lib/postgresql/data`, `./infrastructure/postgres/init:/docker-entrypoint-initdb.d:ro`, healthcheck `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB`, ports 5432.
  - `redis`: image `redis:7-alpine`, healthcheck `redis-cli ping`, volume `redisdata:/data`, ports 6379.
  - `minio`: image `minio/minio:latest`, command `server /data --console-address ":9001"`, env `MINIO_ROOT_USER=${STORAGE_ACCESS_KEY}`,`MINIO_ROOT_PASSWORD=${STORAGE_SECRET_KEY}`, volume `miniodata:/data`, ports 9000/9001. (healthcheck 생략 — setup 완료로 대체)
  - `minio-setup`: image `minio/mc`, `depends_on: {minio: {condition: service_started}}`, entrypoint sh 스크립트: mc alias(재시도 루프)→`mc mb --ignore-existing local/$BUCKET`→exit 0. `restart: "no"`.
  - `api`: build/image 위와 같음, `command: pnpm --filter @family/api dev`, env_file `.env`, environment override(HOST 등 불필요), ports 3001, `volumes: ['./apps/api/src:/app/apps/api/src']`, depends_on: postgres(healthy),redis(healthy),minio-setup(completed_successfully), healthcheck(node fetch /v1/health/live), `restart: unless-stopped`.
  - `worker`: `command: pnpm --filter @family/worker dev`, ports 3002, volume `./apps/worker/src:/app/apps/worker/src`, depends_on 동일, healthcheck /v1/health/live.
  - `web`: `command: pnpm --filter @family/web dev`, ports 3000, volume `./apps/web/src:/app/apps/web/src`, depends_on: api(healthy), env NEXT_PUBLIC_API_URL, healthcheck /api/health.
  - `caddy`(profiles: [proxy]): image `caddy:2-alpine`, `./infrastructure/caddy/Caddyfile:/etc/caddy/Caddyfile`, ports 80/443, depends_on web,api. 기본 `up`에는 미포함.
- volumes: `pgdata`,`redisdata`,`miniodata`.
- networks: 기본.

> 바인드마운트는 `apps/*/src`만 → 이미지 내 node_modules/packages dist가 가려지지 않음(핵심). 앱 config/package.json 변경 시 `--build` 재빌드 필요(문서화).

### `infrastructure/postgres/init/01-extensions.sql`
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SET TIME ZONE 'Asia/Seoul';
```

### `infrastructure/caddy/Caddyfile`
로컬 리버스 프록시 예시(`localhost` → web:3000, `/v1/*` → api:3001). 주석으로 prod HTTPS(도메인/자동 인증서) 안내.

---

## 9. 검증 계약 (완료 조건)

`docker compose up --build` 후:
1. `GET http://localhost:3001/v1/health/live` → 200 `{status:'ok',service:'api'}`.
2. `GET http://localhost:3001/v1/health/ready` → 200, checks의 db/pgvector/redis/storage 모두 `up`.
3. `GET http://localhost:3002/v1/health/ready` → 200, redis/db `up`.
4. `POST http://localhost:3001/v1/dev/test-job` → jobId 반환; 잠시 후 `GET /v1/dev/test-job/:id` → `state:'completed'`, result 존재. (BullMQ end-to-end)
5. `POST http://localhost:3001/v1/dev/storage-test` → `{ok:true}`. (MinIO 왕복)
6. `GET http://localhost:3000` → 대시보드 로드, 서비스 상태 표시. `GET /api/health` 200.
7. pgvector 확인: health ready의 pgvector `up` (또는 `docker compose exec postgres psql -U family -d family_memory -c "select extname from pg_extension where extname='vector'"`).

---

## 10. 문서/ADR

- `docs/architecture/overview.md`: PRD Section 4 논리 아키텍처 + Phase 0에서 구현된 컴포넌트 표시.
- `docs/adr/0001-use-modular-monolith.md`
- `docs/adr/0002-use-postgresql-pgvector.md`
- `docs/adr/0003-monorepo-pnpm-turborepo.md`
- `docs/adr/0004-model-agnostic-ai-providers.md`
- 각 ADR: 제목/상태/배경/결정/검토한 대안/장점/단점/변경조건 (PRD Section 37 형식).
- `docs/api/health.md`: health/dev 엔드포인트 요청·응답 예시.

---

## 11. 파티션 맵 (구현 에이전트 분담 — 경로 중복 없음)

- **P1 root+infra**: 루트 파일 전체(§3), `infrastructure/**`(§8 Dockerfile.dev, postgres init, caddy, minio README), `docker-compose.yml`, `.env.example`.
- **P2 packages-core**: `packages/config`, `packages/shared`, `packages/contracts` (§6.1–6.3).
- **P3 packages-data-ai**: `packages/database`, `packages/ai-providers` (§6.4–6.5).
- **P4 api**: `apps/api/**` (§7.1, 공통 §7).
- **P5 worker**: `apps/worker/**` (§7.2, 공통 §7).
- **P6 web**: `apps/web/**` (§7.3).
- **P7 mcp+docs**: `apps/mcp/**`(§7.4) + `docs/**`(§10, 본 spec 제외).

각 에이전트는 본 spec을 먼저 Read하고, 자기 파티션의 파일만 생성한다. 다른 파티션 파일을 만들지 않는다.
```
