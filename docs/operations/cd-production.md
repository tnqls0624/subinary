# CD Production — main CI 성공 후 공식 `deploy.sh` 운영 반영

`main` 에서 GitHub Actions **CI** 워크플로(`gitleaks` + `build-and-test`)가 성공하면,
홈 Mac 의 self-hosted runner 가 **운영 워크트리**에서 공식 진입점
`sh scripts/ops/deploy.sh` 기본값으로 운영을 갱신한다.

그 기본값은 Docker(web/api/worker 등 + compose 가 이미 돌리는 migrate)뿐 아니라
이어서 OTA 웹 번들(`deploy-ota-bundle.sh`)도 올린다. Docker 만 올리면 브라우저 웹은
새 커밋이 되고 폰 앱 안의 웹 자산는 낡은 번들로 남는 드리프트가 난다
(`deploy.sh` 주석·최근 운영 사고와 동일).

워크플로 파일: [`.github/workflows/cd-production.yml`](../../.github/workflows/cd-production.yml).

## 동작 요약

| 항목 | 값 |
| --- | --- |
| 트리거 | `workflow_run` → 워크플로 이름 `CI`, `types: [completed]`, `branches: [main]` |
| 추가 조건 | CI `conclusion == success`, CI `event == push`, `head_branch == main` |
| 게이트 | GitHub-hosted `ubuntu-latest` — repository variables 미설정 시 **실패**(조용한 성공 스킵 없음) |
| 배포 runner | `[self-hosted, macOS, production-docker]` (홈 Mac 만, GitHub 로 **아웃바운드**) |
| 배포 위치 | repository variable `PRODUCTION_REPO_DIR` 의 운영 워크트리 (Actions `_work` / `/private/tmp/subinary-deploy-*` 임시 트리 금지) |
| 배포 명령 | `sh scripts/ops/deploy.sh` (**기본값**, `DEPLOY_SKIP_OTA` 없음 → Docker + OTA) |
| Compose 프로젝트 | `docker-compose.prod.yml` 의 `name: family-memory-ai` 유지(변경 시 컨테이너 고아화) |
| 동시성 | `production-docker-deploy`, `cancel-in-progress: false` |

feature 브랜치·실패한 CI·PR 이벤트에서는 배포 job 이 돌지 않는다.
GitHub-hosted Ubuntu 로는 홈 Docker 에 닿을 수 없고, 홈 네트워크 **인바운드 포트/SSH 를
열어 우회하지 않는다**. 가짜 SSH/no-op “성공” job 도 두지 않는다.
일부 서비스만 `docker compose up` 하는 병렬 CD 경로도 만들지 않는다 — 항상 공식
`deploy.sh` 한 길이다.

## 범위 / 비범위

**한다**

- 공식 `deploy.sh` 기본 경로 전체
  - 메모리 가드 → `bootstrap-ai-pipeline-infrastructure.sh` (이미지 빌드, `compose up -d`, migrate, verify)
  - 이어서 `deploy-ota-bundle.sh` (폰이 다음 백그라운드에서 새 웹 번들 수신)
- CI 가 검증한 `workflow_run.head_sha` 만 체크아웃해 배포

**하지 않는다**

- 네이티브 앱 재빌드·스토어 배포(OTA 는 웹 자산만; 네이티브 코드 변경은 별도)
- `DEPLOY_SKIP_OTA` / `OTA_FORCE` 설정
- `reset-password`, classifier training, Spark/lakehouse/Kafka/Airflow
- `docker system prune` / volume prune 등 자동 디스크 정리
- compose 프로젝트명 변경, 인바운드 포트 개방, 애플리케이션 제품 동작 변경
- 요청 서비스만 골라 `docker compose up` 하는 임시 배포 경로

## 사람 준비 체크리스트 (시크릿 값은 저장소에 넣지 말 것)

### 1. 홈 Mac 에 GitHub self-hosted runner

운영 원칙(호스트 실측 도구는 컨테이너가 아니라 맥 네이티브)에 따라 runner 도
Docker 컨테이너가 아니라 맥 호스트에 설치한다. Cloudflare Tunnel 과 같이
**GitHub 으로 나가는 연결만** 쓰면 된다.

