# 운영 개요 (Operations Overview)

subinary(Family Memory AI) 프로덕션은 맥 홈서버 1대 + Docker Compose + Cloudflare Tunnel(인바운드 포트 0)로 운영된다.
이 문서는 관측·장애 감지·AI 조사·백업·배포 운영을 한눈에 잇는 인덱스다. 세부는 각 문서로 링크한다.

## 운영 3원칙
1. **인바운드 0** — 모든 신규 연결은 아웃바운드(터널·WebSocket·long-poll). 관리 UI는 caddy + Cloudflare Access 뒤에만.
2. **호스트를 봐야 하는 건 맥 네이티브** — Docker Desktop은 컨테이너를 Linux VM 안에서 돌린다. 맥 호스트 실측이 필요한 것(Beszel agent, HolmesGPT, Actions runner)은 컨테이너가 아니라 brew/uv로 호스트에 설치.
3. **Docker socket 직접 마운트 회피** — socket이 필요한 컨테이너는 read-only socket-proxy(GET 전용) 경유.

## 장애 감지 3계층
| 계층 | 감지 대상 | 수단 | 위치 |
|---|---|---|---|
| 박스 생존 | 맥 전원/Docker/터널 다운 | Cloudflare Tunnel Health 알림(email) | 맥 밖(CF 엣지) |
| 앱 정상성 | DB/Redis 다운·5xx·"터널 Healthy인데 502" | Gatus 외형 감시 | 컨테이너(내부+공개 URL) |
| 백업 DMS | 백업 잡 중단(ops-sentinel까지 죽어도) | healthchecks.io 하트비트 | 맥 밖 |

핵심: 계층 1이 **맥 밖**에 있어야 맥이 통째로 죽는 사각지대를 잡는다(Gatus는 맥과 함께 죽음).
경보 파이프라인 상세: [ai-pipeline-alerting.md](./ai-pipeline-alerting.md) (ADR-0022 경보 경계).

## 경보 소스 → 목적지
- **제품 경보**(pipeline 실패·outbox 격리·canary rollback): PostgreSQL `operational_alerts` outbox → API dispatcher → webhook(generic/Slack). ⚠️ Discord 수신 시 URL 끝에 `/slack` 필수.
- **호스트 경보**(backup stale·disk low): `ops-sentinel` 컨테이너(DB·socket 없이 파일시스템만) → 동일 webhook.
- **외형 경보**(app 다운): Gatus → custom provider webhook.

## AI 장애 조사 (HolmesGPT)
호스트 네이티브 CLI(`uv tool install holmesgpt`). docker/core 툴셋이 호스트 docker CLI로 컨테이너를 read-only 조사 → 소켓 마운트 불필요.
- **수동**: `sh infrastructure/holmesgpt/investigate.sh "<질문>"` (config.yaml, bash 허용, GEMINI_API_KEY 재사용)
- **자동**(기본 OFF): `scripts/ops/auto-investigate.sh` — `operational_alerts` critical을 읽기 전용 폴링(allowlist scalar만, 인젝션 방어) → config-automated.yaml(bash 비활성)로 조사 → webhook 보고. `AUTO_INVESTIGATE_ENABLED=true` + launchd 로드해야 동작(반복 LLM 비용).

## 메트릭·로그
- **메트릭**: Beszel(profile `observability`, 기본 미기동). hub=컨테이너, agent=맥 네이티브(brew). 온보딩·UI 노출: [observability-ui.md](./observability-ui.md).
- **로그**: Dozzle(socket-proxy 경유, 라이브 뷰). 전 컨테이너 로그 회전(json-file 10m×5). Dozzle은 CLI 전용 권장(노출 시 전용망+인증).
- **앱 대시보드**: owner/admin 전용 `GET /v1/learning/operations/metrics`. [ai-pipeline-dashboard.md](./ai-pipeline-dashboard.md).

## 백업 (3중)
1. **로컬 일일**: `backup` 서비스(pg_dump + MinIO 미러, SHA256 manifest, 30일 보존). 성공/실패를 healthchecks.io로 핑.
2. **격리 복원 검증**: `pnpm ops:backup:verify`(tmpfs 격리 DB 실복원, 월 1회 권장).
3. **오프사이트 복제**(profile `offsite-backup`, restic): `pnpm ops:backup:replica:init` → `:replica` → `:verify`. ⚠️ 미가동 시 백업 장애 도메인이 맥 1대.

## 배포
- **표준 경로**: `pnpm ops:infra:bootstrap` — dirty-tree 가드(커밋 안 하면 차단, `INFRA_ALLOW_DIRTY_BUILD=true` override) + git-sha 별칭 태깅(`prod:<sha>`, 런타임은 `:local`) + 전체 서비스 `up -d` + verify.
- **롤백**: `docker tag family-memory-ai/prod:<이전sha> family-memory-ai/prod:local && pnpm ops:infra:bootstrap -- --skip-build`.
- **검증**: `pnpm ops:infra:verify`(13개 서비스 health, 이미지 동일성, 포트 미공개, 공개 URL health 등).
- ⚠️ **다중 세션 동시 배포 주의**: 여러 세션이 동시에 build/up 하면 이미지 drift(worker만 뒤처짐 등) 발생 가능. 한 번에 한 세션만 배포할 것. 상세: [prod-cutover 메모](../production-deploy.md).

## AI 학습 파이프라인 (사람 게이트)
준비도 확인(`pnpm ops:training-readiness`) → dataset 승인 → training run 요청 → `TRAINING_RUN_ID=<uuid> pnpm ops:training:run` → 평가·승격. 상세: [ai-training-readiness.md](./ai-training-readiness.md), [ai-training-runner.md](./ai-training-runner.md).

## 명령 인덱스 (`package.json`)
| 명령 | 용도 |
|---|---|
| `ops:infra:bootstrap` / `:verify` | 배포 / 검증 |
| `ops:alert:test` / `:verify` | ops-sentinel 단위테스트 / 실 receiver 합성 알림 |
| `ops:backup` / `:verify` | 즉시 백업 / 격리 복원 검증 |
| `ops:backup:replica:init` / `:replica` / `:verify` | 오프사이트 복제 초기화 / 실행 / 검증 |
| `ops:auto-investigate` | 자동 조사 poller(기본 OFF) |
| `ops:training-readiness` / `training:run` | 학습 준비도 / 실행 |

## 문서 맵
- [production-deploy.md](../production-deploy.md) — 배포·백업·복구·하드닝 체크리스트
- [ai-pipeline-alerting.md](./ai-pipeline-alerting.md) — 경보 3계층·ADR-0022
- [ai-pipeline-dashboard.md](./ai-pipeline-dashboard.md) — 운영 지표 API
- [observability-ui.md](./observability-ui.md) — Beszel 온보딩·관측 UI 노출
- [ai-training-readiness.md](./ai-training-readiness.md) / [ai-training-runner.md](./ai-training-runner.md) — 학습 운영
- ADR: `docs/adr/` (0017 파이프라인 버저닝, 0018 트래픽/shadow, 0020 alert dispatcher, 0021 이미지 digest, 0022 경보 경계)
