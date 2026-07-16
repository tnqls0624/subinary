# ADR-0013: 장기 기억 — 규칙 기반 후보 추출 · 사용자 승인 · 원문 연결(provenance) · 현재/과거 supersede · 소유자 전용

## 제목

Slack 업무 기록(Phase 6/7 의 `chunks`)에서 **결정적 규칙 함수**로 Task/Decision/Incident/Procedure/
Fact **후보(candidate)** 를 추출하고, 사용자가 **검토 → 승인/거부**해야만 정식 **기억(memory)** 이 되며,
모든 기억은 **`memory_sources` 로 원문까지 역추적**되고, **현재/과거를 `validFrom`/`validUntil` +
supersede** 로 구분하며, 수정은 **`memory_versions`** 로 스냅샷하고, 접근은 **workspace 소유자 본인만**
허용하는 장기 기억 설계 채택(PRD §37/§20/§3.1/§26, Phase 8).

## 상태

승인됨 (Accepted) — 2026-07-16

## 배경

Phase 8 은 개인화 AI 의 **장기 기억** 계층이다(PRD §31 Phase 8). Phase 7 이 준비한 Slack 스레드/메시지
`chunks` 를 대상으로 다음 불변식을 만족해야 한다.

- **후보 기억 검토**: 자동 추출은 곧바로 기억이 되지 않는다. 사용자가 후보를 보고 승인해야 한다.
- **승인/거부**: 후보는 `memories`(승인) 또는 `rejected`(거부) 로 귀결된다.
- **원문 연결(PRD §3.1)**: 모든 기억은 근거가 된 원문(chunk → 원본 Slack 스레드)으로 역추적된다.
- **현재/과거 구분(PRD §20)**: 사실이 바뀌면 과거 기억은 보존하되(`superseded`) 현재 기억만
  "지금 유효"로 조회된다. 특정 시점 기준(asOf) 조회도 가능해야 한다.
- **수정과 삭제**: 기억은 편집할 수 있고, 편집 전 상태는 이력으로 남는다. 삭제는 soft delete.
- **접근제어(PRD §26)**: 기억은 개인 데이터다. `workspaces.ownerUserId == 요청자`인 소유자 본인만
  읽고 쓸 수 있으며 가족 구성원 포함 비소유자는 유출 0.

설계 포인트는 다섯 가지다. (1) 추출을 무엇이 수행하는가(LLM vs 규칙), (2) 후보를 어떻게 정식 기억으로
승격하고 원문을 어떻게 잇는가, (3) 현재/과거를 어떻게 표현하는가, (4) 재추출을 어떻게 멱등화하는가,
(5) 접근을 어디서 강제하는가.

## 결정

### 1. 추출 = 결정적 규칙 함수(`@family/rag`), LLM 교체 자리 유지

- 추출기는 순수 함수 `extractMemoryCandidates(text): MemoryCandidateDraft[]` 다(`packages/rag/src/
  extract.ts`). 랜덤/시간/I·O·LLM 을 쓰지 않아 같은 입력이면 항상 같은 후보를 낸다.
- 텍스트는 **세그먼트(문단/줄) 단위**로 본다. Slack 스레드 chunk 는 `"작성자: 내용"` 을 개행 결합하므로
  각 줄이 하나의 세그먼트다. 세그먼트마다 **최대 한 개**의 후보를 만들고, 한 텍스트 내 동일
  `(type, subject)` 는 합친다(멱등 키 차원과 동일하게 사전 dedupe).
- 분류는 **우선순위가 고정된 키워드 규칙**이다(결정성·키워드 중첩 해소):
  1. `incident` — incident 키워드(`장애/에러/오류/실패/문제/incident`) **와** 해결 맥락 마커
     (`해결/복구/조치/해소/resolved/fixed`)가 함께 있을 때(가장 구체적, composite).
  2. `task` — `담당/맡/할 일/작성 예정/TODO/하기로 했`(‘하기로 했’ 를 `decision` 의 부분문자열
     ‘하기로’ 보다 먼저 잡아 task 로 귀속).
  3. `decision` — `결정/하기로/선택했/decided`.
  4. `procedure` — `절차/방법/순서/단계/how to`.
  5. `preference` — `선호/좋아/싫어`.
  6. `fact` — 정보성 fallback.
- `subject` = 첫 문장/핵심구(≤120자), `content` = 세그먼트 발췌(≤500자). `confidence` 는 규칙 강도 —
  키워드 매칭 90, 순수 fact 60. 키워드 없는 10자 미만 세그먼트는 **노이즈로 skip**(잡담 배제).
- 근거: PRD 상 실제 추출은 LLM 이지만, Mock 환경에서 **모델 비종속·결정적 검증**(`verify-phase8.mjs`)을
  가능케 하려면 순수 함수 경계가 필요하다. 실제 `LlmProvider` 추출로 교체해도 이 시그니처/후보 스키마와
  이후 승인 파이프라인은 그대로다(ADR-0004 계승).
