# Phase 1 Build Spec — 인증과 가족 (Auth & Household)

> Phase 1 구현의 **단일 진실 소스(SSOT)**. Phase 0 위에 인증·가족 그룹·초대·역할을 얹는다.
> Phase 0 규약([[docs/phase0-build-spec.md]])을 그대로 따른다: 패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, KRW 정수, Asia/Seoul, 로그 Secret 금지.

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 1)

구현 범위: 회원가입 / 로그인 / 로그아웃 / 비밀번호 변경 / 토큰 갱신, 가족 그룹 생성 / 초대 / 역할 관리 / 초대 수락 / 구성원 제거.

완료 조건(실측):
1. Owner가 가족 생성 → 자신이 owner 멤버로 등록.
2. 초대 토큰 발급(raw 토큰은 1회만 응답, DB엔 해시 저장).
3. 다른 계정이 초대 수락 → member로 합류.
4. 역할별 권한 적용(owner/admin/member/viewer).
5. **다른 가족 그룹 데이터 접근 차단**(비멤버 403).
6. 보안(PRD §29): 잘못된 비밀번호 차단, 만료/재사용 초대 토큰 차단, member의 owner 전용 API 차단, refresh 회전.

**이번 Phase에서 구현하지 않음**: 장치 HMAC, 카드/거래, Slack, RAG, `workspaces` 테이블(Phase 6에서 개인 이벤트와 함께 도입).

---

## 1. 추가 의존성 (apps/api)

- `@nestjs/jwt` `^11` — Access Token 서명/검증.
- `@node-rs/argon2` `^2` — argon2id 비밀번호 해시(프리빌트 바이너리, node-gyp 불필요).
- `@fastify/cookie` `^11` — HttpOnly Refresh 쿠키(Fastify 5 호환).
- `nestjs-zod` `^4` — zod 기반 DTO 검증(`ZodValidationPipe`, `createZodDto`).

> 새 네이티브/프리빌트 의존이 추가되므로 **pnpm-lock.yaml 재생성 필수**.

---

## 2. 데이터 모델 — `packages/database`

drizzle-orm `pg-core`로 정의. PK는 `uuid('id').primaryKey().defaultRandom()`(PG17 내장 `gen_random_uuid()`). 모든 timestamp는 `timestamp({ withTimezone: true })`. 공통 컬럼: `createdAt` default now, `updatedAt` default now, 필요 시 `deletedAt`(soft delete).

### pgEnum
- `householdRole` = `['owner','admin','member','viewer']`
- `memberStatus` = `['active','removed']`
- `invitationStatus` = `['pending','accepted','revoked','expired']`

### 테이블
```
users
  id uuid pk
  email text not null            -- 소문자 정규화 저장
  passwordHash text not null
  name text not null
  createdAt / updatedAt / deletedAt
  UNIQUE(email)                  -- deletedAt 고려는 Phase 1에선 단순 unique

userSessions                     -- refresh 토큰(불투명 랜덤) 세션
  id uuid pk
  userId uuid not null -> users.id
  refreshTokenHash text not null -- sha256(raw refresh token)
  expiresAt timestamptz not null
  revokedAt timestamptz null
  userAgent text null
  createdAt
  UNIQUE(refreshTokenHash)
  INDEX(userId)

households
  id uuid pk
  name text not null
  createdBy uuid not null -> users.id
  createdAt / updatedAt / deletedAt

householdMembers
  id uuid pk
  householdId uuid not null -> households.id
  userId uuid not null -> users.id
  role householdRole not null
  status memberStatus not null default 'active'
  joinedAt timestamptz default now
  createdAt / updatedAt
  UNIQUE(householdId, userId)
  INDEX(householdId), INDEX(userId)

householdInvitations
  id uuid pk
  householdId uuid not null -> households.id
  email text null                -- 대상 이메일(선택)
  role householdRole not null default 'member'
  tokenHash text not null        -- sha256(raw invite token)
  status invitationStatus not null default 'pending'
  expiresAt timestamptz not null
  createdBy uuid not null -> users.id
  acceptedByUserId uuid null -> users.id
  acceptedAt timestamptz null
  revokedAt timestamptz null
  createdAt / updatedAt
  UNIQUE(tokenHash)
  INDEX(householdId)

householdConsents                -- 가족 합류 동의 기록(PRD §7.3)
  id uuid pk
  householdId uuid not null -> households.id
  userId uuid not null -> users.id
  consentType text not null      -- 'household_join'
  consentVersion text not null default 'v1'
  consentedAt timestamptz default now
  createdAt
```

