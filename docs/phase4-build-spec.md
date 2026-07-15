# Phase 4 Build Spec — 거래 관리 (Cards & Transactions)

> Phase 4 구현의 **단일 진실 소스(SSOT)**. Phase 0~3 규약 준수(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, KRW 정수, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도 갱신, 새 npm 의존성 시 lockfile 재생성, **교차모듈 `@UseGuards`는 제공모듈이 가드 의존성까지 export**).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 4)

범위: 카드 등록 / 카드 자동 연결 / 승인 거래 / 취소 거래 / 부분 취소 / 카테고리 / 가맹점 규칙 / 공개 범위.

완료 조건(실측, `scripts/verify-phase4.mjs`):
1. 월별 순지출 정확(sum netAmount).
2. 전체 취소 반영(status='cancelled', netAmount=0).
3. 부분 취소 반영(status='partially_cancelled', netAmount=amount-cancelledAmount).
4. 카테고리 수정이 **이후** 거래에 적용(사용자 규칙 저장).
5. Private 거래 권한 적용(타인 private 거래 조회 제외).

### 경계 (이번 Phase에서 하지 않음)
- 본격 통계 API(`/v1/analytics/monthly|categories|members|cards|merchants`), 대시보드, 예산 → **Phase 5**. (Phase 4는 검증용 최소 요약 `GET /v1/transactions/summary`만.)
- LLM 카테고리 분류(§15 5순위) → Phase 7+. Phase 4는 사용자규칙→가족규칙→키워드→미분류까지.
- merchants/merchant_aliases 마스터 테이블 → 후순위. `merchantNormalized`는 경량 정규화 함수로.

---

## 1. 핵심 설계 결정

### 1.1 파싱→거래 승격 파이프라인 (worker, 멱등)
Phase 3 `card-sms-parse.processor`가 파싱 업데이트 후, `parseStatus in ('parsed','pending_review')`이면 `TransactionPromotionService.promote(cardSmsEventId)` 호출(같은 잡 내, 별도 큐 없음 → 10초 반영 유지). `parse_failed`는 승격 안 함.
- **멱등**: `card_transactions.sourceEventId` **UNIQUE**. 재승격 시 onConflictDoNothing → 기존 반환.
- 승인 거래 승격: 카드 자동연결 → 카테고리 분류 → 2차 유사중복 탐지(→`duplicate_suspected`) → netAmount=amount.
- 취소 거래 승격: 대응 승인 거래 탐색·연결(→ cancelledAmount 누적, netAmount 재계산, status 갱신) 또는 애매 시 `pending_review`.

### 1.2 순지출 규약
- `approval` 거래: `netAmount = amount - cancelledAmount`. 통계 = `sum(netAmount) WHERE transactionType='approval'`.
- `cancellation` 거래: 이력·감사용 레코드. `netAmount = 0`(통계 이중계상 방지), `parentTransactionId`로 승인에 연결.

### 1.3 카테고리 우선순위 (PRD §15, LLM 제외)
1. 사용자가 거래에 직접 지정(PATCH). 2. `merchant_category_rules`(household, merchantNormalized 정확매칭). 3. 키워드 규칙(`@family/shared` 순수 함수 → 시스템 카테고리 slug). 4. 미분류(null).
- 사용자가 거래 카테고리를 바꾸면 `merchant_category_rules`에 `(householdId, merchantNormalized) → categoryId` upsert → **이후** 승격/재분류에 반영(과거 거래 소급 안 함).
- 결제 대행사만 확인되면(파서 warning) 카테고리 미분류 + merchant 미확인 유지(임의 생성 금지).

### 1.4 공개 범위 (PRD §8, §26 — 서비스 계층 강제)
- 거래 `visibility`는 연결된 카드 visibility를 상속(카드 없으면 'household').
- 목록/상세 조회(actor memberId 기준): 반환 = `본인 거래 ∪ visibility='household' 거래`. 타인 `private` 제외. 타인 `summary_only`는 목록에서 가맹점 마스킹(통계엔 포함, Phase 5). Phase 4 목록은 타인 summary_only도 가맹점 마스킹해 포함.

