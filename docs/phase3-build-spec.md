# Phase 3 Build Spec — 카드 문자 수집 & 파싱

> Phase 3 구현의 **단일 진실 소스(SSOT)**. Phase 0/1/2 규약을 그대로 따른다(패키지 `type:module` 금지, 공용 dev 이미지, 소스 바인드마운트, KRW 정수, Asia/Seoul, 로그 Secret/PII 금지, 새 env는 `.env`도 갱신, 새 npm 의존성 시 lockfile 재생성).

---

## 0. 목표 & 완료 조건 (PRD §31 Phase 3)

구현 범위: 카드 문자 수집 API / 원문 저장 / 중복 방지(멱등) / BullMQ 파싱 / 1~2개 카드사 Parser / 파싱 실패 검토.

완료 조건(실측, `scripts/verify-phase3.mjs`):
1. HMAC 서명된 카드 문자 전송 → 수락(200 queued).
2. 비동기 파싱 후 10초 이내 파싱 상태/결과 조회 가능(parseStatus='parsed', amount/merchant 정확).
3. 동일 eventId 재전송 → 중복 저장 없음(멱등, `duplicate:true`).
4. 파싱 실패 원문 확인 가능(parseStatus='parse_failed', 조회 API).
5. 승인/취소 판별, 금액은 KRW 정수.

### 경계 (이번 Phase에서 하지 않음)
- 정규화된 거래 모델(`card_transactions`), 카드 등록, 승인-취소 연결, 카테고리/가맹점 규칙, 공개범위 → **Phase 4**.
- Phase 3의 파싱 결과는 `card_sms_events`의 구조화 컬럼에 저장하고 `parseStatus`로 관리한다. "웹앱 반영"은 파싱된 문자 조회 API로 충족한다.
- 원문 보존 정책의 자동삭제 스케줄러는 후순위(보존정책 컬럼만 최소로 둘 수 있으나 Phase 3 필수 아님 — 생략).

---

## 1. 핵심 설계 결정

### 1.1 원문 보존 이중화 (DB + MinIO)
PRD §3.1 "원문 우선" / §11 "카드 문자 원문은 별도 Source Item으로 보존".
- `source_items`(범용 원문 레코드): MinIO `objectKey` + `contentHash` + 메타. 실제 원문 텍스트는 MinIO에 저장(`card-sms/{householdId}/{eventId}.txt`).
- `card_sms_events.rawContent`(text): 파싱 워커가 매번 MinIO fetch하지 않도록 DB에 편의 사본 보관. (향후 보존정책 삭제 시 rawContent + MinIO 객체 함께 제거.)
- 운영 로그에 원문 전체를 남기지 않는다(PRD §11 말미) — 로그는 eventId/해시/상태만.

### 1.2 멱등성 (PRD §14 1차 정확 중복)
- `card_sms_events` **UNIQUE(device_id, event_id)** — 동일 장치의 동일 eventId 재전송 차단.
- `content_hash` = `sha256(sender + "\n" + content + "\n" + receivedAtISO)` 저장(재전송/디버깅 보조, INDEX). 2차 유사중복(duplicate_suspected)은 Phase 4.
- 수집 흐름: `INSERT ... ON CONFLICT (device_id, event_id) DO NOTHING RETURNING`. 새로 생성된 경우에만 MinIO put + 파싱 enqueue. 충돌(기존 존재)이면 멱등 성공 응답(`duplicate:true`), 재파싱/재저장 없음.
- 파싱 잡은 `jobId = card_sms_events.id`로 등록해 중복 enqueue를 BullMQ 레벨에서도 방지.

### 1.3 파서 = 순수 패키지 `@family/card-parsers`
파서는 문자열→결과 순수 함수라 단위 테스트가 핵심(PRD §29). worker만 의존. api는 파서 불필요(파싱 결과 타입만 contracts).
- contracts 비의존(순환 방지). 자체 `CardSmsInput`/`CardSmsParseResult` 타입 export.
- date-fns/date-fns-tz 직접 의존(shared의 pino 유입 회피).
- vitest 단위 테스트(devDep). 통합 단계에서 `pnpm --filter @family/card-parsers test`로 실행.

---