`schema.ts`는 위 테이블/enum을 export하고, 관계 조회 편의를 위해 각 테이블의 select/insert 추론 타입(`$inferSelect`/`$inferInsert`)도 재export(예: `export type User = typeof users.$inferSelect`).

### 마이그레이션 방식 (재빌드 최소화)
- `drizzle.config.ts`: `dialect:'postgresql'`, `schema:'./src/schema.ts'`, `out:'./drizzle'`, `dbCredentials` 불필요(generate만 사용).
- **적용은 프로그램적 마이그레이터**로 수행:
  - `packages/database/src/migrate.ts` 추가 — `drizzle-orm/postgres-js/migrator`의 `migrate(db, { migrationsFolder })` 실행. `migrationsFolder`는 `resolve(__dirname, '../drizzle')`(dist 기준 `packages/database/drizzle`). `DATABASE_URL` env 사용, `postgres(url,{max:1})`, 완료 후 `client.end()`, 에러 시 `process.exit(1)`.
  - `tsup.config.ts` entry에 `'src/migrate.ts'` 추가 → `dist/migrate.js` 생성.
  - `package.json` scripts: `"migrate": "node dist/migrate.js"`, `"db:generate": "drizzle-kit generate"`.
- SQL 마이그레이션 파일(`packages/database/drizzle/*.sql` + `meta/`)은 이미지에 굽지 않고 **compose `migrate` 서비스에 바인드마운트**하여 적용(§5). generate는 통합 단계에서 dev 이미지로 수행.
- `createDbClient`, `checkConnection`, `checkPgVector`는 Phase 0 그대로 유지.

---

## 3. API 계약 — `packages/contracts`

`src/auth.ts`, `src/household.ts` 추가 후 배럴 export. zod 스키마 + 추론 타입.

### auth.ts
- `registerRequestSchema` = `{ email: z.string().email(), password: z.string().min(8).max(200), name: z.string().min(1).max(100) }`
- `loginRequestSchema` = `{ email: email, password: string.min(1) }`
- `changePasswordRequestSchema` = `{ currentPassword: string.min(1), newPassword: string.min(8).max(200) }`
- `userSummarySchema` = `{ id, email, name, createdAt: string }`
- `authTokensSchema` = `{ accessToken: string, tokenType: 'Bearer', expiresInSec: number }`
- `authResultSchema` = `{ user: userSummary, tokens: authTokens }`  (register/login/refresh 응답)
- `meResponseSchema` = `{ user: userSummary, memberships: householdMembershipSummary[] }`
- 추론 타입 export.

### household.ts
- `householdCreateRequestSchema` = `{ name: string.min(1).max(100) }`
- `householdUpdateRequestSchema` = `{ name: string.min(1).max(100) }`
- `invitationCreateRequestSchema` = `{ email: z.string().email().optional(), role: z.enum(['admin','member','viewer']).default('member'), expiresInHours: z.number().int().min(1).max(720).default(168) }`  (owner는 초대 불가 역할)
- `acceptInvitationRequestSchema` = `{ consent: z.literal(true) }`  (동의 필수)
- `memberRoleUpdateRequestSchema` = `{ role: z.enum(['admin','member','viewer']) }`  (owner로의 승격/강등은 별도 소유권 이전 — Phase 1 미지원)
- 응답 스키마/타입:
  - `householdSummarySchema` = `{ id, name, createdAt: string, myRole: householdRole }`
  - `householdMembershipSummarySchema` = `{ householdId, name, role, status }`
  - `memberSummarySchema` = `{ memberId, userId, name, email, role, status, joinedAt: string }`
  - `invitationCreatedSchema` = `{ invitationId, token: string, expiresAt: string, role, acceptUrlPath: string }`  (token은 1회 노출)
  - `invitationSummarySchema` = `{ id, email, role, status, expiresAt, createdAt }`
- `householdRole` union 타입도 export(`'owner'|'admin'|'member'|'viewer'`).

---

## 4. apps/api 구현

### 4.1 공통 배선
- `app.module.ts`:
  - 기존 모듈 유지 + `AuthModule`, `HouseholdModule` 추가.
  - `JwtModule`은 AuthModule 내부에서 등록.
  - 전역 Pipe: `nestjs-zod`의 `ZodValidationPipe`를 `APP_PIPE`로 provide.
  - 전역 Guard: `AccessTokenGuard`를 `APP_GUARD`로 provide(기본 모든 라우트 보호). `@Public()`이 붙은 라우트는 통과.
