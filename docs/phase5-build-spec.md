# Phase 5 Build Spec — 가족 금융 웹앱 (Analytics · Budgets · Web UI)

> Phase 5 = 초기 MVP 완성. Phase 0~4 규약 준수(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, KRW 정수, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도 갱신, 새 npm 의존성 시 lockfile 재생성, 교차모듈 `@UseGuards`는 가드 의존성까지 export).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 5)

범위: 대시보드 / 거래 목록·필터 / 통계 / 예산 / 장치 관리 / 가족 관리.

완료 조건(실측):
1. 가족 총지출 조회 / 구성원별 / 카드별 / 카테고리별 지출 조회(백엔드 analytics + 웹 대시보드).
2. 예산 사용률 확인.
3. 확인 필요 거래(pending_review/duplicate_suspected) 처리.
검증: 백엔드 `scripts/verify-phase5.mjs`(analytics 집계·예산 사용률·권한) + 웹 `next build` 성공 + claude-in-chrome 스모크(로그인→대시보드 렌더).

### 경계 (하지 않음)
- AI 질의 화면(PRD §17.7) → Phase 7+. 정기 결제 자동 탐지 로직은 최소(대시보드에 "정기 결제 후보"는 동일 가맹점 반복 카운트로 간단 표기, 별도 모델 없음).

---

## 1. 핵심 설계 결정

### 1.1 계산은 SQL (PRD §3.3)
모든 집계는 drizzle SQL(`sum`/`count`/`group by`)로 수행. LLM/JS 루프 합산 금지. 순지출 = `sum(netAmount) WHERE transactionType='approval'`(취소는 netAmount에 이미 반영, cancellation 레코드는 0).

### 1.2 통계 공개범위 (PRD §8/§16/§26)
actor(memberId) 기준: 금액 집계 포함 = `본인 ∪ visibility='household' ∪ visibility='summary_only'`(타인 것도), 타인 `private` 제외. `merchants` 통계만 가맹점명 노출 → 타인 `summary_only`는 가맹점명 `'(비공개)'`로 그룹. 모든 응답에 메타 표기: `period{from,to,timezone}`, `cancellationApplied:true`, `excludedByPermission`(권한 제외 건수).

### 1.3 기간/Timezone
`month=YYYY-MM`(기본 이번달, Asia/Seoul) 또는 `from`/`to`(ISO). 월 경계는 Asia/Seoul 기준(`fromZonedTime`으로 [월초 00:00, 다음달초) 반생성). 집계는 `approvedAt` 기준.

### 1.4 예산 사용률
예산 스코프의 **현재월** 순지출 / `amount`. 스코프별 대상: household=전체(household+summary_only, private 제외), member=해당 member, category=해당 categoryId, card=해당 cardId. 권한: 예산 CRUD는 owner/admin(PRD §7.2). 조회는 멤버.

### 1.5 CORS (web↔api)
web(3000)→api(3001)는 same-site(localhost)지만 cross-origin. api `main.ts`에 `app.enableCors({ origin: config.web.corsOrigin, credentials: true })`. refresh 쿠키는 `credentials:'include'`로 전송. 새 env `CORS_ORIGIN=http://localhost:3000`.

### 1.6 웹 인증 흐름
access token은 **메모리**(React context) 보관, refresh는 HttpOnly 쿠키(자동). 앱 로드 시 `POST /v1/auth/refresh`로 access 복원(쿠키 있으면 자동 로그인). API 클라이언트가 401 → refresh 1회 재시도 → 실패 시 로그아웃/로그인 이동. 모든 fetch `credentials:'include'`.

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

### pgEnum
- `budgetScopeType` = `['household','member','category','card']`
- `budgetPeriod` = `['monthly']`

### 테이블
```
budgets
  id uuid pk
  householdId uuid not null -> households.id
  name text null
  scopeType budgetScopeType not null
  scopeRefId uuid null          -- member/category/card id (household는 null)
  amount integer not null       -- KRW 정수, 월 예산
  period budgetPeriod not null default 'monthly'
  currency text not null default 'KRW'
  createdBy uuid not null -> users.id
  createdAt / updatedAt
  INDEX(householdId), UNIQUE(householdId, scopeType, scopeRefId)
```
추론 타입 export(Budget/NewBudget). 마이그레이션 0004는 통합에서 generate.

---

## 3. `@family/config` + env
`configSchema`에 `web` 그룹: `{ corsOrigin: z.string().min(1).default('http://localhost:3000') }`. `validateEnv` 매핑 `web.corsOrigin = env.CORS_ORIGIN`. `.env.example`(+`.env`)에 `CORS_ORIGIN=http://localhost:3000`.

---

