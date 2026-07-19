# 프로덕션 배포 — 맥 홈서버 + Cloudflare Tunnel

가족용 규모를 맥에서 운영하는 가이드. 핵심: **인바운드 포트를 하나도 열지 않고**
Cloudflare Tunnel(아웃바운드)로만 노출한다.

## 아키텍처

```
모바일/브라우저
   │ https (Cloudflare가 공개 TLS 발급/종단)
   ▼
Cloudflare 엣지 ──암호화 터널── cloudflared(맥, 아웃바운드) ── http ── caddy:80
                                                                        ├─ /v1/* → api:3001 (NestJS)
                                                                        └─  그 외 → web:3000 (Next start)
postgres·redis·minio : 도커 내부망 전용(호스트/인터넷 미노출)
```

- 공유기 포트포워딩 불필요, 공인 IP 비노출, 동적 IP 무관.
- 공개되는 것은 **없음**(cloudflared는 나가는 연결만). DB/Redis/MinIO 포트는 prod compose에서 미공개.

---

## 1. 사전 준비

- **도메인을 Cloudflare에 등록**(네임서버를 Cloudflare로) — 예: `app.subinary.cloud`.
- **env 분리 구조**: 시크릿(DB/JWT/스토리지/AI)은 기존 `.env`에 그대로 두고, prod override만
  `.env.production`(gitignore됨)에 둔다. prod compose는 두 파일을 함께 로드한다
  (`--env-file .env --env-file .env.production`). → dev는 `.env`만으로 계속 동작.
  ```bash
  # .env.production (이미 생성됨 — 도메인 값 세팅됨, 토큰만 채우면 됨)
  NODE_ENV=production
  AI_PROVIDER=gemini
  GEMINI_API_KEY=...             # production strict 모드: 누락 시 API/Worker 시작 실패
  AI_MODEL_ALIAS_REQUIRED=false # task별 production alias 준비 후 true로 전환
  AI_MODEL_CANARY_MONITOR_ENABLED=true
  AI_MODEL_CANARY_MONITOR_INTERVAL_MS=30000
  AI_MODEL_CANARY_MONITOR_BATCH_SIZE=50
  PIPELINE_ALERT_WEBHOOK_URL=https://hooks.example.com/...
  PIPELINE_ALERT_WEBHOOK_FORMAT=generic # 또는 slack
  AI_EMBEDDING_MODEL=...        # 실제 embedding provider model identity
  AI_EMBEDDING_MODEL_REVISION=... # 승격할 registry model.version과 동일
  AI_CANDIDATE_PROVIDER=gemini  # shadow/live 후보 identity 세 필드는 함께 설정
  AI_CANDIDATE_LLM_MODEL=gemini-2.5-flash-lite
  AI_CANDIDATE_LLM_MODEL_REVISION=gemini-2.5-flash-lite-2026-07
  # AI_CANDIDATE_GEMINI_API_KEY=... # 생략하면 GEMINI_API_KEY 재사용
  PUBLIC_BASE_URL=https://app.subinary.cloud
  NEXT_PUBLIC_API_URL=https://app.subinary.cloud
  CORS_ORIGIN=https://app.subinary.cloud
  CLOUDFLARE_TUNNEL_TOKEN=eyJ...   # 2단계에서 발급한 'eyJ...' 토큰(cfk_ 아님)
  ```
  > 시크릿을 새로 회전(rotate)하고 싶다면 `.env.production`에 override로 넣을 수 있으나,
  > `POSTGRES_PASSWORD`는 **기존 pgdata 볼륨의 DB 계정과 일치해야 한다** — 바꾸려면 DB에서
  > `ALTER USER family WITH PASSWORD ...`도 함께. `DEVICE_SECRET_ENC_KEY`를 바꾸면 기존 장치
  > HMAC secret 복호화가 깨진다(장치 rotate로 재발급). 그대로 두면 dev 시크릿을 재사용한다.

## 2. Cloudflare Tunnel 생성

Cloudflare Zero Trust 대시보드 → **Networks → Tunnels → Create tunnel** (Cloudflared 타입):
1. 터널 생성 후 커넥터 설치 명령의 **`--token eyJ...` 토큰**을 `.env.production`의
   `CLOUDFLARE_TUNNEL_TOKEN`에 넣는다(`cfk_...` 아님).
2. 같은 화면 **Public Hostname** 추가:
   - Subdomain/Domain: `app.subinary.cloud`(원하는 도메인)
   - **Service: `HTTP` → `caddy:80`** (cloudflared와 caddy가 같은 compose 네트워크)
3. (선택) Path 없이 전체를 caddy로 보내면 /v1 라우팅은 caddy가 처리한다.

## 3. 전환(cutover)

