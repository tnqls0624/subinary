# ADR-0017: 버전·계보 중심 AI 학습 데이터 파이프라인

## 상태

승인됨 (Accepted) — 2026-07-18

## 배경

현재 시스템은 PostgreSQL/pgvector, Redis/BullMQ, MinIO를 기반으로 Slack·카드 문자 수집, RAG 인덱싱,
기억/그래프 추출, LLM 카테고리 제안을 수행한다. unique key와 upsert로 재실행 중복은 막지만, 청크와
임베딩을 현재값으로 덮어써 다음 요구를 만족하지 못한다.

- 특정 원본·코드·모델·프롬프트 버전으로 결과를 재현
- AI prediction과 사용자 확정 라벨 분리
- 삭제/동의 철회를 데이터셋과 파생물에 전파
- 고정 데이터셋으로 후보 모델을 baseline과 비교
- 평가를 통과한 모델만 운영에 승격하고 즉시 rollback

운영 규모는 개인/가족용 단일 홈서버이고, 현재 병목은 처리량이 아니라 재현성·관측성·거버넌스다.

## 결정

### 1. 기존 인프라를 유지하고 제어 평면을 추가한다

- PostgreSQL: 실행 상태, revision, 계보, feedback, dataset/evaluation/model registry
- MinIO: content-addressed 원본과 immutable 학습/평가 artifact
- Redis/BullMQ: 증분 처리, 재시도, backfill 실행
- Postgres outbox: 도메인 변경과 pipeline event를 원자적으로 발행

Kafka, Airflow/Dagster, 별도 lakehouse와 Feature Store는 현재 도입하지 않는다.

### 2. current projection과 append-only revision을 분리한다

기존 `chunks`, `embeddings`, memories/graph 테이블은 온라인 조회용 current projection으로 유지한다.
재현을 위해 source/chunk/embedding revision과 lineage를 append-only로 기록하고, current 전환은
트랜잭션 또는 active alias 변경으로 수행한다.

### 3. 모든 파생 결과에 명시적 버전을 기록한다

각 run/step은 code SHA, config hash, parser/chunker/redaction/extractor/prompt/model/schema version을 가진다.
AI 호출 trace에는 원문 대신 input fingerprint, token, latency, outcome만 기록한다.

### 4. 사람 확인과 AI prediction을 분리한다

AI가 만든 카테고리/기억/그래프 결과는 `model_prediction`이다. 사용자 승인·수정만
`human_confirmed` label이 되며, 기본 학습 데이터셋은 사람 확인 라벨과 검증된 gold만 포함한다.

### 5. 데이터셋은 immutable snapshot과 manifest로 관리한다

MinIO의 dataset artifact는 덮어쓰지 않는다. manifest에는 source revision, transform/label schema,
split 전략, checksum, consent scope, 생성 run을 기록한다. 삭제 source가 포함된 snapshot은 revoke하고
새 version을 생성한다.

신규 snapshot은 group의 최신 event를 기준으로 validation/test 기간을 분리하는 `group_time`을 기본으로
한다. 같은 group의 과거 row도 최신 event의 split로 함께 이동시켜 미래에 재등장한 group이 train에 남지
않게 한다. RAG query와 positive source는 연결 성분으로 묶어 어느 한쪽도 split을 가로지르지 않게 한다.
원본 group key 대신 seed가 적용된 SHA-256만 DB에 저장하며, builder와 승인 API가 group/target overlap 및
time cutoff를 각각 검증한다. 기존 80/10/10 hash 방식은 명시적 호환 옵션으로 유지한다.

### 6. 평가와 승인 없이는 모델을 운영에 반영하지 않는다

후보 모델은 고정 snapshot에서 baseline과 비교하고 전체·slice 품질, 안전, 비용, 지연 gate를 통과해야
한다. 운영 전환은 model/index active alias 변경으로 수행하며 이전 alias로 rollback할 수 있어야 한다.

### 7. cross-workspace 학습은 기본 비활성이다

workspace 내부 평가와 개인화를 기본으로 한다. 여러 사용자 데이터를 합치는 학습은 별도 opt-in,
가명화, retention, 삭제/재학습 정책을 갖추기 전에는 시작하지 않는다.

### 8. RAG publish를 기억·그래프 증분 추출 경계로 사용한다

RAG가 chunk revision과 embedding current projection을 원자적으로 게시한 뒤에만 기억·그래프용 outbox event를
각각 기록한다. consumer는 `(chunkId, chunkRevisionId)`를 입력으로 받고 current revision을 다시 검증한다.
BullMQ 순서를 신뢰하지 않으며 stale 잡은 결과를 쓰지 않는다. 수동 workspace 전체 추출 API는 장애 복구와
extractor version backfill용으로 유지한다.