## 2. 데이터 모델 — `packages/database` (schema.ts 확장)

### pgEnum
- `sourceKind` = `['card_sms','slack','manual']` (Phase 3는 card_sms만 사용, 향후 확장)
- `cardSmsParseStatus` = `['pending','parsed','parse_failed','pending_review']`
- `cardSmsTxnType` = `['approval','cancellation','unknown']`

### 테이블
```
source_items
  id uuid pk
  householdId uuid not null -> households.id
  kind sourceKind not null
  objectKey text not null              -- MinIO 객체 키
  contentHash text not null            -- sha256 hex
  sizeBytes integer not null default 0
  deviceId uuid null -> registered_devices.id
  memberId uuid null -> household_members.id
  receivedAt timestamptz not null
  createdAt
  INDEX(householdId), INDEX(contentHash)

card_sms_events
  id uuid pk
  householdId uuid not null -> households.id
  memberId uuid not null -> household_members.id
  deviceId uuid not null -> registered_devices.id
  sourceItemId uuid not null -> source_items.id
  eventId text not null                -- 장치가 보낸 eventId(UUID 문자열)
  sender text not null
  rawContent text not null             -- 원문(파싱 편의 사본)
  contentHash text not null
  receivedAt timestamptz not null
  parseStatus cardSmsParseStatus not null default 'pending'
  parseError text null
  -- 파싱 결과(구조화, Phase 4에서 card_transactions로 승격)
  issuer text null
  transactionType cardSmsTxnType null
  amount integer null                  -- KRW 정수(원). int4 최대 21억 충분
  currency text null default 'KRW'
  merchantRaw text null
  occurredAt timestamptz null
  maskedCardNumber text null
  installmentMonths integer null
  confidence integer null              -- 0~100 정수(부동소수 회피)
  parsedAt timestamptz null
  createdAt / updatedAt
  UNIQUE(deviceId, eventId)
  INDEX(householdId), INDEX(parseStatus), INDEX(householdId, parseStatus)
```

추론 타입 export(SourceItem/NewSourceItem, CardSmsEvent/NewCardSmsEvent). 마이그레이션 SQL은 통합 단계에서 `drizzle-kit generate`(0002).

> `amount`는 KRW 정수. `confidence`는 0~100 정수(파서 float 회피). `occurredAt`은 Asia/Seoul 기준으로 파서가 계산.

---

## 3. `@family/card-parsers` 패키지 (신규)

`packages/card-parsers/`. Phase 0 공통 package.json 형태(tsup, `type:module` 없음, `.js`=CJS/`.mjs`=ESM, sideEffects:false). deps: `date-fns`,`date-fns-tz`. devDeps: `tsup`,`typescript`,`vitest`,`@types/node`. scripts에 `"test":"vitest run"` 추가.

### 타입/인터페이스 (`src/types.ts`)
```ts
interface CardSmsInput { sender: string; content: string; receivedAt: Date; }
interface CardSmsParseResult {
  issuer?: string;
  transactionType: 'approval' | 'cancellation' | 'unknown';
  amount?: number;            // KRW 정수
  currency?: string;          // 'KRW'
  merchantRaw?: string;
  occurredAt?: Date;          // Asia/Seoul 기준 조합
  maskedCardNumber?: string;
  installmentMonths?: number;
  confidence: number;         // 0~100 정수
  warnings: string[];
}
interface CardSmsParser {
  readonly issuer: string;
  supports(input: CardSmsInput): boolean;
  parse(input: CardSmsInput): CardSmsParseResult;
}
```

### 파서 구현 (`src/parsers/`) — 최소 2개 + 디스패처
- `shinhan.parser.ts` (신한카드): content에 '신한' 포함 시 supports. 승인/취소 키워드, 금액 `12,500원`→12500, `MM/DD HH:mm`→occurredAt(Asia/Seoul, 연도는 receivedAt 연도, 12→1월 롤오버 방어), 가맹점(문자 말미 토큰), 할부('일시불'→null/1, 'N개월'→N).
- `kookmin.parser.ts` (KB국민카드): 'KB' 또는 '국민' 포함 시 supports. 동일 필드 추출(포맷 차이 반영).
- `dispatch.ts`: `parseCardSms(input): CardSmsParseResult` — 등록된 파서를 순회, 첫 `supports===true` 파서로 parse. 매칭 없으면 `{ transactionType:'unknown', confidence:0, warnings:['no matching parser'] }`. 결제 대행사(네이버페이/카카오페이/토스페이/KG이니시스)만 확인되면 merchantRaw는 대행사명으로 두고 warning('payment aggregator; merchant unconfirmed') 추가(PRD §15, 실제 가맹점 임의 생성 금지).
- `index.ts`: 타입 + `parseCardSms` + 파서 클래스 export.

