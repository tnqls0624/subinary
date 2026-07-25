# ADR-0023: 카드 문자 AI 파싱 캐스케이드 (quote-grounded 추출 + 템플릿 레시피)

## 제목

"어떤 카드 문자가 들어와도 파싱된다"를 규칙 파서 → 템플릿 레시피 → LLM quote 추출 → 사람 검토
4계층 캐스케이드로 달성한다. LLM은 값을 **생성하지 않고 원문 구간만 지목**하며, 정규화는 기존
결정적 함수가 전담한다. 신경망 학습(딥러닝 NER)과 `model_registry` 기반 학습 파이프라인은
채택하지 않는다.

## 상태

2026-07-25 설계 · **S1~S4 구현 완료(미배포)** · S5 조건부 보류.

배포 전 확인: 마이그레이션 `0037`(enum `quarantined`)·`0038`(`card_sms_templates`)
미적용. `CARD_SMS_LLM_MODE`는 기본 `off`라 배포해도 동작이 바뀌지 않는다. `on`으로
올리기 전에 ① 마이그레이션 적용 ② Gemini Cloud Billing 활성화가 선행되어야 한다.

## 배경

현재 파싱은 `packages/card-parsers`의 정규식 파서 4종(토스/신한/KB/generic fallback)이 담당한다.
새 카드사·새 레이아웃이 등장할 때마다 사람이 파서를 추가해야 하고, 실패하면
`parse_status='parse_failed'`로 쌓인다.

요구는 "학습한 데이터로 어떤 문자든 파싱"이었다. 설계 전 프로덕션 실측:

| 항목 | 실측값 |
| --- | --- |
| `card_sms_events` 총건 | 52 (parsed 50, parse_failed 2) |
| 실패 사유 | 2건 모두 `no matching parser` |
| 발급사 | 삼성 25 · 현대 18 · 토스뱅크 7 · NULL 2 |
| 수집 기간 / 속도 | 8일 / **6.5건/일 ≈ 195건/월** |
| `confidence` 분포 | **100 × 49, 80 × 1, 0 × 2** |
| `occurredAt IS NULL` (parsed 중) | 1 |

## 결정

### 1. 딥러닝 NER을 채택하지 않는다

구조화 추출(1 입력 → 8 필드)을 신경망으로 학습하려면 통상 수천 건의 라벨이 필요하다. 현재 52건,
월 195건 유입으로도 수천 건까지 1년 이상이며, 그 사이 시스템이 동작하지 않는다.

대신 문제를 두 하위문제로 분해한다.

- **템플릿 식별** = 문자 → 어느 레이아웃인가. 스켈레톤 **exact match**로 푼다(통계 학습 불필요).
- **필드 추출** = 템플릿별 슬롯 위치. 템플릿당 사람 확정 라벨 **1건**이면 레시피가 유도된다.

이 분해 덕분에 요구 데이터량이 신경망 대비 3자리수 작다.

### 2. 4계층 캐스케이드

| 계층 | 구현 | 지연 | 비용 | 역할 |
| --- | --- | --- | --- | --- |
| **L0 규칙** | `packages/card-parsers/dispatch.ts` (현행) | <1ms | 0 | 기지 발급사. 현재 50/52 처리 |
| **L1 레시피** | `card_sms_templates` 지문→레시피 조회 | <5ms | 0 | 확정된 템플릿 재사용. LLM 0회 |
| **L2 LLM** | Gemini quote 추출 | 0.4~1.5s | 유료 | 미지 레이아웃 흡수 |
| **L3 사람** | 검토·수정 UI | 비동기 | 인건비 | 최종 안전망 + 레시피 씨앗 |

전이: L0가 `transactionType !== 'unknown' && amount != null && currency != null`을 만족하면 종료.
아니면 L1 → L2 → L3 순으로 내려간다. `declined`는 승격 대상이 아니므로 L0 확정 즉시 종료한다
(무의미한 LLM 비용 차단).

