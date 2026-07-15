# ADR-0010: SQL 집계 통계 · 공개범위 반영 집계 · 예산 사용률 · CORS/웹 인증

## 제목

가족 지출 통계(월/카테고리/구성원/카드/가맹점)와 예산 사용률을 **모두 drizzle SQL 집계**
(`sum`/`count`/`group by`)로 계산하고, 집계 대상 집합에 **공개범위(actor 기준)**를 반영하며
(본인 ∪ `household` ∪ `summary_only` 포함, 타인 `private` 제외), 순지출은 **`sum(netAmount)
WHERE transactionType='approval'`** 규약으로 취소 이중계상 없이 산출하고, 예산 사용률을
**현재월 스코프 순지출 / 한도**로 정의하며, web(3000)↔api(3001) cross-origin 통신을
**명시적 origin + credentials CORS**와 **access(메모리)/refresh(HttpOnly 쿠키)** 인증
흐름으로 연결하는 설계 채택(PRD §37, Phase 5).

## 상태

승인됨 (Accepted) — 2026-07-16

## 배경

Phase 4(ADR-0009)는 정규화 거래(`card_transactions`)와 `netAmount` 규약, 카드 상속
공개범위, 카테고리 우선순위를 확립했다. Phase 5는 이를 **읽기 전용 집계**(통계/대시보드)와
**예산 사용률**로 확장하고 Next.js 웹앱(3000)이 api(3001)를 호출하도록 연결한다(PRD §31 Phase 5).

요구 불변식:

- **계산은 SQL**(PRD §3.3): 모든 합산/카운트/그룹화는 DB에서 수행한다. LLM 프롬프트나 JS
  `reduce` 루프로 금액을 합산하지 않는다(정확성·성능·감사 가능성).
- **순지출 정확**(PRD §17): 취소·부분취소가 반영된 순지출을 이중계상 없이 계산한다.
- **공개범위 통계**(PRD §8/§16/§26): 통계는 **actor(요청자)** 기준으로 집계 대상을 정한다.
  본인 거래 ∪ `household` ∪ `summary_only`(타인 것도 **금액은 포함**), 타인 `private`는
  **제외**한다. 가맹점명을 노출하는 `merchants` 통계에서만 타인 `summary_only`를 `'(비공개)'`로
  묶는다(금액은 포함하되 가맹점명만 마스킹).
- **금액은 KRW 정수**, 기간 경계는 `Asia/Seoul`, 시각은 ISO 문자열.
- **예산 권한**(PRD §7.2): 예산 CRUD는 owner/admin만, 조회는 활성 멤버.
- **로그 비노출**(PRD §11): 금액/가맹점/PII/secret을 운영 로그에 남기지 않는다.
- **웹 인증**(PRD §7): access token은 노출 표면을 줄이기 위해 메모리에만 두고, refresh는
  HttpOnly 쿠키로 브라우저가 자동 전송한다. cross-origin이라 CORS가 credentials를 허용해야 한다.

설계 포인트는 다섯 가지다. (1) 집계를 어디서·어떻게 SQL로 할 것인가, (2) 순지출을 어떤 규약으로
합산할 것인가, (3) 공개범위를 집계에 어떻게 반영할 것인가, (4) 예산 사용률을 어떻게 정의할
것인가, (5) web↔api 인증/CORS를 어떻게 연결할 것인가.

## 결정

### 1. 집계는 SQL — 서비스 계층에서 drizzle `sum`/`count`/`group by`

- `analytics.service.ts`와 `budget.service.ts`는 집계를 전부 SQL로 수행한다. 예:
  `coalesce(sum(netAmount), 0)`, `count(*)`, `group by categoryId/memberId/cardId/merchant`.
- 드라이버가 `sum`을 문자열로 돌려줄 수 있으므로 `toInt()`로 정수화하고 `assertKrwInteger`로
  KRW 정수 불변식을 재확인한다(부동소수·NaN 차단). **JS 루프 합산은 금지**(검산용 재계산은
  검증 스크립트에서만).
- `ratio = net / total`, `total`도 동일 조건의 SQL `sum`으로 구한다. `total=0`이면 `ratio=0`.
- `merchants`는 `merchantNormalized` 기준 group by, 상위 N(기본 20)만 `order by net desc
  limit`으로 반환한다.