## 4. API 계약 — `packages/contracts` (`src/analytics.ts`, `src/budget.ts` + 배럴)

### analytics.ts
- `analyticsPeriodSchema` = `{ from: string, to: string, timezone: string }`
- `analyticsMetaSchema` = `{ period: analyticsPeriod, cancellationApplied: z.literal(true), includedMemberIds: string[], excludedByPermission: number }`
- `monthlyAnalyticsSchema` = `{ meta, totalNet: int, totalApproved: int, totalCancelled: int, transactionCount: int, previousNet: int, deltaNet: int, deltaRate: number }` (deltaRate= (net-prev)/prev, prev 0이면 null 허용 → nullable)
- `categoryBreakdownSchema` = `{ meta, items: { categoryId: nullable, categorySlug: nullable, categoryName: string, net: int, ratio: number, count: int }[] }`
- `memberBreakdownSchema` = `{ meta, items: { memberId, name, net: int, ratio: number, count: int }[] }`
- `cardBreakdownSchema` = `{ meta, items: { cardId: nullable, alias: string, issuer: nullable, net: int, ratio: number, count: int }[] }`
- `merchantBreakdownSchema` = `{ meta, items: { merchant: string, net: int, ratio: number, count: int }[] }` (미확인/비공개는 라벨로)
- 추론 타입 export.

### budget.ts
- `budgetScopeTypeSchema` = `z.enum(['household','member','category','card'])`
- `budgetCreateRequestSchema` = `{ householdId: uuid, name: string.max(100).optional(), scopeType, scopeRefId: uuid.optional(), amount: int.positive() }`
- `budgetUpdateRequestSchema` = `{ name?, amount?: int.positive() }`
- `budgetSummarySchema` = `{ id, householdId, name: nullable, scopeType, scopeRefId: nullable, scopeLabel: string, amount: int, spent: int, remaining: int, usageRate: number, period, currency }`
- `budgetListResponseSchema` = `{ items: budgetSummary[], month: string }`
- 추론 타입.

---

## 5. apps/api 구현

### 5.1 analytics 모듈 (`apps/api/src/analytics/`)
- `analytics.service.ts` (Db 주입, requireMembership, 공개범위 scope 헬퍼 재사용/자체구현):
  - 공통: `resolvePeriod(month?|from?|to?)` → {from,to,timezone:'Asia/Seoul'} (Asia/Seoul 월경계). `visibilityScope(actorMemberId)` SQL 조건.
  - `monthly(userId, householdId, period)`: 이번기간 + 직전동기간 합. SQL sum(netAmount) type=approval + count. delta.
  - `categories(...)`: group by categoryId, join expense_categories(name). ratio=net/total. 미분류(null)는 '미분류'.
  - `members(...)`: group by memberId, join household_members→users(name).
  - `cards(...)`: group by cardId, join payment_cards(alias/issuer). null카드='미연결'.
  - `merchants(...)`: group by merchantNormalized. 타인 summary_only는 '(비공개)' 라벨(권한). null='미확인 가맹점'. 상위 N(기본 20).
  - 모두 excludedByPermission(private 타인 제외 건수) 계산해 meta에.
- `analytics.controller.ts` (`@Controller('analytics')`, 일반 인증): GET `/monthly`, `/categories`, `/members`, `/cards`, `/merchants` (query: householdId, month|from|to). CurrentUser.
- `analytics.module.ts`.

### 5.2 budgets 모듈 (`apps/api/src/budgets/`)
- `budget.service.ts` (Db 주입, requireMembership): create/update/delete(owner/admin), list(멤버, 현재월 사용률 포함). spent = 스코프별 현재월 sum(netAmount) approval(공개범위 §1.4). scopeLabel 생성(household='가족 전체', member=이름, category=카테고리명, card=별칭). usageRate=spent/amount. UNIQUE(householdId,scopeType,scopeRefId) 충돌 시 Conflict.
- `budget.controller.ts` (`@Controller('budgets')`): GET `/?householdId=&month=`, POST `/`, PATCH `/:id`, DELETE `/:id`.
- `budgets.module.ts`.

### 5.3 배선
- `main.ts`: `app.enableCors({ origin: <config.web.corsOrigin>, credentials: true })` (listen 전). config 로드 후 origin 적용(또는 env 직접).
- `app.module.ts`: AnalyticsModule, BudgetsModule import.

---

## 6. apps/web 구현 (Next.js 15 App Router)

새 npm 의존성 없음(next/react/@tanstack/react-query/@family/contracts/@family/shared). 차트는 CSS 기반 막대(라이브러리 없음). `next.config.ts` transpilePackages에 `@family/contracts`,`@family/shared` 유지.

