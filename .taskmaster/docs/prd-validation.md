# AI 학습 데이터 파이프라인 인프라 v2 PRD 검증 보고서

> 검증 대상: `.taskmaster/docs/prd.md`
> 검증일: 2026-07-19
> 최종 판정: **PASS**
> 종합 점수: **92/100**
> Task 분해 가능 여부: **가능(YES)**

## 1. 검증 요약

PRD는 단일 Mac Docker 운영 환경의 실제 제약, 기존 PostgreSQL/MinIO/BullMQ 기반 AI 파이프라인,
운영 이미지 빌드 이력, 사람 라벨 부족, 오프사이트 백업 미연결 조건을 구체적으로 반영한다.

특정 오케스트레이터를 시스템의 기준으로 만들지 않고 다음 경계를 먼저 고정한 점이 타당하다.

- 실시간 이벤트 처리: Redis/BullMQ
- 배치 제어: 교체 가능한 오케스트레이터 어댑터
- 제품 실행 상태와 계보: 기존 `pipeline_runs`
- 격리 실행: allowlist 기반 Internal Job Launcher
- 데이터와 artifact: 로컬 PostgreSQL/MinIO
- 이미지 공급망: GitHub Actions→GHCR→digest 배포
- 운영 UI: 별도 ingress와 Cloudflare Access
- 장애 복구: local snapshot, offsite restic, restore drill

1차 POC를 self-hosted Prefect 3로 선정하되 합격·탈락 조건과 제거 가능한 롤백 경로를 둔 것도
도구 중립 설계 목표와 모순되지 않는다.

## 2. 영역별 점수

| 검증 영역 | 배점 | 점수 | 판정 |
|---|---:|---:|---|
| 프로젝트 개요·목표·범위 | 10 | 10 | 충족 |
| 기능·비기능 요구사항 | 20 | 18 | 충족 |
| 아키텍처·데이터 흐름·책임 경계 | 20 | 19 | 충족 |
| 단일 Mac 실현 가능성·자원 예산 | 15 | 12 | 조건부 충족 |
| 보안·개인정보·Docker 권한 | 15 | 14 | 충족 |
| CI/CD·마이그레이션·백업·복구 | 10 | 10 | 충족 |
| 수용 기준·로드맵·Task 분해성 | 10 | 9 | 충족 |
| **합계** | **100** | **92** | **PASS** |

## 3. 필수 필드 검증

| 필수 필드 | 결과 | 근거 |
|---|---|---|
| 프로젝트 목적 | PASS | §1, §2 |
| 범위와 비목표 | PASS | §2 |
| 대상 사용자 | PASS | §1.2 |
| 운영 제약 | PASS | §3.1 |
| 설계 원칙 | PASS | §3.2 |
| 현행 아키텍처 | PASS | §4 |
| 목표 아키텍처 | PASS | §5 |
| 기술 스택·도입 방향 | PASS | §5, §6 |
| 기능 요구사항 | PASS | FR-001~036 |
| 비기능 요구사항 | PASS | NFR-001~016 |
| 요구사항 우선순위 | PASS | §7.6 |
| 개발 로드맵 | PASS | M0~M6 |
| 수용 기준 | PASS | AC-001~024 |
| 리스크·미결정사항 | PASS | §17, §18 |
| 검증 계획 | PASS | §19 |

## 4. 일관성 검증

### 4.1 현행 구조와의 일관성

- PASS: PostgreSQL, Redis/BullMQ, MinIO, API, Worker, Web, Caddy, cloudflared, trainer, backup 구성이
  현재 production Compose와 일치한다.
- PASS: 실시간 처리 책임을 BullMQ에 유지해 기존 outbox, idempotency, retry 정책을 보존한다.
- PASS: 기존 데이터셋, 평가, 모델 registry, alias, canary, 삭제 전파를 재구현하지 않는다.
- PASS: 실제 학습을 사람 라벨 gate가 계속 차단하며 POC는 synthetic dry-run으로 한정한다.
- PASS: 현재 local image build를 GitHub Actions/GHCR 공급망으로 대체하는 목표가 명시돼 있다.

### 4.2 요구사항 간 일관성

