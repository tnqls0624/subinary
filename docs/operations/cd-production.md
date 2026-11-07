# CD Production — main CI 성공 후 Docker 운영 반영

`main` 에서 GitHub Actions **CI** 워크플로(`gitleaks` + `build-and-test`)가 성공하면,
홈 Mac 의 self-hosted runner 가 기존 `scripts/ops/deploy.sh` 로 운영 Docker 스택
(web / api / worker 등, compose 가 이미 돌리는 migrate 포함)을 갱신한다.

워크플로 파일: [`.github/workflows/cd-production.yml`](../../.github/workflows/cd-production.yml).

## 동작 요약

| 항목 | 값 |
| --- | --- |
| 트리거 | `workflow_run` → 워크플로 이름 `CI`, `types: [completed]`, `branches: [main]` |
| 추가 조건 | CI `conclusion == success`, CI `event == push`, `head_branch == main` |
| 게이트 | GitHub-hosted `ubuntu-latest` — repository variables 미설정 시 **실패**(조용한 성공 스킵 없음) |
| 배포 runner | `[self-hosted, macOS, production-docker]` (홈 Mac 만) |
| 배포 명령 | `DEPLOY_SKIP_OTA=true sh scripts/ops/deploy.sh` |
| 동시성 | `production-docker-deploy`, `cancel-in-progress: false` |

feature 브랜치·실패한 CI·PR 이벤트에서는 배포 job 이 돌지 않는다.
GitHub-hosted Ubuntu 로는 홈 Docker 에 닿을 수 없어, SSH 가짜 배포나 no-op “성공” job 은 두지 않는다.

## 범위 / 비범위

**한다**

- `docker-compose.prod.yml` 기반 이미지 빌드·기동
- 기존 deploy 경로가 이미 실행하는 DB 마이그레이션
- bootstrap 직후 기존 verify

**하지 않는다**

- Capacitor OTA / Capgo (`DEPLOY_SKIP_OTA=true`)
- 네이티브 앱 재빌드·스토어 배포
- `reset-password`, classifier training, Spark/lakehouse/Kafka/Airflow, disk prune
- 애플리케이션 제품 동작 변경

수동으로 OTA 까지 올리려면 기존처럼 Mac 에서 `sh scripts/ops/deploy.sh`(OTA 포함) 또는
`pnpm ota:deploy` 를 쓴다.

## 사람 준비 체크리스트 (시크릿 값은 저장소에 넣지 말 것)

### 1. 홈 Mac 에 GitHub self-hosted runner

운영 원칙(호스트 실측 도구는 컨테이너가 아니라 맥 네이티브)에 따라 runner 도
Docker 컨테이너가 아니라 맥 호스트에 설치한다.

1. GitHub → 저장소 **Settings → Actions → Runners → New self-hosted runner** → macOS.
2. 안내에 따라 runner 를 설치·등록한다.
3. **필수 커스텀 라벨**: `production-docker`  
   (기본 라벨 `self-hosted`, `macOS`, 아키텍처 라벨은 등록 시 자동).
4. runner 프로세스가 Docker Desktop 과 같은 사용자로 돌고, `docker info` 가 되는지 확인한다.
5. Settings → Runners 에서 상태가 **Idle** 인지 확인한 뒤에만 아래 활성화 플래그를 켠다.  
   runner 없이 `PRODUCTION_CD_ENABLED=true` 만 켜면 deploy job 이 큐에 무한 대기할 수 있다.

### 2. Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | 값 | 설명 |
| --- | --- | --- |
| `PRODUCTION_CD_ENABLED` | `true` | 게이트 통과용. runner·env 경로가 준비되기 전에는 설정하지 않는다. |
| `PRODUCTION_ENV_DIR` | 예: `/Users/<you>/…/subinary-prod-env` | 그 디렉터리에 이미 있는 `.env` / `.env.production` 의 **절대 경로**(내용이 아님). |

워크플로는 체크아웃 루트에 위 두 파일을 심볼릭 링크로 연결한 뒤 `deploy.sh` 를 실행한다.
`.env` / `.env.production` 내용·토큰·비밀번호를 GitHub Secrets 나 커밋에 넣지 않는다.
finance vault 등 compose 가 읽는 `~/.config/family-memory-ai/…` 경로는 기존과 같이
Mac 홈 디렉터리에 그대로 둔다.

### 3. 첫 자동 배포가 도는 시점

1. 이 CD 변경이 **main 에 머지**되고
2. 위 runner + variables 가 준비된 뒤
3. 그 다음 `main` push 에서 CI 가 초록이면

그때 처음으로 자동 운영 반영이 시도된다. 머지만 하고 runner/variables 가 없으면
이후 main CI 성공 시 **CD gate 가 실패**한다(운영이 갱신되지 않았는데 성공으로 보이지 않음).

## 실패 시

- gate 실패: variables / 문서 체크리스트 확인.
- deploy 실패: runner 로그와 Mac 의 `.deploy-logs/`(deploy.sh 가 남김). 디스크 부족은
  [production-deploy.md §5.1](../production-deploy.md) — 자동 prune 은 CD 가 실행하지 않는다.
- 롤백: 기존과 동일 — `docker tag family-memory-ai/prod:<이전sha> family-memory-ai/prod:local` 후
  `sh scripts/ops/deploy.sh --skip-build`(필요 시 수동).

## 관련 문서

- [production-deploy.md](../production-deploy.md) — 수동 배포·하드닝·백업
- [operations/README.md](./README.md) — 운영 인덱스
- `scripts/ops/deploy.sh` — 실제 배포 래퍼