### 금액/시간 규칙
- 금액: `Number(str.replace(/[,\s원]/g,''))` 후 `Number.isInteger` 검증. 실패 시 amount undefined + warning. 부동소수 금지.
- 시간: `MM/DD HH:mm`(연도 없음) → receivedAt의 연도로 `Asia/Seoul` zoned date 구성(date-fns-tz `fromZonedTime`). 미래로 튀면(수신월 < 파싱월 롤오버) 전년 처리.
- confidence: 모든 필수 필드(type/amount/occurredAt/merchant) 추출 시 90+, 일부 누락 시 감점, 매칭 실패 0.

### 단위 테스트 (`src/*.test.ts` 또는 `test/`)
vitest로 카드사별 승인/취소/할부/금액콤마/대행사/미매칭 케이스. 최소 8케이스. 금액 정수 검증 포함.

---

## 4. API 계약 — `packages/contracts` (`src/card-sms.ts` + 배럴)

- `cardSmsIngestRequestSchema` = `{ eventId: z.string().min(1).max(200), sender: z.string().min(1).max(100), content: z.string().min(1).max(4000), receivedAt: z.string().datetime() }` (PRD §10.3 형식)
- `cardSmsIngestResponseSchema` = `{ accepted: z.literal(true), eventId: string, processingStatus: z.enum(['queued','duplicate']), duplicate: boolean }`
- `cardSmsEventSummarySchema` = `{ id, eventId, sender, receivedAt: string, parseStatus: z.enum(['pending','parsed','parse_failed','pending_review']), issuer: nullable, transactionType: z.enum(['approval','cancellation','unknown']).nullable(), amount: number.int().nullable(), currency: nullable, merchantRaw: nullable, occurredAt: string.nullable(), installmentMonths: number.int().nullable(), confidence: number.int().nullable(), parseError: nullable, createdAt: string }` — rawContent는 상세 조회에서만.
- `cardSmsEventDetailSchema` = cardSmsEventSummary + `{ rawContent: string, maskedCardNumber: nullable }`
- `mobileEventStatusResponseSchema` = `{ eventId, parseStatus, processingStatus: string }` (수집 이벤트 상태 조회용, 간단)
- 추론 타입 export.

---

## 5. apps/api 구현

### 5.1 shared QUEUE_NAMES 확장
`packages/shared/src/constants.ts`의 `QUEUE_NAMES`에 `CARD_SMS_PARSE: 'card-sms-parse'` 추가(기존 TEST 유지). api(enqueue)/worker(process)가 공유.

### 5.2 ingestion 모듈 (`apps/api/src/card-sms/`)
- `card-sms-ingest.service.ts` (Db + ObjectStorageService + Queue 주입):
  - `ingest(device: {deviceId, householdId, memberId}, input: CardSmsIngestRequest)`:
    1. `contentHash = sha256(sender\n content\n receivedAt)`.
    2. `objectKey = card-sms/{householdId}/{eventId}.txt`.
    3. 트랜잭션: source_items insert + card_sms_events insert `ON CONFLICT (device_id,event_id) DO NOTHING RETURNING`.
       - drizzle: `.onConflictDoNothing({ target: [deviceId, eventId] }).returning()`. 반환 배열이 비면 중복.
       - 중복이면 트랜잭션 내 이미 만든 source_item은? → **먼저 card_sms_events 존재 확인** 후 없을 때만 source_item+event insert(간단·안전). 또는 event insert onConflict 결과로 분기. 권장: SELECT existing by (deviceId,eventId) → 있으면 duplicate 응답. 없으면 source_item insert → event insert(경합 시 unique 위반 catch→duplicate).
    4. 새로 생성 시: MinIO `putObject(objectKey, content, 'text/plain; charset=utf-8')` + 파싱 잡 enqueue(`queue.add('parse', { cardSmsEventId }, { jobId: cardSmsEventId })`).
    5. 응답 `{ accepted:true, eventId, processingStatus: created?'queued':'duplicate', duplicate: !created }`.
    - MinIO put 실패는 수집을 막지 않되(레코드는 남음) warn 로그 + 파싱은 rawContent(DB)로 진행 가능하므로 enqueue는 유지.
  - `getMobileEventStatus(householdId, eventId)`: card_sms_events 조회 → 상태 반환(가드가 준 householdId로 스코프).
