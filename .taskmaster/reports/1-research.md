# 분석 리포트 - Task 1

**생성일**: 2026-07-19
**태스크**: 외부 운영 경보 수신 채널 연결

## 종합 요약

| 항목 | 값 |
|------|-----|
| 태스크 분류 | 운영 인프라 기능 보완 |
| 복잡도 | Standard — 다파일 신규 모듈과 Compose/운영 문서 변경 |
| 예상 영향 범위 | API observability, 공용 alert payload, 운영 Compose, 검증 스크립트 |
| 위험도 | High — 외부 전송, secret, PII, 중복 경보, 운영 장애 감지와 연관 |
| 구현 상태 | 내부 pipeline alert 경로는 구현됨. 실제 외부 URL, host-down 외부 감시, disk/backup 로컬 신호가 미연결 |

기존 `operational_alerts` outbox와 API dispatcher는 pipeline terminal failure, outbox quarantine,
canary rollback/suspension을 영속적으로 generic/Slack webhook에 전달한다. 현재 운영 환경에는
`PIPELINE_ALERT_WEBHOOK_URL`이 없어 dispatcher가 비활성이고, DB에도 보류 alert가 없다.

Task 1은 기존 dispatcher를 재작성하지 않고 다음 세 경로를 하나의 외부 receiver로 수렴시키는 것이 가장 작고
안전하다.

1. 애플리케이션 신호: 기존 PostgreSQL outbox → API dispatcher → 외부 webhook
2. 호스트 로컬 신호: 최소 권한 ops sentinel → disk/backup 검사 → 동일 webhook
3. 호스트·터널 전체 다운: Cloudflare edge의 Tunnel Health notification → 외부 email/webhook

외부 수신 URL·Cloudflare 알림 대상은 저장소만으로 결정할 수 없는 운영 입력이다. 구현은 URL을 secret으로
주입하고 synthetic probe로 검증할 수 있게 만들되, 실제 연결 완료 판정은 운영자가 선택한 receiver 정보와
Cloudflare 계정 설정이 있어야 한다.

## 1. 관련 파일 목록과 역할

| 파일 | 역할 | 판단 |
|------|------|------|
| `packages/shared/src/operational-alert.ts` | alert kind/envelope, generic·Slack payload, retry 계산 | 재사용. 외부 전송 전 PII allowlist 보강 필요 |
| `packages/shared/src/operational-alert.test.ts` | payload escape와 retry 단위 테스트 | 신규 kind와 sanitization 회귀 테스트 추가 |
| `apps/api/src/observability/operational-alert-dispatcher.service.ts` | DB outbox claim, webhook 전송, retry/terminal 처리 | 재사용. URL/응답 본문 미로그 정책 양호 |
| `packages/database/src/observability.ts` | terminal pipeline failure와 alert 원자 커밋 | 변경 불필요 |
| `apps/worker/src/outbox/outbox-dispatcher.service.ts` | quarantine alert 원자 커밋 | 변경 불필요 |
| `apps/api/src/learning/learning-model.service.ts` | canary rollback/suspension alert 원자 커밋 | 변경 불필요 |
| `packages/config/src/config.ts` | `PIPELINE_ALERT_WEBHOOK_*` validation | 기존 경로 재사용 가능 |
| `scripts/verify-operational-alerts.mjs` | 격리 DB+mock receiver 통합 검증 | 실제 운영 데이터 없이 outbox 동작 검증 가능 |
| `scripts/ops/verify-ai-pipeline-infrastructure.sh` | 운영 health와 alert URL 존재 여부 확인 | 현재 URL 미설정을 optional로만 보고함 |
| `infrastructure/backup/backup-healthcheck.sh` | `.last-success` 기반 backup freshness 확인 | 로컬 sentinel 검사 규칙 재사용 가능 |
| `docker-compose.prod.yml` | backup bind mount와 운영 서비스 구성 | 최소 권한 sentinel 추가 위치 |
| `docs/operations/ai-pipeline-alerting.md` | webhook 운영 설정·장애 처리 | receiver probe, host-down 설정, recovery 정책 보강 필요 |
| `docs/adr/0020-operational-alert-outbox.md` | durable application alert 결정 | 유지. local sentinel 예외 경계를 후속 ADR로 기록 필요 |
| `.env.example` | 운영 alert 설정 예시 | sentinel threshold와 interval 예시 추가 필요 |

