# ADR-0018: 결정적 모델 traffic과 shadow 실행

## 상태

승인됨 (Accepted) — 2026-07-18

## 배경

오프라인 평가와 모델 승격·rollback은 구현됐지만, 기존 구조는 프로세스 시작 시 운영 provider 한 세트만
생성했다. 후보를 alias로 완전히 승격하기 전 실제 요청에서 검증하려면 다음 요구를 동시에 만족해야 한다.

- DB의 임의 값이 credential 또는 외부 provider 생성을 지시하지 않게 한다.
- 같은 요청은 정책이 유지되는 동안 같은 역할로 배정한다.
- shadow 후보의 결과·지연·실패가 사용자 응답을 바꾸지 않게 한다.
- live 후보 실패 시에도 운영 응답을 보존한다.
- prompt, 질문, 가맹점 원문을 routing 감사 데이터로 저장하지 않는다.
- alias, 후보 모델, 평가 근거, 호출 trace를 사후 연결할 수 있어야 한다.

## 결정

### 1. 후보 runtime identity와 credential은 환경 설정에 둔다

후보 LLM은 `AI_CANDIDATE_PROVIDER`, `AI_CANDIDATE_LLM_MODEL`,
`AI_CANDIDATE_LLM_MODEL_REVISION`으로 프로세스 시작 시 별도 생성한다. Gemini 후보는 선택적으로 별도 API
키를 사용하고, 없으면 운영 키를 재사용한다. `model_traffic_policies`는 후보 registry identity와 평가
근거만 보유하며 credential이나 object key를 저장하지 않는다.

runtime resolver는 정책 실행 직전에 후보의 scope/task, 승인 상태, 통과 평가, 승인 dataset, 모델 승인
근거와 실제 provider/model/version을 모두 재검증한다. 후보 경계만 잘못된 경우 primary-only로 폴백한다.
운영 alias 자체가 무효하면 기존 규칙대로 fail-closed한다.

### 2. 정책을 현재 alias revision에 고정한다

정책은 `modelAliasId`, `aliasRevision`, candidate model/evaluation, `shadow|live`, 1~10,000 basis point,
서버 생성 salt와 상태를 저장한다. alias마다 활성 정책은 하나뿐이며 새 정책은 이전 정책을 supersede한다.
alias 승격·rollback도 기존 활성 정책을 supersede해 과거 운영 모델을 기준으로 만든 정책이 재사용되지 않게
한다. 운영자는 정책을 명시적으로 pause할 수 있다.

### 3. 원문 없는 key를 SHA-256으로 결정적 버킷화한다

버킷은 `SHA-256(policy salt + NUL + routing key)`의 앞 32비트를 0~9,999 범위로 매핑한다. RAG 답변은
workspace/user/question을 메모리에서 hash한 값, 가맹점 분류는 기존 merchant hash를 routing key로 쓴다.
원문 key와 정책 salt는 API 응답·로그·AI trace에 노출하지 않는다.

### 4. shadow와 live 모두 primary fail-safe를 유지한다

- shadow: 선택 버킷에서 후보 호출을 비동기로 시작하지만 반환값은 폐기하고 primary 응답을 반환한다.
- live: 선택 버킷은 후보 응답을 사용한다. 후보가 실패하면 primary를 호출한다.
- 비선택 버킷: primary만 호출한다.

`ai_invocations`에는 정책 ID, mode, 호출 역할, bucket, 결정상 선택 여부를 기록한다. live 후보가 실패하고
primary로 폴백한 경우 후보는 `selected=true + failed`, primary는 `selected=false + succeeded`로 남아 결정과
실제 장애 폴백을 함께 재구성할 수 있다.

### 5. 초기 적용 대상은 LLM 두 경로로 제한한다

`rag-answer`와 `merchant-category`만 traffic 정책을 허용한다. embedding 후보를 같은 index에 섞으면
vector 공간과 차원이 달라질 수 있으므로 제외한다. reranker는 실제 후보 provider 구현과 온라인 품질
집계가 준비되면 동일 정책·trace 계약으로 확장한다.

## 결과

### 장점

- 후보를 사용자에게 노출하지 않고 실제 입력 분포에서 비용·지연·오류를 관측할 수 있다.
- 프로세스 credential 경계와 DB 승인 제어 평면을 분리한다.
- 동일 key의 모델 흔들림을 막고 정책별 할당을 재현한다.
- 후보 장애가 primary 가용성을 훼손하지 않는다.
- alias revision 변경이 오래된 traffic 정책을 자동 무효화한다.

### 단점과 후속 작업

- shadow 호출은 선택 비율만큼 외부 AI 비용을 추가한다.
- 비동기 shadow는 사용자 지연을 늘리지 않지만 프로세스 종료 직전 미완료 호출을 잃을 수 있다. 장기적으로
  별도 큐가 필요할 만큼 호출량이 커지는지 측정한다.
- 현재 정책 API는 online 후보 품질 지표를 자동 판정하지 않는다. 사람 라벨과 원문 없는 SLO 집계가 충분히
  쌓이면 shadow→live 자동 gate를 별도 결정으로 추가한다.
- reranker traffic과 embedding 재색인 전환은 각 모델 유형의 데이터 계약을 먼저 마련한 뒤 확장한다.