### 1.5 카드 자동 연결
승격 시 파서 `maskedCardNumber`의 **뒤 4자리**와 같은 household `payment_cards.maskedNumber` 뒤 4자리 매칭 → `cardId` 연결 + 거래 visibility=카드 visibility. 매칭 없으면 cardId null, visibility='household'.

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

### pgEnum
- `cardVisibility` = `['private','household','summary_only']`
- `cardStatus` = `['active','inactive']`
- `txnType` = `['approval','cancellation']`
- `txnStatus` = `['approved','partially_cancelled','cancelled','pending_review','duplicate_suspected']`

### 테이블
```
payment_cards
  id uuid pk
  householdId uuid not null -> households.id
  ownerMemberId uuid not null -> household_members.id
  issuer text not null
  alias text not null
  maskedNumber text null
  cardFingerprint text null
  visibility cardVisibility not null default 'household'
  status cardStatus not null default 'active'
  createdBy uuid not null -> users.id
  createdAt / updatedAt
  INDEX(householdId), INDEX(householdId, maskedNumber)

expense_categories
  id uuid pk
  householdId uuid null -> households.id      -- null = 시스템 기본
  slug text not null
  name text not null
  isSystem boolean not null default false
  createdAt
  -- 시스템 카테고리 slug 유일: partial unique index (slug) where household_id is null
  -- household 커스텀 유일: unique (household_id, slug)  (Phase 4는 시스템만 사용)

merchant_category_rules
  id uuid pk
  householdId uuid not null -> households.id
  merchantPattern text not null               -- 정규화 가맹점명(정확 매칭)
  categoryId uuid not null -> expense_categories.id
  priority integer not null default 100
  createdBy uuid null -> users.id
  createdAt / updatedAt
  UNIQUE(householdId, merchantPattern)

card_transactions
  id uuid pk
  householdId uuid not null -> households.id
  memberId uuid not null -> household_members.id
  cardId uuid null -> payment_cards.id
  sourceEventId uuid not null -> card_sms_events.id   -- UNIQUE(멱등 승격)
  transactionType txnType not null
  status txnStatus not null
  amount integer not null                     -- KRW 정수
  cancelledAmount integer not null default 0
  netAmount integer not null
  currency text not null default 'KRW'
  merchantRaw text null
  merchantNormalized text null
  categoryId uuid null -> expense_categories.id
  approvedAt timestamptz null
  cancelledAt timestamptz null
  authorizationCode text null
  installmentMonths integer null
  parentTransactionId uuid null -> card_transactions.id
  visibility cardVisibility not null default 'household'
  memo text null
  createdAt / updatedAt
  UNIQUE(sourceEventId)
  INDEX(householdId), INDEX(householdId, memberId), INDEX(cardId), INDEX(householdId, transactionType), INDEX(parentTransactionId)
```

추론 타입 export(PaymentCard/…, ExpenseCategory/…, MerchantCategoryRule/…, CardTransaction/…). 마이그레이션 0003은 통합에서 generate. self-FK(parentTransactionId)는 drizzle `AnyPgColumn` 패턴으로 타입.

---

## 3. `@family/shared` — 카테고리 순수 로직 (`src/categorization.ts`)
- `interface CategoryDef { slug: string; name: string }`
- `const DEFAULT_CATEGORIES: CategoryDef[]` — 시스템 기본: `food(식비) cafe(카페) delivery(배달) transport(교통) fuel(주유) shopping(쇼핑) grocery(장보기) medical(의료) telecom(통신) subscription(구독) etc(기타)`.
- `const CATEGORY_KEYWORD_RULES: { keyword: string; slug: string }[]` — 예: 스타벅스/투썸/커피→cafe, 배달의민족/쿠팡이츠/요기요→delivery, GS칼텍스/S-OIL/주유→fuel, 지하철/택시/버스/카카오T→transport, 스타벅스… 등 한국 가맹점 키워드 다수.
- `function normalizeMerchant(raw: string): string` — 공백/지점 접미사(강남점 등) 트림, 대행사 접미사 정리(단, 대행사 자체명은 유지). 소문자화 없이(한글) 정규화.
- `function categorizeByKeyword(merchant: string): string | null` — 키워드 매칭 → slug, 없으면 null.
- barrel export. 순수(pino 무관).
- `packages/shared`에 vitest 추가(devDep) + `"test":"vitest run"` + `categorization.test.ts`(정규화/키워드 매칭 ≥6케이스). vitest.config.ts.