현재 사용자 변경과 겹치는 `packages/database/src/schema.ts`, drizzle migration 파일은 수정하지 않는다.

## 2. 기존 패턴 및 인터페이스

### 재사용 가능한 패턴

- outbox claim: PostgreSQL `FOR UPDATE SKIP LOCKED` + 60초 lease
- 전달 보장: at-least-once, receiver가 `alert.id`로 멱등 처리
- retry: 30초 지수 backoff, 최대 15분
- 민감정보 보호: URL/token/응답 본문 미로그, raw exception 대신 error name/code
- webhook 계약: `operational-alert-v1` generic JSON 또는 Slack Incoming Webhook text
- 설정 검증: Zod 기반 URL, timeout, batch, attempt 제한
- 운영 검증: production DB 대신 격리 DB와 mock webhook 사용

### 발견한 계약 불일치

- 운영 문서는 generic receiver가 `alertId`를 멱등 키로 사용한다고 쓰지만 실제 payload 필드는
  `alert.id`이다. 문서를 실제 계약에 맞춰야 한다.
- `OperationalAlertEnvelope.details`는 `Record<string, unknown>` 전체를 generic payload에 전달한다.
  현재 producer는 안전한 집계만 넣지만 미래 producer의 원문/식별자 유입을 타입 수준에서 막지 못한다.
- `OperationalAlertKind`에는 `backup_stale`, `disk_low`, `recovered` 의미가 없다. DB enum 변경은 사용자
  작업과 충돌하므로 local sentinel 전용 kind를 공용 webhook 계약에만 추가하는 편이 안전하다.

## 3. 아키텍처 분석

```text
pipeline/worker/model transaction
             │ same DB transaction
             ▼
    operational_alerts outbox ── API dispatcher ─────┐
                                                     │
backup timestamp + mounted filesystem ─ ops sentinel ├─ external receiver
                                                     │
Cloudflare edge ─ Tunnel Health notification ────────┘
```

### 레이어와 책임

- Domain producer는 경보 의도만 DB에 남기고 외부 네트워크를 호출하지 않는다.
- API dispatcher는 애플리케이션 경보의 유일한 외부 발송자다.
- ops sentinel은 DB transaction과 무관한 host-local 측정치만 담당한다. Docker socket, DB credential,
  app secret 없이 backup mount와 state volume만 읽고 쓴다.
- host-down은 같은 Mac의 어떤 프로세스도 신뢰할 수 없으므로 Cloudflare edge가 담당한다.

### 설계 원칙

- SRP: app outbox delivery와 host-local measurement를 분리한다.
- DIP: 양쪽 모두 versioned webhook envelope에 의존하고 특정 Slack SDK에 의존하지 않는다.
- OCP: receiver format은 generic/Slack adapter로 확장 가능하다.
- 보안 경계: sentinel은 Docker socket과 product env file을 받지 않고 alert 전용 env만 받는다.

## 4. 의존성 분석

### 외부 의존성

신규 npm 라이브러리는 필요 없다. Node.js 22 내장 `fetch`, `fs.promises.stat`, `statfs`, `node:test`로
구현할 수 있다. Cloudflare Tunnel Health notification은 모든 Cloudflare Zero Trust plan에 포함되고
email, webhook, third-party destination을 지원한다.

### 내부 의존성

```text
ops sentinel
├── Node.js built-ins only
├── read-only: /monitored/backups/.last-success
├── read-only: /monitored/backups filesystem stats
├── writable: /state (dedupe/recovery state)
└── outbound: configured webhook only

API dispatcher
├── @family/database operationalAlerts
├── @family/config observability
└── @family/shared webhook payload builder
```

DB schema 변경 없이 구현하면 기존 사용자 migration과 순환·병합 충돌이 없다.

## 5. 영향 범위와 호환성

- API 공개 endpoint 변경 없음.
- DB migration 없음.
- 기존 generic payload의 안전한 필드는 유지하되 unknown detail key를 제거하면 보안은 강화되지만,
  임의 detail을 사용하던 비공식 receiver에는 non-breaking에 가까운 축소 변화가 생긴다.