1. GitHub → 저장소 **Settings → Actions → Runners → New self-hosted runner** → macOS.
2. 안내에 따라 runner 를 설치·등록한다.
3. **필수 커스텀 라벨**: `production-docker`  
   (기본 라벨 `self-hosted`, `macOS`, 아키텍처 라벨은 등록 시 자동).
4. runner 프로세스가 Docker Desktop 과 같은 사용자로 돌고, `docker info` 가 되는지 확인한다.
5. Settings → Runners 에서 상태가 **Idle** 인지 확인한 뒤에만 아래 활성화 플래그를 켠다.  
   runner 없이 `PRODUCTION_CD_ENABLED=true` 만 켜면 deploy job 이 큐에 무한 대기할 수 있다
   (성공으로 보이지는 않지만 배포도 안 됨). **Idle 확인 전엔 플래그를 켜지 말 것.**

이 저장소의 `ci.yml` 은 `ubuntu-latest` 만 쓰며, 현재 등록된 self-hosted runner 유무는
이 문서/에이전트가 GitHub API 로 단정하지 않는다 — Settings → Runners 에서 사람이 확인한다.

### 2. Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | 값 | 설명 |
| --- | --- | --- |
| `PRODUCTION_CD_ENABLED` | `true` | 게이트 통과용. runner·운영 트리가 준비되기 전에는 설정하지 않는다. |
| `PRODUCTION_REPO_DIR` | 예: `/Users/soobeen/Desktop/Project/subinary` | 운영 워크트리 **절대 경로**(내용·시크릿 아님). 그 안에 `.env`, `.env.production`, `docker-compose.prod.yml` 이 있어야 한다. |

`.env` / `.env.production` / OTA·vault 키 내용을 GitHub Secrets 나 커밋에 넣지 않는다.
finance vault 등 compose 가 읽는 `~/.config/family-memory-ai/…` 는 기존처럼 Mac 홈에 둔다.

### 3. 운영 워크트리 주의

- Compose 프로젝트명은 `family-memory-ai` 로 **고정**이다. 바꾸지 않는다.
- 최근 사람이 임시 체크아웃(`/private/tmp/subinary-deploy-*` 등)으로 일부 서비스만
  올린 적이 있어도, CD 는 그 경로를 쓰지 않는다. `PRODUCTION_REPO_DIR` 의
  `docker-compose.prod.yml` 로 공식 `deploy.sh` 만 돌린다(라벨이 삭제된 tmp 경로를
  가리키고 있으면 다음 공식 배포가 운영 트리 기준으로 바로잡는다).
- CD 는 배포 직전에 해당 트리를 CI SHA 로 `git checkout --detach` 한다. dirty tree 면
  실패한다(재현 불가 이미지 방지).

### 4. 첫 자동 배포가 도는 시점

1. 이 CD 변경이 **main 에 머지**되고
2. 위 runner + variables 가 준비된 뒤
3. 그 다음 `main` push 에서 CI 가 초록이면

그때 처음으로 자동 운영 반영이 시도된다. 머지만 하고 runner/variables 가 없으면
이후 main CI 성공 시 **CD gate 가 실패**한다(운영이 갱신되지 않았는데 성공으로 보이지 않음).

## 실패 시

- gate 실패: variables / 문서 체크리스트 확인.
- deploy 실패(Docker 또는 OTA): runner 로그와 Mac 의 `.deploy-logs/`(deploy.sh 가 남김).
  OTA 만 실패한 경우 `deploy.sh` 는 서버 배포 성공 후에도 비영 코드로 끝난다 — CD 도
  실패로 보여 폰 드리프트를 성공으로 위장하지 않는다.
- 디스크 부족: [production-deploy.md §5.1](../production-deploy.md) — CD 가 prune 을 실행하지 않는다.
- 롤백: 기존과 동일 — `docker tag family-memory-ai/prod:<이전sha> family-memory-ai/prod:local` 후
  `sh scripts/ops/deploy.sh --skip-build`(필요 시 수동). OTA 롤백은 앱의 자동 롤백·별도
  번들 재배포 절차를 따른다.

## 관련 문서

- [production-deploy.md](../production-deploy.md) — 수동 배포·하드닝·백업
- [operations/README.md](./README.md) — 운영 인덱스
- `scripts/ops/deploy.sh` — 공식 배포 래퍼(Docker + 기본 OTA)
- `scripts/ops/deploy-ota-bundle.sh` — 폰 웹 번들만(네이티브 재빌드 없음)
