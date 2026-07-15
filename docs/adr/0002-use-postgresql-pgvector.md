# ADR-0002: PostgreSQL 17 + pgvector 채택

## 제목

주 데이터베이스로 PostgreSQL 17, 벡터 검색 확장으로 pgvector 채택

## 상태

승인됨 (Accepted) — 2026-07-15

## 배경

Family Memory AI의 데이터는 성격이 이원적이다:

- **관계형 데이터**: 가족 구성원, 가계부(금액은 KRW 정수), 일정, 권한
  (`Visibility`/`Sensitivity`) — 강한 일관성과 트랜잭션이 필요.
- **벡터 데이터**: Phase 이후 단계의 RAG(기억 검색)를 위한 임베딩 — 유사도 검색이 필요.

두 종류의 저장소를 별도로 운영하면 데이터 동기화·권한 필터 이중 구현·백업 이원화 문제가
생긴다. 특히 벡터 검색 결과에 가족 단위 권한 필터를 적용해야 하므로, 벡터와 메타데이터가
같은 질의 엔진 안에 있는 것이 안전하다. 또한 self-hosted(docker compose) 운영이 전제라
관리형 전용 벡터 DB 의존은 피하고 싶다.

## 결정

- 단일 주 저장소로 **PostgreSQL 17**을 사용하고, 컨테이너 이미지는
  **`pgvector/pgvector:pg17`**을 사용한다.
- 확장은 postgres init SQL(`infrastructure/postgres/init/01-extensions.sql`)에서 생성한다:
  `vector`(임베딩), `pg_trgm`(키워드/유사 문자열 검색), `uuid-ossp`. 기본 Time Zone은 `Asia/Seoul`.
- ORM은 **drizzle-orm ^0.38** + **drizzle-kit ^0.30**, 드라이버는 **postgres.js ^3.4**
  (`prepare:false`로 트랜잭션 풀러 호환)를 사용한다.
- Phase 0에서는 도메인 테이블 없이 연결/확장 헬스체크(`checkConnection`, `checkPgVector`)와
  마이그레이션 툴링만 배치한다. 벡터 컬럼/인덱스(HNSW 등)는 RAG Phase에서 도입한다.

## 검토한 대안

1. **전용 벡터 DB (Qdrant/Weaviate/Milvus/Pinecone)**: 대규모 벡터 성능은 우수하나
   저장소가 이원화되어 권한 필터·트랜잭션·백업이 복잡해지고, 관리형(Pinecone)은
   개인정보를 외부에 두게 된다.
2. **Elasticsearch/OpenSearch**: 키워드+벡터 하이브리드에 강하지만 운영 무게(JVM, 메모리)가
   가족 규모 서비스에 과도하다.
3. **MySQL + 외부 벡터 스토어**: MySQL 자체 벡터 지원이 미성숙하여 결국 이원화가 필요.
4. **SQLite + sqlite-vec**: 가장 가볍지만 동시성(다중 프로세스 api/worker)과 서버 배포
   모델에 부적합.

## 장점

- 관계형+벡터+전문(trgm) 검색을 **단일 SQL 질의**로 결합 — 권한 필터를 벡터 검색과
  같은 트랜잭션 경계에서 적용 가능.
- 백업/복구/모니터링이 단일 시스템으로 수렴. self-hosted 운영 부담 최소.
- pgvector는 HNSW/IVFFlat 인덱스를 지원해 가족 규모(수만~수십만 벡터)에 충분.
- drizzle + postgres.js 조합은 타입 안전하고 가볍다.

## 단점

- 수억 규모 벡터·초고 QPS에서는 전용 벡터 DB 대비 성능 한계.
- DB 확장(스케일 업 중심)에 의존 — 벡터 워크로드가 커지면 OLTP와 자원 경합 가능.
- pgvector 버전과 PostgreSQL 메이저 업그레이드를 함께 관리해야 한다.

## 변경조건

- 벡터 수가 수백만을 넘거나 p95 검색 지연이 목표(예: 200ms)를 지속 초과하면
  읽기 전용 복제본 또는 전용 벡터 DB 분리를 재검토한다.
- 벡터 워크로드가 OLTP 성능을 간섭(버퍼/CPU 경합)하는 것이 관측되면 물리 분리를 검토한다.
- pgvector가 필요한 기능(예: 특정 거리 함수, 필터링 성능)을 제공하지 못하게 되면 대안을 재평가한다.