---

## 4. API 계약 — `packages/contracts` (`src/card.ts`, `src/transaction.ts`, `src/category.ts` + 배럴)

### card.ts
- `cardVisibilitySchema` = `z.enum(['private','household','summary_only'])`
- `cardCreateRequestSchema` = `{ householdId: uuid, issuer: string.min(1).max(50), alias: string.min(1).max(100), maskedNumber: string.max(40).optional(), visibility: cardVisibilitySchema.default('household') }`
- `cardUpdateRequestSchema` = `{ alias?: string, visibility?: cardVisibilitySchema, status?: z.enum(['active','inactive']) }`
- `cardSummarySchema`, 추론 타입.

### category.ts
- `categorySummarySchema` = `{ id, slug, name, isSystem: boolean }`
- 추론 타입.

### transaction.ts
- `transactionTypeSchema` = `z.enum(['approval','cancellation'])`, `transactionStatusSchema` = `z.enum([... 5개])`
- `transactionSummarySchema` = `{ id, householdId, memberId, cardId: nullable, transactionType, status, amount: int, cancelledAmount: int, netAmount: int, currency, merchantRaw: nullable, merchantNormalized: nullable, categoryId: nullable, categorySlug: nullable, approvedAt: nullable, cancelledAt: nullable, installmentMonths: int.nullable, parentTransactionId: nullable, visibility, memo: nullable, masked: boolean, createdAt }` (masked=true면 summary_only 마스킹된 항목)
- `transactionListResponseSchema` = `{ items: transactionSummary[], nextCursor: string.nullable() }`
- `transactionUpdateRequestSchema` = `{ categoryId?: uuid, merchantNormalized?: string, cardId?: uuid|null, memberId?: uuid, visibility?: cardVisibilitySchema, memo?: string, applyRule?: boolean }` (categoryId 변경 시 applyRule=true면 merchant_category_rules upsert)
- `linkCancellationRequestSchema` = `{ approvalTransactionId: uuid }`
- `transactionSummaryResponseSchema` (검증용 월 요약) = `{ period: {from,to,timezone}, totalNet: int, totalApproved: int, totalCancelled: int, includedMembers: string[], count: int }`
- 추론 타입.

---

## 5. apps/api 구현

### 5.1 cards 모듈 (`apps/api/src/cards/`)
- `card.service.ts` (Db 주입, requireMembership 경량 헬퍼): create/list/get/update. 권한: 등록/수정은 소유자(ownerMemberId=본인) 또는 owner/admin. maskedNumber는 뒤4자리만 저장 권장(경고 주석). ownerMemberId=본인 membership.
- `card.controller.ts` (`@Controller('cards')`, 일반 인증): GET `/`, POST `/`, GET `/:id`, PATCH `/:id`. DTO createZodDto.
- `cards.module.ts`.

### 5.2 categories 모듈 (`apps/api/src/categories/`)
- `category-seed.service.ts` (OnModuleInit): `DEFAULT_CATEGORIES`를 시스템 카테고리(householdId null)로 upsert(onConflictDoNothing, partial unique). idempotent.
- `category.service.ts`: `listCategories(householdId)` = 시스템 + household 커스텀(Phase 4는 시스템만), `resolveSlugToId(slug)` 헬퍼(worker도 유사 로직 필요 → 아래 승격 서비스가 자체 조회).
- `category.controller.ts` (`@Controller('categories')`): GET `/`.
- `categories.module.ts` (SeedService onModuleInit).