- PASS: `pipeline_runs` canonical 원칙이 FR-011, FR-012, FR-016, AC-006과 일치한다.
- PASS: Docker socket 최소화 원칙이 FR-018~020, POC-007, AC-009~010과 일치한다.
- PASS: heavy Job 동시성 1이 FR-021, POC-006, AC-011과 일치한다.
- PASS: PII 외부 전송 금지가 NG-005, NFR-013, POC-010, AC-015와 일치한다.
- PASS: local/offsite RPO가 FR-029~031, NFR-010~011, AC-017~018과 일치한다.
- PASS: Prefect 제거 가능성이 FR-017, POC-009, AC-019와 일치한다.

### 4.3 요구사항 ID 검사

- 고유 기능 요구사항: FR 36개
- 고유 비기능 요구사항: NFR 16개
- 고유 POC 기준: POC 10개
- 고유 수용 기준: AC 24개
- 전제조건: PRE 5개
- 미결정사항: OQ 6개
- 정의 ID의 충돌 또는 서로 다른 의미로 재사용된 ID: 없음

## 5. 수정 반영 결과

초기 검토에서 발견한 다음 중간 수준 항목을 Task Master 등록 전에 PRD에 반영했다.

| 항목 | 반영 내용 | 결과 |
|---|---|---|
| 요구사항 우선순위 누락 | P0~P3 우선순위와 구현 게이트 추가 | 해결 |
| 운영 배포 승인 경계 | main 게시와 운영 배포를 분리하고 명시적 승인 요구 | 해결 |
| 운영자 변경 감사 | actor/action/reason/result 감사기록 추가 | 해결 |
| 로그·메타데이터 보존 | 상세 30일, 감사 1년 및 자동 정리 추가 | 해결 |
| read-only Job 쓰기 경로 | 크기 제한 tmpfs와 종료 시 폐기 요구 추가 | 해결 |
| 가용성 목표 | 단일 Mac에 맞는 월간 99.5% 목표 추가 | 해결 |

## 6. 발견사항

### 6.1 치명적(Critical)

없음.

### 6.2 높음(High)

없음.

### 6.3 중간(Medium)

#### VAL-M01: Prefect 메모리 예산은 실측 전 가정이다

- 내용: Prefect server+worker idle 1.25GiB 상한은 합리적이지만 현재 환경에서 검증된 값은 아니다.
- 영향: 상한을 넘으면 Docker Desktop과 제품 서비스가 메모리를 경합할 수 있다.
- 처리: OQ-001과 POC-005가 production 승격을 차단하므로 PRD 통과를 막지 않는다.
- Task 지침: POC 첫 단계에서 idle 30분과 peak run 메모리를 측정하고 실패 시 Prefect를 제거한다.

#### VAL-M02: Job Launcher 구현 방식은 확정되지 않았다

- 내용: 자체 allowlist API와 제한된 Docker API proxy의 최종 조합이 OQ-002로 남아 있다.
- 영향: Docker socket을 보유한 Launcher가 침해되면 host 전체가 위험하다.
- 처리: FR-018~020과 AC-009~010이 구현 선택보다 강한 보안 결과를 요구하므로 설계 수준에서는 수용한다.
- Task 지침: threat model과 negative security test를 먼저 작성한 후 구현 방식을 ADR로 확정한다.

#### VAL-M03: 6시간 backup 주기의 I/O 영향은 실측이 필요하다

- 내용: 현재 daily 기본값을 6시간으로 줄이면 PostgreSQL/MinIO와 heavy Job이 경합할 수 있다.
- 영향: API latency와 queue age SLO 저하 가능성이 있다.
- 처리: admission lock과 OQ-004가 명시되어 있어 통제 가능하다.
- Task 지침: 대표 데이터량으로 backup duration과 I/O를 측정한 후 실제 schedule을 확정한다.

### 6.4 낮음(Low)

#### VAL-L01: 외부 synthetic monitor 제품이 미정이다

- 외부 장애 도메인이라는 결과 요구사항은 명확하므로 구현 Task에서 비용·보존·알림 channel을 비교한다.

#### VAL-L02: Prefect와 이미지의 정확한 버전은 POC에서 고정해야 한다