**confidence 임계값 기반 분기는 채택하지 않는다.** `computeConfidence`는 45/25/20/15만 감산하므로
도달 가능한 값이 이산적이고, 실측 분포는 {100, 80, 0} 세 값뿐이다. "70~84 구간" 같은 밴드 설계는
실제로 공집합이거나 단일 사례에만 걸린다. 전이는 **필드 완결성**으로만 판정한다.

### 3. quote-grounded 추출 — 환각 구조적 차단 (핵심)

LLM에 오프셋을 직접 요구하면 자주 틀린다. 대신 **원문 그대로의 인용구 + 몇 번째 출현인지**를
받고, 시스템이 `indexOf`로 오프셋을 확정한다.

```ts
// packages/card-parsers/src/spans.ts (신규)
export function resolveQuote(text: string, q: CardSmsQuote, maxLen = 64): Span | undefined {
  if (q.quote.length === 0 || q.quote.length > maxLen) return undefined;
  if (!Number.isInteger(q.occurrence) || q.occurrence < 1) return undefined;
  let idx = -1;
  for (let n = 0; n < q.occurrence; n += 1) {
    idx = text.indexOf(q.quote, idx + 1);
    if (idx < 0) return undefined; // 원문에 없음 → 환각 → 폐기
  }
  return { start: idx, end: idx + q.quote.length };
}
```

확정된 span을 원문에서 잘라 **기존 결정적 함수**(`parseAmount` / `parseOccurredAt` /
`parseInstallmentMonths`)에만 통과시킨다. 금액은 언제나 `parseAmount(slice)`가 만들며, LLM이 만든
것은 "어디를 보라"는 포인터뿐이다. 응답 스키마에 자유 텍스트 값 필드는 **존재하지 않고**, 유일한
비-span 출력은 4값 닫힌 enum `transactionType`이다(생성이 아닌 선택).

- PRD §3.3 "계산은 LLM이 하지 않는다" 충족: 수치는 전부 결정적 함수 산출.
- PRD §3.1 "원문 우선" 충족: 모든 필드가 `(cardSmsEventId, start, end)`로 역추적된다.

검증 순서 — ① 응답 스키마 화이트리스트(미지 키 있으면 전체 거부) → ② `resolveQuote` 성공 →
③ span 겹침 금지 → ④ 결정적 정규화 성공 → ⑤ L0 결과와 교차 일치. 하나라도 실패하면 L3.

**`currency` span은 필수다.** `parseAmount`는 slice 안에 `원` 또는 ISO 코드가 있어야 통화를
판정한다. quote가 `22.00`뿐이면 amount가 undefined가 되고, 반대로 외화에 KRW를 기본값으로 찍으면
승격 시 `10 ** currencyExponent` 환산 때문에 **100배 금액 오류**가 조용히 통과한다. 통화를 확정할
수 없으면 거부하고 L3로 보낸다.

### 4. 템플릿 지문 — 슬롯을 접지 않으면 캐시가 무의미하다

지문 설계를 실측 검증했다. 52건에 두 정의를 적용한 결과:

| 스켈레톤 정의 | 고유 템플릿 | 2건 이상 템플릿 커버율 |
| --- | --- | --- |
| 숫자런만 `#`로 치환 | **37종** | 46% |
| 숫자런 `#` + 고정어휘 밖 토큰 `@` | **22종** | 73% |

숫자만 접으면 가맹점명이 지문에 그대로 남아 **가맹점이 바뀔 때마다 새 지문**이 된다. 캐시 히트율
46%는 사실상 캐시가 없는 것과 같고, LLM이 계속 호출된다. 따라서 **가맹점·이름 슬롯을 반드시
흡수**해야 한다. 남은 파편화는 대부분 가맹점명 속 괄호·숫자(`(주)브로트아트`, `카카오T일반택시_1`)
때문이며 구두점 정규화로 추가 수렴 가능하다.