- `main.ts`: `await app.register(fastifyCookie)` 추가(전역 prefix `v1` 이전/이후 무관, listen 전). 나머지 Phase 0 그대로.
- `apps/api/package.json`: §1 의존성 추가.

### 4.2 auth 모듈 (`apps/api/src/auth/`)
- `auth.constants.ts`: `IS_PUBLIC_KEY`, 쿠키명 `REFRESH_COOKIE = 'refresh_token'`, `REFRESH_COOKIE_PATH = '/v1/auth'`.
- `decorators/public.decorator.ts`: `Public()` = `SetMetadata(IS_PUBLIC_KEY, true)`.
- `decorators/current-user.decorator.ts`: `CurrentUser()` param decorator → `request.user`(`{ userId, email }`).
- `guards/access-token.guard.ts`: `AccessTokenGuard implements CanActivate`.
  - Reflector로 `IS_PUBLIC_KEY` 확인 → public이면 true.
  - `Authorization: Bearer <jwt>` 파싱 → `JwtService.verifyAsync(token, {secret: access})` → `request.user = { userId: payload.sub, email: payload.email }`. 실패 시 `UnauthorizedException`.
- `token.service.ts`: (config에서 시크릿/만료 로드)
  - `issueAccessToken(user): { accessToken, expiresInSec }` — JwtService.sign `{ sub:user.id, email }`, exp `ACCESS_TTL`(기본 900s).
  - `generateRefreshToken(): { raw, hash }` — `randomBytes(32).toString('hex')`, `hash = sha256(raw)`.
  - `hashToken(raw): string` — sha256 hex (초대/refresh 공통).
- `password.service.ts`: `hash(pw)` / `verify(hash, pw)` — `@node-rs/argon2`(argon2id, 기본 파라미터).
- `auth.service.ts` (DB=drizzle Db 주입, TokenService/PasswordService 주입):
  - `register({email,name,password})`: email 소문자화, 존재 검사(중복 시 `ConflictException`), 해시, users insert, 세션 생성+토큰 발급. 반환 `{ user, tokens, refresh:{raw,expiresAt} }`(컨트롤러가 쿠키 설정).
  - `login({email,password})`: user 조회(없거나 deletedAt이면 `UnauthorizedException('invalid credentials')` — 존재 여부 노출 금지), argon2 verify, 세션 생성+토큰. 반환 동일.
  - `refresh(rawRefresh)`: `hashToken` → userSessions 조회(revokedAt null, expiresAt>now). 없으면 `UnauthorizedException`. **재사용 탐지**: 해당 raw가 이미 revoked인 세션과 매칭되면 그 user의 모든 세션 revoke 후 `UnauthorizedException`. 정상: 기존 세션 revoke(회전) + 새 세션 생성 + 새 토큰. 반환 동일.
  - `logout(rawRefresh)`: 매칭 세션 revoke(있으면). 항상 성공(멱등).
  - `changePassword(userId, current, next)`: user 조회, verify(실패 `UnauthorizedException`), 새 해시 update, **모든 세션 revoke**(재로그인 강제).
  - `me(userId)`: user + `householdMembers`(status active) 조인해 memberships 반환.
  - 세션 생성 헬퍼: refresh raw/hash 생성, userSessions insert(expiresAt = now + `REFRESH_TTL`(기본 30d)).
- `auth.controller.ts` (`@Controller('auth')`):
  - `@Public() @Post('register')` → 201, body=registerDto. 응답 authResult, refresh 쿠키 set.
  - `@Public() @Post('login')` → 200, authResult + 쿠키 set.
  - `@Public() @Post('refresh')` → 200. 쿠키에서 refresh 읽어 회전. authResult + 새 쿠키.
  - `@Post('logout')` → 200(인증 필요). 쿠키 revoke + clearCookie.
  - `@Get('me')` → 200. `CurrentUser` 기반 me.
  - `@Post('change-password')` → 200. current/new, 세션 전체 무효화 후 clearCookie.
  - 쿠키 옵션: `httpOnly:true, sameSite:'lax', path:REFRESH_COOKIE_PATH, secure: nodeEnv==='production', maxAge: REFRESH_TTL(sec)`. 컨트롤러는 `@Res({passthrough:true}) reply: FastifyReply`로 set/clear.
- DTO는 `createZodDto(contracts 스키마)`로 각 요청에 적용.