기억 후보와 그래프 자동 관계는 chunk revision과 extractor version을 직접 기록한다. 그래프 entity의 공유
canonical projection과 원문 관측을 분리하기 위해 `graph_entity_mentions`를 두고, 편집 전 관측·관계는 삭제하지
않고 temporal validity를 종료한다. 명시적 사용자 supersede 관계는 자동 reconcile 대상에서 제외한다.

## 구현 현황 — 2026-07-18

- P0 실행/AI trace와 구조화 feedback 제어 평면을 구현했다.
- `source_revisions`, `chunk_revisions`, `embedding_versions`, `lineage_edges`를 추가하고 기존 projection을
  revision 1로 backfill한다.
- RAG worker는 content/source/transform identity가 같으면 revision과 embedding version을 재사용하고,
  변경 시에만 새 revision을 발행한다.
- 첫 Gold 경로로 owner-only memory-candidate snapshot API를 구현했다. 확정 feedback과 immutable chunk
  revision 참조를 JSONL/manifest로 저장하며 cross-workspace 결합과 원문 artifact 복사는 하지 않는다.
- Slack·카드 수집과 Slack 정규화 후속 처리는 `data_events` transactional outbox에 기록하며 Worker
  dispatcher가 lease/`SKIP LOCKED`/멱등 job id로 BullMQ에 at-least-once 발행한다.
- source 삭제는 tombstone revision과 `source.tombstoned.v1` event로 기록한다. Worker는 object storage,
  정규화 원문, descendant chunk/embedding/memory를 정리하고 영향 dataset snapshot을 revoke한다.
  개인정보 삭제 시에는 과거 본문 재현보다 삭제권을 우선하되 lineage 식별자는 감사 목적으로 유지한다.
- scope owner/admin 전용 격리 event 조회·재처리 API와 재처리 횟수/요청자/시각 감사를 구현했다.
- Slack 개별 편집·삭제는 current projection과 `slack.message.changed.v1`을 한 트랜잭션에 기록하고,
  해당 standalone message 또는 thread만 다시 인덱싱한다. 삭제 이력은 본문을 비우고 대상 청크가 비면
  tombstone revision으로 전환한다.
- Slack export 재수집은 기본 `merge`와 명시적 채널 범위 `snapshot`으로 분리한다. 첫 import만 전체 RAG를
  만들고 이후에는 생성·편집·삭제 및 작성자/채널 metadata 영향 target만 event로 발행한다. 기존 tombstone은
  원본 bundle에 다시 나타나도 복구하지 않으며 현재보다 오래된 `editedTs`도 stale change로 무시한다.
- RAG current publish는 `rag.chunk.memory-ready.v1`과 `rag.chunk.graph-ready.v1`을 fan-out한다. 기억·그래프
  worker는 대상 chunk revision만 추출하고 stale job을 거부하며, 자동 파생 결과에 revision/extractor 계보를
  기록한다. 편집·삭제 시 이전 기억 후보와 그래프 관측/관계를 current projection에서 종료한다.
- `evaluation_runs`, `model_registry`, 승인 근거, current alias와 append-only alias revision을 구현했다.
  dataset/model scope·task 일치와 전체/slice 기준을 서버가 판정하며, 통과 평가와 승인 dataset이 없으면
  모델 승인·승격을 차단한다. 승격/rollback은 advisory lock 안에서 alias revision을 원자적으로 바꾼다.
- source 삭제·편집으로 dataset이 revoke되면 연결 평가도 revoke하고 이를 사용하는 alias를 suspend한다.
  새 유효 평가로 재승격하거나 유효한 직전 모델로 rollback해야 suspension이 해제된다.
- provider 객체는 시작 시 환경변수로 구성한다. DB alias로 credential/provider를 임의 동적 생성하지 않으며,
  runtime resolver가 scope별 alias의 승인 모델·평가·dataset과 실제 provider/model/version/dimensions 일치를
  AI 호출 직전에 검사한다. alias가 존재하면서 불일치하면 API 503 또는 Worker 잡 실패로 차단한다.
- 첫 household Gold 경로로 `merchant-category` builder를 추가했다. 사람 확정 규칙만 정규화 merchant
  feature와 category slug로 고정하고 target 단위 group split을 사용한다. 규칙 label 변경 시 기존
  snapshot/evaluation을 revoke하고 alias를 suspend한다.
- RAG 검색 질의는 `consent=true`인 owner의 관련성 확정만 수집한다. 원문은 DB·trace에 넣지 않고 전용
  object에 격리하며 `rag_retrieval_examples`에는 query hash와 positive chunk revision 계보만 저장한다.
  같은 query hash는 하나의 split에만 들어가는 `rag-embedding` Gold snapshot을 생성한다.