지문 계산 함수는 `packages/card-parsers`에 **단 하나** 두고 라벨링·캐시·서빙이 모두 같은 함수를
호출한다(키 공간 분화 방지).

### 5. 레시피는 DB 테이블, 학습 파이프라인은 만들지 않는다

지문 → 추출 레시피 매핑은 `card_sms_templates(fingerprint PK, recipe jsonb, approved_at,
source_event_id)` **테이블 하나**로 충분하다. 지문 일치는 exact match이므로 확률 라우터가 필요 없다.

기존 `model_registry` / `model_aliases` / `evaluation_runs` / canary / `dataset_snapshots` 경로를
카드문자 파싱에 확장하지 **않는다**:

- 통계 라우터(나이브베이즈)는 미지 지문을 "가장 비슷한 기지 템플릿"으로 오라우팅한다. 오탐은
  미탐보다 위험하다(틀린 금액이 조용히 승격). exact match는 이 실패 모드가 원천 없다.
- 학습 게이트(`minimumLabels: 100`, 클래스당 10)를 카드문자에 적용하면, 템플릿 계열이 실측 8종
  내외로 포화하므로 클래스 수 조건에 도달하기 어렵다.
- 글로벌 스코프를 열려면 `dataset_snapshots` / `model_registry` / `model_aliases`의
  `num_nonnulls(...) = 1` CHECK 완화 + `learning-training.service.ts:110`의 household 강제 해제 +
  contracts enum 확장까지 마이그레이션 3종 이상이 필요한데, 얻는 것이 exact-match 테이블과 같다.

### 6. `pending_review`를 실제 게이트로 만든다 (선결 과제)

현행 `transaction-promotion.service.ts:164`는 `parsed`와 `pending_review`를 **모두 승격**한다.
즉 `pending_review`는 라벨일 뿐 사람 게이트가 아니며, LLM이 처음 본 템플릿에서 뽑은 금액이
그대로 `card_transactions` → 예산·알림·AI 답변으로 흘러간다.

L2 결과에 human-in-the-loop를 걸려면 **승격을 차단하는 상태**(`quarantined` 또는 승격 차단 플래그)가
선행되어야 한다. 이것 없이는 검토 루프 전체가 무효다.

### 7. 마스킹은 길이를 보존해야 한다

LLM 전송 전 카드·계좌번호를 마스킹하되, **마스킹 문자열 길이 == 원문 길이**를 런타임 assert +
프로퍼티 테스트로 강제한다. 길이가 달라지면 이후 모든 span 오프셋이 밀려 `resolveQuote`가 조용히
잘못된 구간을 잘라낸다.

```ts
const redact = (m: string) => '•'.repeat(m.length - 4) + m.slice(-4); // 매치 전체 길이 기준
```

`maskedCardNumber`는 LLM에서 받지 않고 워커가 원문에서 로컬 계산한다 → 마스킹과의 모순 소멸.

또한 Gemini **무료 티어는 제출 콘텐츠를 모델 학습에 사용**하므로(유료 티어만 미사용 보장),
카드문자 원문을 보내려면 Cloud Billing 활성화가 전제다.

## 대안과 기각 사유

| 대안 | 기각 사유 |
| --- | --- |
| 신경망 NER 파인튜닝 | 수천 라벨 필요. 월 195건이어도 1년+ 소요, 그 사이 미동작 |
| NB 템플릿 라우터 | exact match로 충분. 오라우팅(최악 실패 모드)을 새로 도입 |
| `model_registry` 학습 파이프라인 확장 | 산출 건수 0. 마이그레이션 3종·글로벌 스코프 논쟁을 대가로 exact-match 테이블과 동일 결과 |
| confidence 밴드 기반 전이 | 실측 분포가 {100, 80, 0} 3값. 밴드가 공집합 |
| Redis 레시피 캐시로 서빙 | checksum·감사 밖의 두 번째 프로덕션 모델이 됨. 캐시는 LLM 호출 dedup까지만 |