```bash
# 1) dev 스택 내리기(데이터 볼륨은 유지됨)
docker compose down

# 2) 프로덕션 스택 빌드 + 기동
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml up -d --build
```

`PUBLIC_BASE_URL`이 web 이미지에 인라인되므로, 도메인을 바꾸면 **web을 재빌드**해야 한다:
```bash
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml up -d --build web
```

## 4. 검증

```bash
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml ps        # 모두 healthy 확인
# 외부에서:
curl -sS https://app.subinary.cloud/api/health      # {"status":"ok",...}
curl -sS https://app.subinary.cloud/v1/health/live  # api liveness
```
포트가 안 열렸는지 확인(로컬):
```bash
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml ps --format '{{.Service}} {{.Ports}}'
# postgres/redis/minio에 0.0.0.0:... 매핑이 없어야 정상
```

## 5. 맥 서버 하드닝

- **절전 방지**(닫혀도/유휴여도 안 자게):
  ```bash
  sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1
  # 노트북이면 clamshell 모드 유지 위해 전원 연결 필수
  ```
- **전원 복구 후 자동 부팅**: 시스템 설정 → 에너지(또는 `sudo pmset -a autorestart 1`; Mac mini/데스크톱만 지원).
- **Docker Desktop 자동 실행**: Docker Desktop → Settings → General → *Start Docker Desktop when you sign in*. + 맥 자동 로그인 설정(재부팅 시 무인 기동).
- compose는 `restart: unless-stopped`라 Docker만 뜨면 컨테이너는 자동 복구.

## 6. 자동 백업과 복구 검증 (가계부 데이터 — 필수)

프로덕션 스택의 `backup` 서비스가 PostgreSQL custom dump와 MinIO 객체를 같은 UTC 시각의
스냅샷 디렉터리에 저장한다. 성공한 스냅샷만 원자적으로 publish하며 각 파일의 SHA-256 manifest를
생성한다. 기본 주기는 24시간, 보존 기간은 30일이다.

```bash
# .env 또는 .env.production
BACKUP_DIR=./backups              # 가능하면 암호화된 외장 디스크의 절대 경로로 변경
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETRY_SECONDS=300
BACKUP_RETENTION_DAYS=30

# 서비스 상태와 최근 실행 로그
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml ps backup
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml logs --tail=20 backup

# 배포 주기와 무관하게 즉시 스냅샷 생성
pnpm ops:backup

# 최신 스냅샷의 checksum을 확인하고 격리된 임시 PostgreSQL에 실제 복원
pnpm ops:backup:verify

# 특정 스냅샷 검증
BACKUP_SNAPSHOT=20260719T052331Z pnpm ops:backup:verify
```

복구 검증은 tmpfs의 격리 DB만 사용하며 운영 PostgreSQL에는 연결하지 않는다. 운영 장애 복구 시에는
검증이 통과한 `postgres/database.dump`를 새 PostgreSQL 인스턴스에 먼저 복원하고,
`minio/<bucket>`을 `mc mirror`로 새 버킷에 적재한 뒤 애플리케이션 연결을 전환한다. 운영 DB에 직접
덮어쓰는 자동 명령은 실수 방지를 위해 제공하지 않는다.

- `backups/`에는 원문과 개인정보가 포함될 수 있어 git과 Docker build context에서 제외된다.
- 같은 맥 내부의 `./backups`만으로는 디스크 장애를 견디지 못한다. FileVault가 적용된 외장 디스크나
  암호화된 원격 저장소로 2차 복제한다.
- Time Machine에 도커 볼륨은 안정적으로 포함되지 않으므로 논리 백업 디렉터리를 백업 대상으로 삼는다.
- 월 1회 `pnpm ops:backup:verify`를 실행하고 성공 시각·스냅샷·복원 테이블 수를 운영 기록에 남긴다.

### 6.1 맥 외부 암호화 복제

`offsite-backup` profile은 최신 로컬 snapshot checksum을 확인한 뒤 restic repository로 암호화 복제한다.
repository는 반드시 맥과 다른 장애 도메인(S3 호환 object storage, 별도 NAS의 REST/SFTP 등)에 둔다.
[restic 공식 문서](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)가 설명하는
`RESTIC_REPOSITORY` 형식을 사용한다.

```bash
# .env.production — 예시는 S3 호환 저장소
RESTIC_REPOSITORY=s3:https://s3.example.com/subinary-backup
RESTIC_PASSWORD=<별도 생성한 긴 복구 암호>
RESTIC_AWS_ACCESS_KEY_ID=<전용 최소권한 key>
RESTIC_AWS_SECRET_ACCESS_KEY=<secret>
RESTIC_AWS_DEFAULT_REGION=us-east-1

# 최초 1회 repository 초기화
pnpm ops:backup:replica:init

# 즉시 복제 및 원격 복원 검증
pnpm ops:backup:replica
pnpm ops:backup:replica:verify

# 일일 daemon 활성화
docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml --profile offsite-backup up -d backup-replica
```