### 5.3 transactions 모듈 (`apps/api/src/transactions/`)
- `transaction.service.ts` (Db 주입, requireMembership):
  - `list(userId, {householdId, filters, limit, cursor})`: 멤버십 확인 → 공개범위 필터 적용(§1.4) → summary[]. 필터: memberId/cardId/type/status/category/기간/금액범위(PRD §17.4). summary_only 타인 항목은 merchantRaw/Normalized/memo null + masked:true.
  - `get(userId, id)`: 멤버십+공개범위. private 타인 → NotFound/Forbidden.
  - `summary(userId, {householdId, from, to})`: 검증용. sum(netAmount) where approval, 기간(approvedAt), 권한 반영. totalApproved/totalCancelled/count.
  - `update(userId, id, input)`: 권한(소유자/owner/admin). categoryId 변경 시 card_transactions.categoryId 갱신 + `applyRule`면 merchant_category_rules upsert(householdId, merchantNormalized, categoryId). merchantNormalized/cardId/memberId/visibility/memo 갱신. cardId 변경 시 visibility 재상속 옵션.
  - `linkCancellation(userId, cancellationId, {approvalTransactionId})`: 수동 연결. 취소↔승인 검증(같은 household, 금액/잔액) → parentTransactionId, cancelledAmount 누적, netAmount/status 갱신. 트랜잭션.
  - `markDuplicate(userId, id)`: status='duplicate_suspected'. `markValid(userId, id)`: duplicate_suspected/pending_review → approved(net 재계산).
- `transaction.controller.ts` (`@Controller('transactions')`): GET `/`, GET `/summary`, GET `/:id`, PATCH `/:id`, POST `/:id/link-cancellation`, POST `/:id/mark-duplicate`, POST `/:id/mark-valid`.
- `transactions.module.ts`.
- 공개범위/권한은 서비스 계층 강제(PRD §26). 로그에 금액/가맹점 최소.

### 5.4 app.module
- CardsModule, CategoriesModule, TransactionsModule import.

---

## 6. apps/worker — 승격 (`apps/worker/src/promotion/`)
- `transaction-promotion.service.ts` (Db 주입):
  - `promote(cardSmsEventId)`:
    1. card_sms_events 조회(parseStatus in parsed/pending_review, amount!=null). 아니면 skip.
    2. 이미 승격됨(card_transactions.sourceEventId 존재)? → skip(멱등).
    3. 카드 자동연결: maskedCardNumber 뒤4자리 → payment_cards. → cardId, cardVisibility.
    4. merchantNormalized = normalizeMerchant(merchantRaw).
    5. 카테고리: merchant_category_rules(household, merchantNormalized) → categoryId; 없으면 categorizeByKeyword→slug→expense_categories(시스템) id; 없으면 null.
    6. transactionType approval:
       - 2차 중복 탐지: 같은 household/card, 동일 amount, 유사 merchantNormalized, 승인시각 근접(±수분), 동일 authorizationCode → 있으면 status='duplicate_suspected' else 'approved'.
       - netAmount=amount, cancelledAmount=0, approvedAt=occurredAt.
       - insert card_transactions(onConflictDoNothing sourceEventId).
    7. transactionType cancellation:
       - insert cancellation 거래(netAmount=0, cancelledAt=occurredAt, status='approved'(자체) — 실제 status는 연결 결과 반영은 승인쪽).
       - 대응 승인 탐색(같은 household/card, transactionType='approval', 잔액>=취소액 or 근접, merchant 유사, approvedAt<cancelledAt, authorizationCode 우선). 유일 매칭 → parentTransactionId 설정 + 승인.cancelledAmount+=취소액, 승인.netAmount=amount-cancelledAmount, 승인.status = (cancelledAmount>=amount?'cancelled':'partially_cancelled'). 다중/불명확 → 취소거래 status='pending_review'(연결 보류).
    8. card_sms_events.updatedAt 갱신(선택). 로그는 id/type/status만.
  - normalizeMerchant/categorizeByKeyword는 `@family/shared`.
- `card-sms-parse.processor.ts` 확장: 파싱 update 후 parseStatus in (parsed,pending_review)면 `promotionService.promote(event.id)` await.
- `promotion.module.ts` 또는 processors.module에 TransactionPromotionService provider 추가. worker package.json 변화 없음(@family/shared 이미 의존).

---