### 2. 순지출 규약 — `sum(netAmount) WHERE transactionType='approval'`

- 순지출은 **승인 거래의 `netAmount` 합**이다. 승인의 `netAmount = amount - cancelledAmount`라
  부분/전체 취소가 이미 반영되어 있고, 취소 레코드는 `netAmount = 0`이라 별도로 합산하지 않는다
  → **이중계상이 원천적으로 불가능**(ADR-0009 §4 계승).
- `monthly`는 추가로 `totalApproved=sum(amount)`, `totalCancelled=sum(cancelledAmount)`를
  같은 승인 집합에서 구해 `totalNet = totalApproved - totalCancelled` 관계를 만족시킨다.
- 전월 대비는 **직전 동기간**(같은 길이의 이전 창)의 순지출과 비교한다.
  `deltaNet = totalNet - previousNet`, `deltaRate = deltaNet / previousNet`이며
  `previousNet = 0`이면 `deltaRate = null`(0 나눗셈 회피).

### 3. 공개범위는 집계 WHERE 조건으로 actor 기준 강제

- 공통 조건: `householdId` 일치 + `transactionType='approval'` + `approvedAt ∈ [from, to)` +
  **가시성 스코프**.
- 가시성 스코프 SQL = `memberId = :actor OR visibility IN ('household','summary_only')`.
  즉 **본인 거래 ∪ household ∪ summary_only**를 금액에 포함하고, **타인 `private`는 제외**한다.
- `merchants`만 가맹점명을 드러내므로, group by 키를 CASE로 만들어
  **`memberId <> :actor AND visibility='summary_only'` → `'(비공개)'`**,
  `merchantNormalized IS NULL → '미확인 가맹점'`, 그 외 `merchantNormalized`로 그룹화한다.
- 모든 응답 `meta`에 `period{from,to,timezone}`, `cancellationApplied:true`,
  `includedMemberIds`, **`excludedByPermission`**(타인 `private` 승인 건수)를 실어 집계의
  포함/제외 근거를 투명하게 노출한다.
- 이 강제는 컨트롤러가 아니라 **서비스**에서 수행한다 — 새 집계 경로가 생겨도 동일 규칙이 적용된다.

### 4. 예산 사용률 — 현재월 스코프 순지출 / 한도

- `budgets`는 `(householdId, scopeType, scopeRefId)`로 유일하며 `scopeType ∈
  {household, member, category, card}`, `period='monthly'`, `amount`는 KRW 양의 정수다.
- `spent`는 **현재월**(`month=YYYY-MM` 또는 기본 이번달, Asia/Seoul 경계)의 스코프 순지출을
  §2·§3과 **동일한 규약**으로 SQL 집계한다. 스코프 필터: `member→memberId`,
  `category→categoryId`, `card→cardId`, `household→추가 필터 없음`(가시성 스코프는 항상 적용).
- `remaining = amount - spent`, `usageRate = spent / amount`(amount=0이면 0). `scopeLabel`은
  표시용('가족 전체'/구성원명/카테고리명/카드별칭)으로 배치 조회(N+1 회피)한다.
- 권한: `create/update/delete`는 `requireMembership(..., ['owner','admin'])`, `list`는 활성
  멤버. 비멤버는 존재 여부를 노출하지 않는 403. 스코프 중복은 사전 검사 + DB UNIQUE로 409.
- 예산 `spent`와 `analytics.monthly`(현재달, 같은 actor)의 `totalNet`은 **정의상 동일**하다
  (검증 스크립트가 이 일치를 assert한다).

### 5. CORS + 웹 인증 흐름 (web 3000 ↔ api 3001)

- api `main.ts`는 `listen` 이전에 `app.enableCors({ origin: config.web.corsOrigin,
  credentials: true })`를 등록한다. **와일드카드 금지**(credentials와 양립 불가) — 명시적
  origin만 허용한다. `CORS_ORIGIN`은 `@family/config`의 `web.corsOrigin`으로 주입하고
  `.env(.example)`에 기본값 `http://localhost:3000`을 둔다.
- refresh token은 **HttpOnly 쿠키**(`/v1/auth` 경로)로 브라우저가 자동 전송한다. 모든 웹
  fetch는 `credentials:'include'`로 쿠키를 동봉한다.