- 추출 실행은 **비동기 큐** `memory-extract`(worker)에 위임한다. api 는 소유 검증 후 enqueue 만 하고
  `202 Accepted` 로 응답한다. 커스텀 jobId 는 `memory-extract_<workspaceId>`(BullMQ 제약상 `:` 대신 `_`).

### 2. 후보 → 승인 → 기억, 그리고 원문 연결(provenance)

- 후보(`memory_candidates`, status='pending')는 정식 기억이 아니다. 사용자가 `GET /candidates` 로
  검토하고 `approve`/`reject` 한다.
- **승인**은 한 트랜잭션에서 `memories`(status='approved') 를 만들고, `memory_sources` 로 원문을 잇고,
  `memory_versions` v1 스냅샷을 남기며, 후보를 `approved`(+`promotedMemoryId`)로 표시한다. 승인 시
  `subject/content/validFrom/validUntil` 을 편집할 수 있다(사람이 최종 확정).
- **원문 연결(PRD §3.1)**: 후보는 `sourceChunkId`(chunk uuid)와 `sourceRefId`(chunk 의 원본 Slack
  threadTs/ts)를 갖는다. 승인 시 `memory_sources` 에
  `{ sourceType:'chunk', sourceRefId: <chunkId> }` 와, 원본 참조가 있으면
  `{ sourceType:'slack_message', sourceRefId: <threadTs> }` 를 넣어 **chunk → 원본 Slack 스레드까지
  역추적**한다.
- **직접 기억(PRD §20 "명시적으로 기억 요청 → 즉시 승인")**: `POST /memories` 는 후보 단계 없이
  `approved` 기억을 만들고 `{ sourceType:'manual' }` provenance 를 남긴다(원문은 자기 자신).
- 근거: 자동 추출을 무비판 신뢰하면 오탐이 개인 기억을 오염시킨다. **후보 게이트**로 사람의 통제를
  두고, provenance 로 "이 기억은 어디서 왔는가"를 항상 답할 수 있게 한다.

### 3. 현재/과거 = `validFrom`/`validUntil` + supersede

- 각 기억은 `observedAt`(관측 시점), `validFrom`(유효 시작, 기본 observedAt), `validUntil`(null=현재
  유효)을 갖는다.
- **supersede**: 새 사실 B 가 기존 A 를 대체하면 트랜잭션에서 A 를 `superseded`(`validUntil=now`)로
  닫고, B 를 새로 만들어 `supersedesMemoryId=A.id`, `validFrom=now`, `validUntil=null` 로 둔다. A 의
  provenance 는 B 로 복사한다(없으면 `manual`).
- 조회는 **애플리케이션 로직**이다(SQL WHERE, PRD §3.3):
  - `current=true` → `status='approved' AND (validUntil IS NULL OR validUntil > now)`.
  - `asOf=DATE` → `validFrom <= asOf AND (validUntil IS NULL OR validUntil > asOf)` — 과거 시점의
    스냅샷(당시 유효했던 기억, `superseded` 포함).
- `isCurrent` 는 응답에 파생 포함한다(approved && validUntil null|미래).
- 근거: 사실은 시간에 따라 바뀐다. 과거를 지우지 않고 닫아두면 "언제 무엇이 사실이었나"를 재현할 수
  있고, 현재 조회는 최신만 본다.

### 4. 수정 이력 = `memory_versions`(변경 전 스냅샷)

- `PATCH /memories/:id` 는 **변경 전** 상태를 `memory_versions`(version = 현재 최대 + 1)로 먼저 저장한
  뒤 변경을 적용한다. 승인/직접생성 시 v1 을 남기므로 수정마다 v2, v3 … 으로 증가한다.
- 근거: 개인 기억의 편집은 되돌아볼 수 있어야 한다. 스냅샷 방식은 감사/복원에 단순하고 안전하다.

### 5. 접근제어 = workspace 소유자 본인만(SQL + 엔티티 해석 후 재검증)

- 모든 memory 연산은 대상 workspace 소유(`ownerUserId == 요청자`)를 확인한다 — 없는 workspace 는
  `404`, 소유자가 아니면 `403`. 후보/기억을 **먼저 해석한 뒤** 그 workspace 소유를 재검증하므로
  비소유자는 남의 기억을 읽거나 승인/수정/삭제할 수 없다(PRD §26).
- 로그는 식별자/개수만 남기고 `subject`/`content`/PII/secret 은 남기지 않는다(PRD §11).

### 6. 멱등 = `UNIQUE(workspaceId, sourceChunkId, type, subjectHash)` + onConflictDoNothing

- 후보 멱등 키는 `UNIQUE(workspaceId, sourceChunkId, type, subjectHash)` 다(`subjectHash = md5(subject)`
  를 앱이 계산). worker 는 배치 upsert 에 **`onConflictDoNothing`** 을 쓴다.