- `card-sms-parse.queue.ts`: `BullModule.registerQueue({ name: QUEUE_NAMES.CARD_SMS_PARSE })` + 얇은 서비스(enqueue 래퍼) 또는 서비스에서 직접 InjectQueue.
- `card-sms.controller.ts` (`@Controller('mobile-events')` — Phase 2 mobile-events와 경로 공유하므로 **기존 MobileEventsController에 병합하지 말고** 새 컨트롤러 `@Controller('mobile-events')`로 두되 라우트 충돌 없게):
  - `@Public() @UseGuards(DeviceHmacGuard) @Post('card-sms')` → ingest. `@Device()`로 principal. DTO createZodDto(cardSmsIngestRequestSchema). 200.
  - `@Public() @UseGuards(DeviceHmacGuard) @Get('card-sms/:eventId/status')` → getMobileEventStatus (장치가 자기 이벤트 상태 폴링). 또는 일반 인증 조회로 대체 가능. **채택: 상태 조회는 아래 card-sms-events 조회(일반 인증)로 통일**, 장치용 status 폴링은 생략(검증 스크립트는 일반 인증으로 조회).
  - NOTE: Nest는 같은 path prefix의 컨트롤러 2개를 허용하나, 메서드 라우트가 겹치지 않아야 한다. Phase 2 ping과 Phase 3 card-sms는 다른 경로라 OK.
- `card-sms-query.service.ts` + `card-sms-events.controller.ts` (`@Controller('card-sms-events')`, 일반 인증):
  - `GET /v1/card-sms-events?householdId=&status=&limit=&cursor=` → requireMembership(household) → 목록(summary). status 필터(parse_failed 검토용). 페이지네이션(limit 기본 50, 최대 100).
  - `GET /v1/card-sms-events/:id` → 상세(detail, rawContent 포함). 멤버십 검증.
  - 권한: 가족 멤버만. 비멤버 403.
- `card-sms.module.ts`: imports [AuthModule(권한 헬퍼용 불필요시 제거), DevicesModule(DeviceHmacGuard 사용 위해 export된 것 import), StorageModule(ObjectStorageService), BullModule.registerQueue(CARD_SMS_PARSE)]. providers [CardSmsIngestService, CardSmsQueryService]. controllers [CardSmsController, CardSmsEventsController].
  - DeviceHmacGuard는 DevicesModule이 export하므로 import해서 @UseGuards로 사용.
  - 권한(requireMembership)은 household.service를 재사용하거나 자체 헬퍼. 순환 피하려 자체 경량 헬퍼(household_members active 조회) 사용 권장.

### 5.3 app.module
- `CardSmsModule` import 추가.

---

## 6. apps/worker 구현
- `apps/worker/package.json`: deps에 `@family/card-parsers: workspace:*` 추가.
- `apps/worker/src/processors/card-sms-parse.processor.ts`: `@Processor(QUEUE_NAMES.CARD_SMS_PARSE)` extends WorkerHost. `process(job)`:
  1. `{ cardSmsEventId } = job.data`.
  2. card_sms_events 조회(없으면 로그 후 리턴).
  3. `parseCardSms({ sender, content: rawContent, receivedAt })`.
  4. transactionType!=='unknown' && amount!=null → parseStatus 결정: confidence>=70 → 'parsed', warnings 있거나 confidence<70 → 'pending_review'. unknown/amount 없음 → 'parse_failed'(parseError=warnings.join).
  5. update card_sms_events(파싱 컬럼 + parseStatus + parsedAt=now). 금액 정수 assert.
  6. 로그는 eventId/status/issuer만(원문·금액 상세 최소, PII 주의). 반환 `{ cardSmsEventId, parseStatus }`.