### 4.3 household 모듈 (`apps/api/src/household/`)
- `household.service.ts` (Db 주입). **모든 메서드는 actorUserId를 받아 멤버십/역할을 서비스 계층에서 강제**(PRD §26). 헬퍼:
  - `requireMembership(householdId, userId, roles?)`: householdMembers 조회(status active). 없으면 `ForbiddenException('not a household member')`. `roles` 주어지면 role 포함 검사 후 아니면 `ForbiddenException('insufficient role')`. 멤버십 레코드 반환.
  - 메서드:
    - `create(userId, {name})`: households insert(createdBy=userId) + householdMembers insert(owner, active) + householdConsents insert(owner 'household_join') — 트랜잭션. 반환 householdSummary(myRole owner).
    - `get(householdId, userId)`: requireMembership → household 반환(myRole 포함).
    - `update(householdId, userId, {name})`: requireMembership owner|admin → name update.
    - `listMembers(householdId, userId)`: requireMembership(any) → members(user 조인) 반환.
    - `updateMemberRole(householdId, userId, targetMemberId, {role})`: requireMembership **owner** → 대상 조회. 대상이 owner면 거부(소유권 이전 미지원, `ForbiddenException`). role 업데이트.
    - `removeMember(householdId, userId, targetMemberId)`: requireMembership owner(또는 본인 탈퇴 허용). 마지막 owner 제거 금지(`BadRequestException`). status='removed'.
    - `createInvitation(householdId, userId, {email,role,expiresInHours})`: requireMembership **owner** → raw 토큰 생성(TokenService.hashToken), 저장(pending, expiresAt). 반환 invitationCreated(raw token + acceptUrlPath `/v1/household-invitations/{token}/accept`).
    - `listInvitations(householdId, userId)`: requireMembership owner|admin → pending/전체 초대 반환.
    - `revokeInvitation(householdId, userId, invitationId)`: requireMembership owner → status='revoked'.
    - `acceptInvitation(rawToken, userId, {consent})`: consent!==true면 `BadRequestException`. hashToken 조회 → 없으면 `NotFoundException`. status!=='pending' → `GoneException`/`ConflictException`(재사용/취소 차단). expiresAt<now → status='expired' 저장 후 `GoneException`. (email 지정 시 user.email과 불일치면 `ForbiddenException`.) 이미 멤버면 초대만 accepted 처리 후 기존 멤버십 반환(멱등). 정상: 트랜잭션으로 householdMembers insert(invitation.role, active) + householdConsents insert + invitation update(status accepted, acceptedByUserId, acceptedAt). 반환 householdSummary.
- `household.controller.ts` (`@Controller('households')`) — 전부 인증 필요:
  - `POST /v1/households` create.
  - `GET /v1/households/:id` get.
  - `PATCH /v1/households/:id` update.
  - `POST /v1/households/:id/invitations` createInvitation.
  - `GET /v1/households/:id/invitations` listInvitations.
  - `GET /v1/households/:id/members` listMembers.
  - `PATCH /v1/households/:id/members/:memberId` updateMemberRole.
  - `DELETE /v1/households/:id/members/:memberId` removeMember.
  - `DELETE /v1/households/:id/invitations/:invitationId` revokeInvitation.
- `invitation.controller.ts` (`@Controller('household-invitations')`):
  - `POST /v1/household-invitations/:token/accept` acceptInvitation(인증 필요, body=accept consent).
- 역할 규칙 요약(PRD §7.2): owner=전체+초대/역할/제거, admin=조회+예산/규칙(Phase 1엔 조회/멤버조회/초대목록), member=조회, viewer=조회. Phase 1 write(초대/역할/제거/설정)는 owner 중심, update는 owner|admin.

### 4.4 에러/응답 규약
- 모든 서비스 예외는 Nest HttpException 계열. 401은 자격 존재 여부를 노출하지 않는 일반 메시지. 403은 권한/멤버십. 로그에 비밀번호/토큰/해시 절대 미출력.
- 날짜 응답은 ISO 문자열(`toISOString`).

---

## 5. Docker / 마이그레이션 통합

`docker-compose.yml`에 `migrate` 원샷 서비스 추가:
```yaml
migrate:
  build: { context: ., dockerfile: infrastructure/docker/Dockerfile.dev }
  image: family-memory-ai/dev:local
  command: pnpm --filter @family/database migrate
  env_file: .env
  volumes:
    - ./packages/database/drizzle:/app/packages/database/drizzle   # 마이그레이션 SQL 바인드마운트
  depends_on:
    postgres: { condition: service_healthy }
  restart: "no"
```
- `api`, `worker`의 `depends_on`에 `migrate: { condition: service_completed_successfully }` 추가(기존 postgres/redis/minio-setup 조건 유지).
- `migrate.ts`는 마운트된 `../drizzle`에서 SQL을 읽어 적용. 마이그레이션 파일 없으면 no-op로 안전 종료(폴더/journal 없을 때 방어).