### 6.1 foundation (P5-web-foundation)
- `src/lib/format.ts`: `formatKRW(n)`('₩12,500'), `formatDate(iso)`(Asia/Seoul), `formatMonth`, `percent(n)`.
- `src/lib/api-client.ts`: `const API = process.env.NEXT_PUBLIC_API_URL`. `apiFetch<T>(path, {method,body,accessToken})` — `credentials:'include'`, JSON, 에러 시 throw(status/message). 도메인 함수: auth(register/login/refresh/logout/me), households(create/get/members/invite/acceptInvite/updateRole/removeMember), devices(list/register/rotate/revoke), cards(list/create/update), categories(list), transactions(list/get/update/linkCancellation/markDuplicate/markValid/summary), analytics(monthly/categories/members/cards/merchants), budgets(list/create/update/delete). 모든 응답은 @family/contracts 스키마로 safeParse(선택). 401 처리는 훅/컨텍스트에서.
- `src/lib/auth-context.tsx` ("use client"): `AuthProvider` — accessToken(state), user(state). `bootstrap()`(마운트 시 refresh 시도→me). `login/register/logout`. `useAuth()`. `getAccessToken()` 제공. 401 시 refresh 1회 재시도 래퍼 `authedFetch`.
- `src/app/providers.tsx`: QueryClientProvider + AuthProvider(기존 Phase 0 providers 확장).
- `src/app/layout.tsx`: 루트(기존 유지 + providers).
- `src/app/(auth)/login/page.tsx`, `src/app/(auth)/register/page.tsx`: 폼 → login/register → 성공 시 router.push('/dashboard'). 에러 표시.
- `src/app/(app)/layout.tsx` ("use client"): 인증 가드(useAuth: !user면 bootstrap 대기, 실패 시 /login redirect). 사이드바 네비(대시보드/거래/예산/장치/가족) + 상단(가족 선택 드롭다운 if 여러 household, 사용자/로그아웃). 현재 householdId 컨텍스트(`src/lib/household-context.tsx` 또는 layout state → query param). **활성 householdId는 `useAuth().memberships[0]` 기본, 상단에서 전환.**
- `src/components/`: `StatCard`, `BarList`(항목+막대+금액), `Table`, `StatusBadge`, `Money`, `Field`, `Button`, `Select`, `Modal`(간단), `UsageBar`. 최소·깔끔한 CSS(`src/app/globals.css` 확장, CSS 변수 팔레트, 라이트/다크 무관 단일 라이트 테마 OK).
- `src/lib/queries.ts`: React Query 훅(useMonthly, useTransactions, useBudgets 등) — authedFetch + queryKey. (pages가 사용)
- 기존 Phase 0 대시보드(`src/app/page.tsx`, health)는 `/` → `/dashboard` redirect 또는 health를 `(app)` 밖 유지. `/`는 인증 시 /dashboard, 아니면 /login.

### 6.2 pages (P6/P7/P8, foundation 이후)
- **P6 dashboard** `src/app/(app)/dashboard/page.tsx`: analytics.monthly(순지출 StatCard + 전월대비 delta), members/cards/categories BarList, transactions.list(최근 10 Table), budgets(UsageBar top), 확인필요(transactions?status=pending_review + duplicate_suspected count → /transactions 링크), 파싱실패는 card-sms-events?status=parse_failed count.
- **P7 transactions** `src/app/(app)/transactions/page.tsx`: 필터 바(기간 month, 구성원, 카드, 카테고리, 타입, 상태), Table(가맹점/금액/카테고리/구성원/카드/상태/공개범위), 행 작업: 카테고리 변경(select→update applyRule 체크), 공개범위 변경, mark-duplicate/mark-valid, 메모, 취소연결(모달). 페이지네이션(cursor). masked 항목은 '(비공개)' 표시.
- **P8 budgets+devices+household**:
  - `src/app/(app)/budgets/page.tsx`: 예산 목록 UsageBar(스코프라벨/사용/한도/%), 생성 폼(scopeType/scopeRef select/amount), 수정/삭제.
  - `src/app/(app)/devices/page.tsx`: 장치 목록(이름/플랫폼/마지막수신/상태), 등록 폼(→ secret 1회 모달 표시 + 서명 안내), 회전(secret 재표시), 폐기.
  - `src/app/(app)/household/page.tsx`: 구성원 목록(이름/이메일/역할/상태), 초대 생성(→ 토큰/링크 모달), 역할 변경(select), 제거.

### 6.3 web 검증 편의
- 모든 페이지 "use client" + React Query. SSR 데이터 페칭 불필요(토큰 메모리). 로딩/에러 상태 표기.

---