기본 보존은 daily 30, weekly 12, monthly 12이며 `BACKUP_REPLICA_KEEP_*`로 조정한다. 월 1회 `restic check`를
자동 실행한다. password를 repository와 같은 위치에만 두지 말고 별도 password manager/복구 매체에
보관한다. `RESTIC_REPOSITORY` 또는 password가 없거나 잘못되면 복제를 성공으로 표시하지 않는다.

### 6.2 일회성 AI Training Runner

Training Runner는 기본 운영 스택에 상주하지 않는다. 준비도 gate를 통과한 승인 dataset으로 API에서
queued run을 만든 뒤 해당 UUID만 profile 컨테이너에 전달한다.

```bash
# 사람 라벨·클래스·계보 진입 조건 확인
pnpm ops:training-readiness

# API에서 받은 queued run UUID 실행
TRAINING_RUN_ID=<uuid> pnpm ops:training:run

# 운영 DB와 분리한 실제 학습·재현성·로컬 서빙·삭제 전파 회귀 검증
pnpm verify:training-runner:isolated
```

컨테이너 상한은 CPU 1개, 메모리 1GiB, PID 256이며 `restart: no`다. 실행 중 API·Worker에 Trainer를
합치거나 gate 기준을 낮추지 않는다. 상세 순서는 [AI Training Runner 운영 절차](./operations/ai-training-runner.md)를
따른다.

## 7. 모바일 앱 연결

앱은 `NEXT_PUBLIC_API_URL`을 **빌드 시 인라인**한다. 운영 도메인으로 재빌드 후 동기화:
```bash
NEXT_PUBLIC_API_URL=https://app.subinary.cloud pnpm --filter @family/mobile sync
```
- 딥링크 https를 쓰려면 `AndroidManifest.xml`/`App.entitlements`의 도메인도 교체(→ `apps/mobile/README.md`).

## 8. 롤백(dev로 복귀)

```bash
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml down
docker compose up -d          # dev 스택(next dev 등)
```
데이터 볼륨은 공유되므로 유지된다.

## 보안 체크리스트

- [ ] `NODE_ENV=production` (refresh 쿠키 Secure)
- [ ] DB/Redis/MinIO 포트 미공개(prod compose 기본)
- [ ] 모든 시크릿 `change_me`/dev 기본값 교체 완료
- [ ] `AI_PROVIDER=gemini` + `GEMINI_API_KEY` 설정 완료(Mock/키 누락은 시작 단계에서 차단)
- [ ] `merchant-category`, `rag-*` 평가·승격 완료 후 `AI_MODEL_ALIAS_REQUIRED=true` 전환
- [ ] `rag-embedding` 후보 revision backfill 후 활성 청크 coverage 100%와 projection 전환 검증
- [ ] `AI_MODEL_CANARY_MONITOR_ENABLED=true`와 poll interval/batch 설정 후 scheduled trigger 기록 확인
- [ ] canary `minimumInvocationCount`, 오류율, p95, 관측 창을 실제 baseline SLO로 조정
- [ ] `PIPELINE_ALERT_WEBHOOK_URL` 설정 후 terminal failure/quarantine/canary 경보 수신 확인
- [ ] 후보 provider/model/revision과 승인 registry identity 일치 확인 후 shadow→소량 live 순서로 전환
- [ ] `ai_invocations`의 traffic role/bucket/selected와 후보 오류율·지연을 확인하고 정책 pause 절차 검증
- [x] 격리 Training Runner의 2회 재현성·로컬 alias 서빙·artifact 삭제 전파 검증
- [ ] 사람 확정 라벨 100개/카테고리 3개/카테고리별 10개를 충족한 뒤 첫 운영 학습·평가·승격
- [ ] `.env`는 커밋 금지(이미 .gitignore). 저장소 public이므로 특히 주의
- [ ] Cloudflare에서 필요 시 Access(제로트러스트) 정책으로 접근 제한 가능
- [x] PostgreSQL/MinIO 일일 자동 백업 서비스와 checksum 생성
- [x] 격리 PostgreSQL 복구 검증 절차 실행(2026-07-19: 55 tables, 270 objects)
- [ ] `BACKUP_DIR`을 맥 본체와 장애 도메인이 다른 암호화 저장소로 이동
- [ ] 외부 `RESTIC_REPOSITORY`와 별도 복구 암호 설정 후 init→replica→verify 통과
- [x] production 외부 이미지 OCI digest 고정
