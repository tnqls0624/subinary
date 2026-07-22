# Task ID: 2

**Title:** 암호화 offsite restic 백업과 복구 검증 구축

**Status:** pending

**Dependencies:** None

**Priority:** high

**Description:** PostgreSQL과 MinIO 로컬 스냅샷을 다른 장애 도메인의 암호화 restic 저장소에 복제하고 복구 절차를 검증한다.

**Details:**

현재 backup 컨테이너와 snapshot manifest/checksum 생성을 기준으로 6시간 로컬 스냅샷, 24시간 이내 offsite 복제를 구성한다. restic credential과 repository password는 image, Git, orchestration metadata에 넣지 않고 운영 secret으로 주입한다. 대표 데이터량에서 backup duration과 I/O 영향을 측정해 heavy Job과 겹치지 않는 schedule을 확정한다. 격리 복원 runbook, DB↔MinIO 참조 무결성 검사, 실제 RPO/RTO 기록 형식을 함께 만든다. 관련 요구사항: FR-029~032, NFR-010~011, AC-017~018.

**Test Strategy:**

로컬 snapshot checksum 검증, offsite freshness 24시간 이내 확인, 손상 snapshot 거부, credential 누락 시 명확한 실패를 테스트한다. 격리 환경에서 PostgreSQL과 MinIO 대표 artifact를 복원하고 참조 무결성과 RTO 4시간 이내를 기록한다. backup 실행 중 API latency와 queue age 영향도 측정한다.