- access token은 **메모리(React context)**에만 둔다(로컬스토리지 금지 — XSS 노출 축소).
  앱 마운트 시 `POST /v1/auth/refresh`로 access를 복원하고(쿠키 있으면 자동 로그인),
  API 클라이언트는 **401 → refresh 1회 재시도 → 재실패 시 세션 종료**로 감싼다.

## 검토한 대안

1. **집계를 JS/LLM으로**: 애플리케이션에서 행을 끌어와 합산하거나 LLM에 위임. 부동소수·누락·성능·
   감사 문제가 크고 PRD §3.3에 반한다. DB 집계로 단일화했다.
2. **공개범위를 조회 후 애플리케이션에서 필터**: 타인 `private`가 잠깐이라도 프로세스로 넘어와
   실수로 노출/합산될 위험이 있다. **집계 WHERE**로 처음부터 제외해 표면을 없앴다.
3. **`summary_only`를 통계에서도 완전 제외**: 가족 총지출이 과소집계된다. 스펙은 금액 포함·가맹점만
   마스킹이므로 금액은 집계에 넣되 `merchants`에서만 `'(비공개)'`로 라벨링했다.
4. **취소를 음수 항목으로 합산**: 부호 실수·이중상쇄가 잦다. 승인 `netAmount` 합으로 단일화하고
   취소는 0으로 고정했다(ADR-0009 계승).
5. **예산 사용률을 임의 기간으로**: 월 예산 개념과 어긋난다. **현재월(스코프별)**로 고정하고
   `month` 파라미터로만 회계월을 이동한다.
6. **access token을 쿠키/로컬스토리지에 저장**: CSRF(쿠키) 또는 XSS(로컬스토리지) 표면이 커진다.
   access는 메모리, refresh는 HttpOnly 쿠키로 분리해 각 위험을 최소화했다.
7. **CORS origin 와일드카드(`*`)**: `credentials:true`와 함께 쓸 수 없고 보안상 위험하다.
   명시적 origin만 허용했다.

## 장점

- 모든 금액 집계가 DB에서 정확·일관되게 수행되고(부동소수/누락 차단) 성능·감사에 유리하다.
- 공개범위가 집계 WHERE 한 곳에 모여 진입점과 무관하게 일관되며 `excludedByPermission`으로
  투명하다. e2e(`verify-phase5.mjs`)로 회귀를 막는다.
- 순지출이 승인 `netAmount` 합이라 취소 이중계상이 불가능하고, 예산 `spent`가 `analytics`와
  정의상 일치해 대시보드·예산 화면이 서로 모순되지 않는다.
- access(메모리)/refresh(HttpOnly 쿠키) 분리 + 명시적 CORS로 토큰 노출/CSRF/CORS 오남용
  표면을 동시에 줄인다.

## 단점

- 집계마다 총합/그룹/메타를 위한 다중 쿼리가 발생한다(현재는 데이터 규모상 문제없음; 필요 시
  단일 쿼리/물화뷰로 최적화 여지).
- 공개범위·순지출 규약을 새 집계 경로마다 재적용해야 하므로 누락 방지를 위해 공통 헬퍼와
  테스트에 의존한다.
- access token을 메모리에 두어 새로고침 때마다 refresh 왕복이 필요하다(UX상 짧은 부트스트랩).
- CORS origin이 환경별로 고정이라 배포마다 `CORS_ORIGIN`을 정확히 설정해야 한다.

## 변경조건

- 집계 트래픽/데이터가 커지면 월별 사전집계(물화뷰/롤업 테이블)나 단일 쿼리 통합을 도입하되
  순지출·공개범위 규약은 유지한다.
- 정기결제 자동 탐지(별도 모델)·AI 질의 통계(PRD §17.7)가 필요해지면 Phase 7+에서 집계 경로를
  확장하되 공개범위 강제는 서비스 계층에 둔다.
- 다중 도메인/서브도메인 배포가 되면 CORS를 허용 origin 목록으로 확장하고 쿠키 도메인/`SameSite`
  정책을 재검토한다.
- 예산에 주간/연간·롤오버·알림이 필요해지면 `period`를 확장하되 사용률 정의(스코프 순지출/한도)는
  유지한다.