- `rag-embedding` alias 승격/rollback은 registry `version`과 같은 immutable embedding version이 활성
  청크 100%를 덮을 때만 허용한다. 통과 벡터의 current projection과 alias를 한 트랜잭션에서 바꾸고
  gate 집계를 alias revision에 기록한다.
- 기존 alias 위 승격에는 immutable canary 정책을 만든다. runtime resolver가 검증한 alias revision을
  원문 없는 AI 호출 trace에 귀속하고, 해당 revision의 최소 표본·오류율·p95 지연만 집계한다. SLO 위반
  또는 관측 창 종료 시 표본 부족은 alias lock 안에서 직전 승인 모델로 자동 rollback하며 근거와 새
  revision을 감사 이력에 남긴다. 직전 모델도 무효라 rollback할 수 없으면 현재 alias를 suspend한다.
  source revoke/suspension은 미완료 canary도 supersede한다.
- API 제어 평면 monitor가 monitoring canary를 주기 평가하며 manual/scheduled trigger를 감사한다.
- 현재 alias revision에 묶인 deterministic shadow/live traffic 정책을 추가했다. 상세 runtime trust boundary,
  후보 장애 격리와 embedding 제외 결정은 ADR-0018에서 정의한다.
- memory/merchant/RAG dataset builder를 schema v2로 올리고 최신 event 기준 group-aware time holdout을
  기본 적용했다. `dataset_snapshot_items`에 salted group hash와 event time을 고정하며 snapshot 승인 시
  저장 row를 다시 집계해 group/target/time leakage 또는 감사 metadata 누락을 차단한다.
- source tombstone으로 RAG relevance example이 무효화되면 query object와 영향 Gold artifact/manifest도
  삭제한다. dataset registry의 checksum·계보는 감사 목적으로 남기되 원문 재현보다 삭제권을 우선한다.

## 결과

### 장점

- 기존 배포/운영 구조를 유지하면서 데이터셋 재현성과 감사 가능성을 얻는다.
- 현재 기능별 upsert 코드를 점진적으로 revision/current 구조로 전환할 수 있다.
- AI prediction의 confirmation bias와 자동 생성 라벨 오염을 막는다.
- 임베딩 모델 혼합을 방지하고 모델 전환·rollback이 명시적이 된다.
- source에서 dataset example까지 삭제 대상을 계산할 수 있다.

### 단점

- revision과 lineage 때문에 저장량과 마이그레이션 복잡도가 증가한다.
- current projection과 이력 사이 일관성을 유지하는 publish 로직이 필요하다.
- 별도 workflow 엔진이 없어 복잡한 backfill dependency는 앱 코드로 관리해야 한다.
- cross-workspace 학습을 늦추므로 초기 라벨 수가 적고 모델 개선 속도가 제한될 수 있다.

## 검토한 대안

1. **현재 upsert 구조만 유지**: 단순하지만 재현, 삭제 전파, 모델 비교가 불가능해 기각한다.
2. **Kafka + Airflow + lakehouse를 한 번에 도입**: 확장성은 크지만 단일 홈서버 규모에서 운영 복잡도와
   장애 면적이 과도해 기각한다.
3. **외부 MLOps SaaS에 모든 trace/dataset 저장**: 빠르게 시작할 수 있지만 가족/회사 원문과 식별자가
   외부로 이동하고 workspace 경계·삭제 정책 통제가 약해 기본안으로 채택하지 않는다.
4. **AI 출력을 자동 gold label로 사용**: 라벨 양은 늘지만 기존 모델 오류가 증폭되고 사용자 수정과
   구분되지 않아 기각한다.
5. **모델마다 별도 전체 스택 복제**: 격리는 좋지만 운영비가 크다. 초기에는 versioned index와 active alias로
   해결하고 처리량/격리 요구가 커질 때 재검토한다.

## 변경 조건

- BullMQ의 처리량/replay/ordering 한계가 반복적으로 관측되면 event bus 도입을 검토한다.
- backfill, 스케줄, dependency 관리가 앱 상태 머신으로 감당하기 어려워지면 workflow orchestrator를 검토한다.
- dataset 규모와 SQL/manifest 처리 시간이 운영 SLO를 넘으면 lakehouse/warehouse를 검토한다.
- 운영과 학습 자원 경합이 발생하면 training runner를 별도 호스트/클러스터로 분리한다.

## 상세 설계

[AI 학습 데이터 파이프라인 — 현행 분석과 목표 설계](../architecture/ai-learning-data-pipeline.md)를 따른다.
