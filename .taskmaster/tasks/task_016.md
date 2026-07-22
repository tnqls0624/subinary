# Task ID: 16

**Title:** 외부 monitor·SLO·감사·retention 운영 기반 구축

**Status:** pending

**Dependencies:** 1, 8, 9

**Priority:** high

**Description:** 단일 Mac 밖에서 장애를 감지하고 서비스·파이프라인 SLO, 운영 감사, 로그 보존 정책을 운영화한다.

**Details:**

외부 synthetic monitor 제품을 비용·보존·알림 기준으로 선택하고 공개 health/Cloudflare 5xx를 5분 이내 감지한다. 운영 화면에 service health, queue depth/age, run 상태, Job 자원, disk, backup freshness를 통합한다. queue p95 5분, schedule delay 5분, 월간 공개 가용성 99.5%를 계산하고 계획된 유지보수를 별도 기록한다. 배포, 수동 run 제어, backfill, 모델 승인/승격/rollback의 actor/action/reason/result를 감사한다. orchestration 상세 30일, 감사 1년 보존과 자동 정리를 구현한다. 관련 요구사항: FR-025~028, FR-035~036, NFR-005~007, NFR-016, AC-014~016, AC-023~024.

**Test Strategy:**

외부에서 public health 실패와 Cloudflare 5xx를 주입해 5분 이내 감지/복구 알림을 확인한다. dashboard 지표와 원천 값을 대조하고 SLO 계산 경계, 계획된 유지보수 제외를 검증한다. 각 운영 action 감사 조회, actor 누락 거부, 31일 orchestration 로그 정리, 1년 감사기록 보존, PII redaction을 테스트한다.