- `processors.module.ts`: CardSmsParseProcessor 등록 + `BullModule.registerQueue({ name: QUEUE_NAMES.CARD_SMS_PARSE })`. DB는 global.
- worker는 card_sms_events 스키마 접근(@family/database) 이미 가능.

---

## 7. Docker / 마이그레이션
- 새 패키지 `@family/card-parsers` → Dockerfile의 `pnpm -r --filter "./packages/*" build`가 자동 빌드. worker deps 추가 → **lockfile 재생성 필요**.
- 새 테이블 → 통합에서 `drizzle-kit generate`(0002) → migrate 서비스 자동 적용.
- 새 env 없음(object storage/queue 기존). 통합 절차: lockfile 재생성 → build → generate(0002) → up --force-recreate → vitest(파서) → verify-phase3.

---

## 8. 검증
### 8.1 파서 단위 (`@family/card-parsers` vitest)
카드사별 승인/취소/할부/금액콤마/대행사/미매칭 ≥8 케이스, 금액 정수·occurredAt Asia/Seoul 검증.

### 8.2 e2e — `scripts/verify-phase3.mjs`
Node crypto/fetch. 장치 HMAC 서명은 verify-phase2 방식 재사용.
1. userA 회원가입+가족+장치 등록(secret).
2. 신한 승인 문자 card-sms 전송(HMAC) → 200 accepted queued.
3. 폴링(≤10s): GET /v1/card-sms-events?householdId=&status=parsed 또는 상세 → parseStatus='parsed', amount 정확(정수), transactionType='approval', merchant 일치.
4. 동일 eventId 재전송 → duplicate:true, 목록 count 증가 없음(멱등).
5. 신한 취소 문자 → transactionType='cancellation'.
6. KB 승인 문자 → parsed.
7. 파싱 불가(비카드) 문자 → 폴링 후 parse_failed, 상세로 원문 확인 가능.
8. 보안: userB(비멤버)가 card-sms-events?householdId=A 조회 → 403.
9. 금액 정수/통화 KRW 검증.
통과/실패 카운트 요약, 실패 시 exit 1.

---

## 9. 문서 / 커밋
- ADR: `docs/adr/0008-card-sms-ingestion-and-parsing.md`(멱등 수집·원문보존·파서 Strategy·비동기 파싱 근거, PRD §37).
- `docs/api/card-sms.md`: 수집 API(HMAC) + 조회 API + 문자 포맷/파싱 결과 예시.
- 커밋(PRD §38): `feat(db)` → `feat(contracts)` → `feat(card-parsers)` → `feat(card-sms)` api → `feat(worker)` processor → `chore(shared/api)` 배선 → `test`/`docs`.

## 10. 파티션 맵
- **P1 database**: schema.ts에 source_items/card_sms_events + enum(sourceKind/cardSmsParseStatus/cardSmsTxnType) + 추론타입.
- **P2 contracts**: `src/card-sms.ts` + index 배럴.
- **P3 card-parsers**: `packages/card-parsers/**`(types, 2파서, dispatch, index, vitest 테스트, package.json/tsconfig/tsup/vitest 설정).
- **P4 api-card-sms**: `apps/api/src/card-sms/**`(ingest service, query service, 2 controllers, module), `packages/shared/src/constants.ts`(QUEUE_NAMES 추가), `apps/api/src/app.module.ts`(CardSmsModule import), `apps/api/package.json`(필요 deps 확인).
- **P5 worker**: `apps/worker/src/processors/card-sms-parse.processor.ts`, `processors.module.ts`(등록+queue), `apps/worker/package.json`(@family/card-parsers 의존).
- **P6 verify+docs**: `scripts/verify-phase3.mjs`, ADR 0008, `docs/api/card-sms.md`.

각 에이전트는 본 스펙 + phase2/1/0 스펙 + 기존 소스(devices HMAC 가드, storage, database schema, contracts, shared constants)를 Read하고 자기 파티션만 담당. P4만 shared/constants·app.module·api package.json 수정. P5만 worker 파일 수정.