## 구현 단계

| 단계 | 내용 | 상태 |
| --- | --- | --- |
| **S1** | `mask.ts`(길이보존 마스킹) · `template.ts`(지문) · `spans.ts`(quote 확정·불변식) · `card-parsers` 순수함수 export · 테스트 34종 | ✅ 완료 |
| **S2** | `quarantined` 상태(마이그레이션 0037) · `llm-span-extractor.service.ts` · `CARD_SMS_LLM_MODE` 3단 플래그 · 일일 상한 · 지문 단일화 · 프로세서 캐스케이드 | ✅ 완료 |
| **S3** | `POST /v1/card-sms-events/:id/review` · `card-sms-review.service.ts`(동기 승격 + `feedback_events` 라벨) · status 다중 필터 · 홈 검토 다이얼로그(원문 + 인라인 교정) | ✅ 완료 |
| **S4** | `recipe.ts`(후보 열거·`deriveRecipe`·`applyRecipe`) · `card_sms_templates`(마이그레이션 0038, 전역) · 검토 확정 시 레시피 자동 유도 · 워커 L1 계층 | ✅ 완료 |
| **S5** | (조건부, 지금 만들지 않음) 템플릿 20종+ **또는** 월 1,000건+ 도달 시 학습 파이프라인 재검토 | 보류 |

S4 실측(운영 52건): 2건 이상인 템플릿 8종에서 첫 건을 확정값으로 삼아 레시피를
유도하고 나머지 30건에 적용한 결과 **규칙 파서와 100% 일치**했다. 검증 과정에서
토스뱅크처럼 본문에 시각이 없는 레이아웃은 `receivedAt` 근사 폴백이 필요하다는 것이
드러나 `applyRecipe`에 반영했다(`toss.parser.ts`와 같은 규약).

S3의 라벨은 `feedback_events(targetType:'card-sms-parse', source:'human_confirmed',
labelSchemaVersion:'card-sms-parse-v1')`에 **템플릿 지문과 함께** 저장된다 — 지문이
없으면 S4가 레이아웃 단위로 레시피를 만들 수 없다. 교정 전 파서 결과(`previous`)도
같이 남겨 무엇이 틀렸는지 추적한다.

합계 약 2.5~3.5주. S3(검토 UI)는 "나중에"가 아니다 — L2가 검토 대기를 생산하는데 소비자가 없으면
큐가 적체되고 플라이휠이 즉시 멈춘다.

## 결과

- 목표 "어떤 문자가 들어와도 파싱"은 S2 완료 시점에 달성된다(미지 레이아웃 → LLM → 검토).
- 정상 상태 LLM 호출량은 템플릿 계열 수(실측 8종 내외) + 카드사 문구 개편 시 1회로 수렴한다.
- 금액 환각은 스키마상 불가능하다 — LLM 응답에 값 필드가 없다.
- 학습 데이터(`feedback_events` human_confirmed)는 S3부터 계속 축적되며, S5 재검토 시점의 입력이 된다.

## 관측

`llm_span_reject_rate`(LLM이 유효 span을 못 낸 비율), `human_correction_rate`(사람이 고친 비율),
`template_cache_hit_rate`, 검토 대기 적체 건수를 노출한다. 앞의 둘이 오르면 카드사 문구 개편
신호다. 기존 `pipeline_runs` / `ai_invocations`가 실행·호출 추적을 이미 담당한다.

## 관련

- ADR-0017 버전드 AI 학습 데이터 파이프라인 (여기서는 확장하지 않기로 결정)
- ADR-0018 결정적 모델 트래픽과 shadow
- ADR-0019 가맹점 라벨 검토 경계
- ADR-0022 격리된 학습 러너와 로컬 모델 artifact