## 7. Docker / 마이그레이션
- 새 npm 의존성: shared에 vitest(devDep)만 → lockfile 재생성. 새 테이블 → generate 0003 → migrate 적용.
- 통합: lockfile 재생성 → build → shared vitest → generate 0003 → up --force-recreate → verify-phase4.

---

## 8. 검증 — `scripts/verify-phase4.mjs` (Node crypto/fetch, HMAC 서명 재사용)
1. userA 회원가입+가족+장치.
2. 카드 등록(신한, maskedNumber '1234', visibility household) → cardId.
3. 승인 문자(신한, 카드번호 1234, 스타벅스, 12,500원) 전송 → 파싱→승격 폴링(≤10s): GET /v1/transactions → approval 거래, cardId 연결, netAmount=12500, categorySlug='cafe'(키워드).
4. 부분 취소 문자(같은 카드/가맹점, 5,000원) → 승인거래 status='partially_cancelled', cancelledAmount=5000, netAmount=7500.
5. 잔액 전체 취소(7,500원) → status='cancelled', netAmount=0.
6. 카테고리 수정: PATCH 승인거래 categoryId=food, applyRule=true → 규칙 저장. 같은 가맹점 새 승인 문자(다른 eventId) 승격 → categorySlug='food'(규칙 적용, **이후** 거래).
7. 공개범위: userB member 초대. userA가 private 카드 등록 + 그 카드 승인 문자 → userB의 GET /v1/transactions에 해당 private 거래 미포함. household 거래는 포함.
8. 월 요약: GET /v1/transactions/summary → totalNet = 승인 netAmount 합(취소 반영), 정수.
9. 2차 중복: 동일 카드/금액/가맹점/시각 유사 다른 eventId 승인 → status='duplicate_suspected'.
10. 금액 전부 정수/KRW.
통과/실패 카운트, 실패 시 exit 1. (파서 문자 포맷은 packages/card-parsers 실제 구현 Read해 일치.)

---

## 9. 문서 / 커밋
- ADR: `docs/adr/0009-transaction-model-and-promotion.md`(승격 파이프라인/취소연결/netAmount/공개범위/카테고리 근거).
- `docs/api/transactions.md`: 카드/거래/카테고리 API + 승격 흐름 예시.
- 커밋(PRD §38): `feat(db)` → `feat(contracts)` → `feat(shared)` categorization → `feat(cards)` → `feat(categories)` → `feat(transactions)` api → `feat(worker)` promotion → `test`/`docs`.

## 10. 파티션 맵
- **P1 database**: schema.ts에 4테이블 + enum + card_transactions.sourceEventId UNIQUE + self-FK + 추론타입.
- **P2 contracts**: card.ts / category.ts / transaction.ts + index 배럴.
- **P3 shared-categorization**: `packages/shared/src/categorization.ts` + index export + vitest(package.json devDep/script + vitest.config + categorization.test.ts).
- **P4 api-cards-categories**: `apps/api/src/cards/**`, `apps/api/src/categories/**`(seed 포함), `apps/api/src/app.module.ts`(CardsModule/CategoriesModule import).
- **P5 api-transactions**: `apps/api/src/transactions/**`, `apps/api/src/app.module.ts`(TransactionsModule import — P4와 app.module 충돌하므로 **P4가 app.module의 세 모듈 import를 모두 담당**, P5는 transactions 파일만 생성).
- **P6 worker-promotion**: `apps/worker/src/promotion/**`(transaction-promotion.service), `apps/worker/src/processors/card-sms-parse.processor.ts`(승격 호출 확장), `processors.module.ts`(provider 추가).
- **P7 verify+docs**: `scripts/verify-phase4.mjs`, ADR 0009, `docs/api/transactions.md`.

주의: app.module.ts는 **P4만** 수정(CardsModule/CategoriesModule/TransactionsModule 세 개 import 한 번에). P5는 transactions 모듈 파일만 만든다(app.module 미수정). 각 에이전트는 본 스펙 + phase3/2/1 스펙 + 기존 소스(card-sms, devices, household requireMembership, shared, database schema, worker processors)를 Read.