통합 절차(진행자가 인라인 수행):
1. lockfile 재생성(throwaway `pnpm install --lockfile-only`).
2. `docker compose build`(새 의존성 + 새 schema/migrate 빌드).
3. 마이그레이션 생성: `mkdir -p packages/database/drizzle && docker run --rm -v "$PWD/packages/database/drizzle":/app/packages/database/drizzle -w /app/packages/database family-memory-ai/dev:local pnpm exec drizzle-kit generate`.
4. `docker compose up -d --force-recreate`(migrate가 스키마 적용 후 api/worker 기동).
5. e2e 검증 스크립트 실행.

---

## 6. 검증 (완료 조건 e2e) — `scripts/verify-phase1.mjs`

Node(내장 fetch)로 실 스택(localhost:3001) 대상 시나리오 실행. 각 단계 assert, 실패 시 비0 종료. 쿠키는 응답 `set-cookie`를 수동 보관해 refresh에 사용.
1. 회원가입 ownerA → 201, accessToken 수신.
2. 잘못된 비밀번호 로그인 → 401.
3. ownerA 가족 생성 → myRole owner.
4. `GET /me` → memberships에 해당 가족 포함.
5. ownerA 초대 생성(role member) → raw token 수신.
6. userB 회원가입 → accessToken.
7. userB가 초대 수락(consent:true) → member 합류.
8. userB `GET /households/:id` → 200(myRole member).
9. **보안**: userC 회원가입 후 `GET /households/:id`(가입 안 함) → 403.
10. **보안**: userB(member)가 `POST /households/:id/invitations` → 403.
11. **보안**: 동일 초대 토큰 재수락 → 4xx(재사용 차단).
12. **보안**: 만료 초대(expiresInHours 최소 + 서버 시간 조작 불가하므로, 별도로 revoke 후 수락 → 4xx로 대체 검증).
13. refresh: 쿠키로 `POST /auth/refresh` → 새 accessToken + 새 쿠키(회전 확인). 이전 refresh 재사용 → 401.
14. logout → 이후 refresh 401.
결과 요약 출력(통과/실패 카운트).

추가: `apps/api` Jest 단위 테스트가 부담되면 e2e 스크립트를 1차 검증으로 삼는다(선택적으로 token/password 순수 로직 유닛 테스트 추가).

---

## 7. 문서 / 커밋

- ADR: `docs/adr/0005-auth-jwt-refresh-rotation.md`, `docs/adr/0006-household-roles-and-invitations.md`(PRD §37 형식).
- `docs/api/auth-household.md`: 엔드포인트 요청/응답 예시.
- 커밋 단위(PRD §38): `feat(db)` 스키마/마이그레이션 → `feat(contracts)` → `feat(auth)` → `feat(household)` → `chore(infra)` migrate 서비스 → `test`/`docs`.

## 8. 파티션 맵 (구현 에이전트)
- **P1 database**: `packages/database` schema.ts(전체 테이블/enum/추론타입), migrate.ts, tsup.config(entry 추가), package.json(scripts migrate/db:generate), drizzle.config.ts. (Phase 0 client/health 유지)
- **P2 contracts**: `packages/contracts` auth.ts, household.ts, index.ts 배럴 갱신.
- **P3 api-auth**: `apps/api/src/auth/**`(constants, decorators, guards, token/password/auth service, controller). AppModule/main/package.json은 P5.
- **P4 api-household**: `apps/api/src/household/**`(service, household.controller, invitation.controller).
- **P5 api-wiring**: `apps/api/package.json`(deps 추가), `apps/api/src/main.ts`(fastifyCookie), `apps/api/src/app.module.ts`(AuthModule/HouseholdModule import + APP_PIPE ZodValidationPipe + APP_GUARD AccessTokenGuard), `docker-compose.yml`(migrate 서비스 + api/worker depends_on).
- **P6 verify+docs**: `scripts/verify-phase1.mjs`, ADR 0005/0006, `docs/api/auth-household.md`.

각 에이전트는 이 스펙과 phase0-build-spec을 Read하고, 자기 파티션 파일만 생성/수정한다. P5만 app.module/main/api package.json/docker-compose를 수정한다(그 외 파티션은 손대지 않음).