- 운영 Compose에 sentinel을 기본 상시 서비스로 넣기 전에 URL 미설정 동작을 명확히 해야 한다.
  현재 URL이 없으므로 fail-loop를 만들지 않고 disabled 상태로 대기하거나 profile로 분리해야 한다.
- receiver URL 설정 후 API와 sentinel만 재기동하면 되고 stateful container 재시작은 필요 없다.

## 6. 위험 요소와 대응책

| # | 위험 | 영향도 | 대응책 |
|---|------|--------|--------|
| 1 | generic details를 통한 PII/secret 유출 | High | kind별 허용 key와 scalar/size 제한, unknown key 제거 테스트 |
| 2 | webhook timeout/5xx로 경보 유실 | High | app은 기존 outbox retry, sentinel은 상태 보존+주기 재시도 |
| 3 | Slack mention/markup 주입 | Medium | 기존 escape 유지, 신규 sentinel text도 고정 template 사용 |
| 4 | disk/backup 조건이 매 poll마다 spam | Medium | firing/recovered 상태 전이에서만 전송, 미전달은 재시도 |
| 5 | state 파일 손상 | Medium | fail-safe 초기화, 현재 condition이 지속되면 다시 firing 전송 |
| 6 | 같은 Mac에서 host-down 감지 시도 | High | 금지. Cloudflare edge Tunnel Health notification 사용 |
| 7 | Tunnel healthy지만 앱 route 장애 | Medium | Task 16에서 외부 application Health Check/SLO monitor 추가. Tunnel alert만으로 완전 대체하지 않음 |
| 8 | URL/token 로그 노출 | High | 오류는 HTTP family/name만 기록, URL·header·body 미출력 |
| 9 | sentinel에 product secret 과다 주입 | High | `env_file` 금지, alert 전용 env만 명시 |
| 10 | 현재 사용자 DB schema 변경과 충돌 | High | DB enum/migration을 이번 Task에서 수정하지 않음 |

## 7. 권장 구현 범위

### Phase A — webhook trust boundary 강화

- 공용 alert kind에 local-only `backup_stale`, `disk_low`와 recovery 상태 표현을 추가한다.
- 외부 payload 생성 전에 kind별 detail allowlist, scalar 타입, 문자열 길이 제한을 적용한다.
- `alert.id` 멱등 계약과 PII/secret negative test를 추가한다.

### Phase B — 최소 권한 local ops sentinel

- Node built-in만 쓰는 독립 sentinel과 전용 image를 추가한다.
- backup age와 mounted filesystem free bytes/percent를 검사한다.
- firing/recovered 상태 전이, retry, timeout, corrupted-state recovery를 구현한다.
- Docker socket, DB, Redis, MinIO, 전체 app env file은 전달하지 않는다.

### Phase C — 운영 연결과 검증

- 실제 receiver를 오염시키지 않는 `--dry-run`과 명시적 `--send-test` 검증 경로를 제공한다.
- 운영 문서에 Slack/generic receiver 설정, synthetic signal, Cloudflare Tunnel Health notification 설정,
  중복 억제, recovery 알림, credential 보관을 기록한다.
- 실제 URL이 없으면 readiness 결과가 명확하게 `not-configured`로 실패하도록 전용 검증 명령을 둔다.
  기존 공개 서비스는 중단하지 않는다.

## 8. 공식 자료

- Cloudflare Tunnel notification: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/notifications/
- Cloudflare Tunnel monitoring: https://developers.cloudflare.com/tunnel/monitoring/
- Cloudflare Health Checks: https://developers.cloudflare.com/health-checks/
- GitHub scheduled workflow delay 주의: https://docs.github.com/en/actions/how-tos/troubleshoot-workflows

GitHub Actions schedule은 고부하 시 지연되거나 일부 queued job이 drop될 수 있으므로 5분 host-down SLO의
주 감시자로 사용하지 않는다. Cloudflare standalone application Health Check는 현재 Pro 이상이므로 Task 16에서
계정 plan과 비용을 확인한 뒤 결정한다.

## 다음 단계

구현 계획에서 100라인을 넘는 변경을 Phase A~C로 분할하고, 실제 receiver URL이 필요한 마지막 운영 연결을
명시적 외부 입력 게이트로 둔다.
