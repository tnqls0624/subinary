# Task ID: 14

**Title:** Prefect POC 장애·재부팅·자원·PII 합격 검증

**Status:** pending

**Dependencies:** 13, 16

**Priority:** high

**Description:** POC-001~010 전체를 독립적으로 검증하고 production dependency 승격 또는 탈락 결정을 기록한다.

**Details:**

Prefect server/worker 중단, Launcher 중단, Docker Desktop 재시작, Mac 재부팅, 네트워크 단절, disk/memory 압박을 포함한 장애 시나리오를 수행한다. 공개 서비스 15분, run 조정 20분, terminal 경보 5분 목표를 측정한다. Prefect DB 제거 후 pipeline_runs로 미완료 run을 찾고 Prefect 중단 후 15분 내 기존 수동 trainer로 롤백한다. 상태·태그·로그·오류·CI artifact에서 PII, secret, 원문, MinIO object key를 검사한다. 10개 기준 중 하나라도 중대 실패면 Prefect를 production dependency로 승격하지 않는 ADR을 남긴다.

**Test Strategy:**

POC-001~010 체크리스트를 증거 링크, 명령 결과, 자원 시계열, 복구 시간과 함께 실행한다. 재부팅 2회 이상, 실패 주입, 오케스트레이터 DB 제거, manual fallback, PII/secret pattern scan을 검증한다. 합격 여부와 미달 기준을 리뷰어가 재현할 수 있어야 한다.