- `DoUpdate` 가 아니라 `DoNothing` 인 이유: 재추출이 **이미 승인/거부한 후보의 status 를 pending 으로
  되돌리면 안 되기 때문**이다. 키가 충돌하면 기존 행을 그대로 둔다 → extract 재실행해도 후보가 중복
  생성되지 않고 사용자 결정도 보존된다(`verify-phase8.mjs` §12).

## 검토한 대안

1. **자동 추출 즉시 기억화(후보 단계 생략)**: 오탐이 개인 기억을 오염시키고 되돌리기 어렵다. **후보
   게이트 + 사람 승인**으로 통제했다. 명시적 요청만 직접 승인(`manual`)으로 예외.
2. **LLM 추출을 Phase 8 에서 바로 사용**: 비결정적이라 e2e 검증이 어렵고 비용/모델 종속이 생긴다.
   **결정적 규칙**으로 파이프라인을 완성하고 순수 함수 경계로 LLM 교체 자리를 남겼다(PRD §3.4).
3. **원문을 문자열로만 저장(별도 테이블 없음)**: 역추적/무결성/다중 출처 표현이 약하다. 별도
   `memory_sources(memoryId, sourceType, sourceRefId)` + `UNIQUE` 로 chunk·원본 스레드·manual 을 함께
   표현했다.
4. **과거 기억을 삭제/덮어쓰기**: 시점 재현이 불가능해진다. `validUntil`+`superseded` 로 **닫되 보존**하고
   `asOf` 조회를 제공했다.
5. **버전을 in-place 필드로만 관리**: 편집 이력이 사라진다. 변경 전 스냅샷을 `memory_versions` 에
   누적해 감사/복원을 가능케 했다.
6. **후보 upsert 를 `onConflictDoUpdate`**: 재추출이 승인/거부 status 를 pending 으로 되돌린다.
   **`onConflictDoNothing`** 으로 사용자 결정을 보존했다.
7. **현재/과거 판정을 LLM/뷰로**: 비결정적이거나 비싸다. `validFrom/validUntil` + SQL WHERE(앱 로직)로
   결정적으로 판정했다(PRD §3.3).

## 장점

- 후보 게이트로 자동 추출의 오탐이 개인 기억을 오염시키지 않고, 사람이 최종 통제한다.
- 규칙 추출이 결정적이라 `verify-phase8.mjs` e2e 가 모델 비종속으로 통과하고, LLM 추출로의 교체 경계가
  분명하다.
- `memory_sources` 로 모든 기억이 chunk → 원본 Slack 스레드까지 역추적된다(PRD §3.1).
- `validFrom/validUntil`+supersede 로 현재/과거를 보존·구분하고 `asOf` 시점 재현이 가능하다.
- `memory_versions` 로 편집 이력이 남아 감사/복원이 쉽다.
- `UNIQUE`+`onConflictDoNothing` 으로 재추출이 안전(중복 0, 사용자 결정 보존).
- 소유권을 엔티티 해석 후 재검증해 workspace 간 기억 유출을 막는다(PRD §26).

## 단점

- 규칙 추출은 키워드 기반이라 한국어 표현 다양성/문맥을 놓쳐 재현율(recall)이 낮고 오분류가 있을 수
  있다 — 품질은 실제 `LlmProvider` 추출로만 끌어올릴 수 있다(설계상 의도된 경계).
- 세그먼트(줄) 단위 분류라 여러 문장이 한 줄에 섞이면 대표 type 하나만 잡는다.
- `event` 타입은 규칙 추출이 만들지 않는다(공통 Timeline `personal_events` = Phase 9). `memory_feedback`
  도 후순위.
- `memory_versions` 스냅샷은 저장량이 편집 횟수에 비례해 증가한다(개인 기억 규모에선 무시 가능).
- 후보 멱등 키가 `subjectHash(md5(subject))` 라, 승인 시 subject 를 크게 편집하면 원 후보와의 연결은
  `promotedMemoryId` 로만 유지된다(멱등 키는 재계산되지 않음).

## 변경조건

- 실제 LLM 추출을 켜면 `extractMemoryCandidates` 를 `LlmProvider` 기반으로 교체하되 후보 스키마·승인·
  provenance·현재/과거·소유권 규칙은 그대로 둔다(순수 함수 → provider 경계 이동).
- 카드/SMS·공통 Timeline(`personal_events`, Phase 9)·GraphRAG(Phase 10)가 붙으면 `memory_sources`
  의 `sourceType`(`card_sms` 등)과 추출 소스를 확장하되 멱등 키·소유자 전용 접근은 유지한다.
- `memory_feedback`(사용자 피드백으로 기억 강화/약화)을 도입하면 confidence 갱신 규칙과 함께 추가한다.
- 후보 정확도 요구가 커지면 규칙에 신뢰도 임계/문장 분할기를 정교화하거나 rerank/LLM 검증 단계를 얹는다.