## 7. Docker / 마이그레이션
- 새 npm 의존성 없음(web/api 모두). **단 web은 소스 바인드마운트라 즉시 반영, api/db는 재빌드.** budgets 테이블 → generate 0004 → migrate.
- 새 env `CORS_ORIGIN` → `.env` 추가. web은 `NEXT_PUBLIC_API_URL` 기존.
- 통합: (lockfile 변화 없음) build → generate 0004 → `.env` CORS 추가 → up --force-recreate → verify-phase5(backend) → next build 확인 → chrome 스모크.

---

## 8. 검증
### 8.1 백엔드 e2e — `scripts/verify-phase5.mjs`
HMAC 서명은 verify-phase4 재사용. 데이터 시딩(카드/승인·취소 문자 여러 건, 구성원 2명) 후:
1. analytics.monthly: totalNet = 수동 합과 일치, deltaNet 계산, 취소 반영.
2. categories: 합=totalNet, ratio 합≈1, 카테고리명.
3. members: 구성원별 net 합=totalNet.
4. cards: 카드별 net.
5. merchants: 가맹점별, 타인 summary_only '(비공개)'.
6. budgets: household 예산 생성 → usageRate=spent/amount 정확. category 예산 → 해당 카테고리 지출.
7. 권한: userB(member)로 조회 시 타인 private 제외(excludedByPermission>0 또는 net 차이), owner/admin만 예산 생성(member 403).
8. 금액 전부 정수.
통과/실패 카운트, 실패 시 exit 1. (문자 포맷은 packages/card-parsers 실제 구현 Read.)

### 8.2 프론트 — `next build` + claude-in-chrome 스모크
- 통합자(나)가 실행: dev 이미지로 `pnpm --filter @family/web build`(타입/빌드 성공) 또는 dev 서버 기동 확인.
- claude-in-chrome: http://localhost:3000 → /login → 시드 계정 로그인 → /dashboard 렌더(순지출/차트/최근거래 보임) 스크린샷. /transactions, /budgets 로드 확인.

---

## 9. 문서 / 커밋
- ADR: `docs/adr/0010-analytics-sql-and-budgets.md`(SQL 집계·공개범위 통계·예산 사용률·CORS/웹 인증 근거).
- `docs/api/analytics-budgets.md`: analytics/budgets API 예시.
- 커밋(PRD §38): `feat(db)` budgets → `feat(contracts)` → `chore(config)` cors → `feat(analytics)` → `feat(budgets)` → `chore(api)` cors 배선 → `feat(web)` foundation → `feat(web)` dashboard/transactions/budgets-devices-household → `test`/`docs`.

## 10. 파티션 맵
### Phase A (병렬) — 백엔드 + 웹 기반
- **P1 database**: schema.ts budgets 테이블 + enum + 추론타입.
- **P2 contracts**: analytics.ts + budget.ts + index 배럴.
- **P3 api-analytics**: `apps/api/src/analytics/**`, `packages/config/src/config.ts`(web.corsOrigin), `.env.example`(CORS_ORIGIN), `apps/api/src/main.ts`(enableCors), `apps/api/src/app.module.ts`(AnalyticsModule + BudgetsModule import 둘 다).
- **P4 api-budgets**: `apps/api/src/budgets/**`(app.module 미수정 — P3 담당).
- **P5 web-foundation**: `apps/web/src/lib/**`, `apps/web/src/components/**`, `apps/web/src/app/providers.tsx`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`(redirect), `apps/web/src/app/(auth)/**`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/app/globals.css`. (기존 health route `src/app/api/health/route.ts` 유지)

### Phase B (병렬, Phase A 완료 후) — 웹 페이지
- **P6 web-dashboard**: `apps/web/src/app/(app)/dashboard/page.tsx`(+필요한 dashboard 전용 컴포넌트).
- **P7 web-transactions**: `apps/web/src/app/(app)/transactions/page.tsx`.
- **P8 web-mgmt**: `apps/web/src/app/(app)/budgets/page.tsx`, `devices/page.tsx`, `household/page.tsx`.
(P6~P8은 P5 foundation의 api-client/auth-context/components/format/queries를 Read해 사용. foundation 밖 lib/components 신규가 필요하면 페이지 로컬 파일로.)

### Phase C — 검증/문서
- **P9 verify+docs**: `scripts/verify-phase5.mjs`, ADR 0010, `docs/api/analytics-budgets.md`.

주의: app.module.ts/main.ts/config는 **P3만** 수정. web foundation 공용 파일은 **P5만**, 페이지는 P6~P8이 각자 자기 page.tsx만. 각 에이전트는 본 스펙 + phase4/1/0 스펙 + 기존 소스(transactions/cards/household/devices api, contracts, 기존 web providers/page)를 Read.