- PRD가 특정 patch version을 고정하지 않은 것은 타당하지만, 구현 시 image digest와 lockfile로 확정해야 한다.

#### VAL-L03: 99.5% 가용성의 계획된 유지보수 기록 방식이 필요하다

- 운영 Task에서 maintenance start/end, 사유, 실제 downtime을 감사기록과 연결한다.

## 7. 실현 가능성 판정

### 7.1 자원

- 상시 서비스 메모리 상한은 heavy trainer를 제외하면 약 10GiB 안에 배치할 수 있다.
- Docker Desktop 12GiB 상한과 macOS 6GiB 확보 원칙이 물리 RAM 18GB에 부합한다.
- trainer/heavy Job을 동시성 1로 제한하고 backup과 겹치지 않게 해 peak를 통제할 수 있다.
- 모든 제한값은 Compose 설정과 실제 사용량 양쪽으로 검증해야 한다.

판정: **조건부 가능**. POC 자원 기준 초과 시 Prefect를 채택하지 않는 조건이 필수다.

### 7.2 운영

- CI를 임시 개발·검증 환경으로 사용해 별도 개발 서버 부재를 보완한다.
- 운영 Mac에서 build를 제거하면 과거 Docker disk 고갈의 주요 원인을 줄일 수 있다.
- canonical 상태를 기존 DB에 유지하므로 Prefect 장애·제거 시에도 수동 경로로 복구할 수 있다.
- single-host HA는 제공하지 않되 외부 감지와 offsite 복구로 장애 시간을 통제한다.

판정: **가능**.

### 7.3 보안·개인정보

- 원본과 artifact가 로컬 데이터면에 유지된다.
- external CI에는 synthetic fixture만 사용한다.
- UI와 control API가 공개 앱 경로와 분리된다.
- Docker 권한을 Job Launcher 하나로 격리하고 임의 실행을 거부한다.
- 감사기록과 보존정책이 추가되어 운영 변경 추적성이 확보됐다.

판정: **가능**, 단 Launcher negative test와 Cloudflare Access 검증이 배포 전 필수다.

## 8. Task 분해 가능성

판정: **가능(YES)**.

PRD는 다음 단위로 독립 Task를 만들 수 있을 만큼 구체적이다.

1. M0 외부 경보 연결
2. M0 restic offsite 구성과 복구 검증
3. Docker Desktop 자원·disk 기준선
4. PR ephemeral integration CI
5. GHCR arm64/multi-platform image 공급망
6. SBOM·provenance·release manifest
7. 운영 Compose digest 전환
8. 배포 preflight·migration·smoke·rollback
9. Pipeline Control 계약과 DB correlation
10. Job registry와 보안 정책
11. Internal Job Launcher와 negative test
12. idempotency·resource admission·reconciler
13. Prefect self-host POC
14. 장애·재부팅·자원·PII POC 검증
15. 첫 AI batch workflow 공존 전환
16. 외부 monitor·SLO·감사·retention
17. 월간 restore/reconciliation drill

각 Task는 구현 시 `task-execution-framework`의 Research→Plan→Implement→Review 절차를 따라야 한다.

## 9. 등록 조건

다음 조건으로 Task Master 등록을 승인한다.

- PRD 파일은 현재 수정 반영본을 사용한다.
- Task 생성 시 15~18개 상위 Task를 목표로 한다.
- M0/P0 작업이 M3/M4 오케스트레이터 도입보다 먼저 오도록 의존성을 설정한다.
- Prefect 설치 Task는 Job Launcher 계약·보안 Task에 의존해야 한다.
- production schedule 활성화는 POC-001~010 전체 통과에 의존해야 한다.
- 실제 모델 학습·승격은 사람 라벨 gate 충족과 별도 운영 승인에 의존해야 한다.

## 10. 최종 판정

**PASS — 92/100**

PRD는 현재 운영 환경에서 구현 가능한 수준으로 구체적이고, 핵심 위험에 대한 실패·롤백 조건이 있다.
남은 중간·낮은 위험은 모두 POC 또는 구현 Task의 측정·ADR로 닫을 수 있으며 Task 분해를 차단하지 않는다.
