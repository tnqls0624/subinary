# 서비스 카탈로그 + 운영툴 사용법

`docker-compose.prod.yml`의 컨테이너 하나하나가 **무엇을 하는지**, 관측/조사 툴을 **어떻게 보고 쓰는지**를 정리한다.
운영 원칙·경보 흐름·절차 인덱스는 [README.md](./README.md)를, 서비스별 세부는 이 문서를 본다.

> 표기 규약
> - 포트는 전부 `127.0.0.1` 바인딩(맥 로컬 전용, LAN·인터넷 비노출). `—`는 미공개(도커 내부망만).
> - profile 없는 서비스는 평시 `up -d`에 기동. `profile: X`는 `--profile X`로 명시할 때만.
> - 컨테이너명은 `family-memory-ai-<서비스>-1` 패턴.

---

## 1. 서비스 카탈로그

### 데이터 계층
| 서비스 | 역할 | 포트 | health | 특이점 |
|---|---|---|---|---|
| **postgres** | 주 DB(pgvector — 벡터검색 포함) | — | ✅ `pg_isready` | `pgdata` 볼륨, init 스크립트 마운트 |
| **redis** | 캐시·큐(worker 잡 백엔드) | — | ✅ `ping` | `redisdata` 볼륨 |
| **minio** | S3 호환 객체 저장(사진/첨부) | — | ✗ (distroless, curl 없음) | 콘솔 9001도 비공개 |
| **minio-setup** | 부팅 시 버킷 1회 생성 후 종료 | — | one-shot | `restart:no`. 완료 조건이 backup/api/worker/trainer를 게이트 |

### 애플리케이션 계층
| 서비스 | 역할 | 내부포트 | health | 특이점 |
|---|---|---|---|---|
| **api** | NestJS API(제품 경보 dispatcher 포함) | 3001 | ✅ `/v1/health/live` | pg·redis·minio·migrate 의존 |
| **worker** | 백그라운드 잡(카드문자 파싱·알림·SSE 등) | 3002 | ✅ `/v1/health/live` | 동일 의존 |
| **web** | Next.js 프론트 | 3000 | ✅ `/api/health` | api healthy 후 기동. API URL은 빌드타임 인라인 |
| **migrate** | DB 마이그레이션 1회 실행 후 종료 | — | one-shot | `restart:no`, pg healthy 의존 |
| **trainer** | 승인된 학습 run 1건 실행 | — | `profile: training` | CPU 1.0/mem 1g 상한(운영과 자원 경합 차단) |

### 엣지 계층
| 서비스 | 역할 | 포트 | 특이점 |
|---|---|---|---|
| **caddy** | 내부 리버스 프록시(`/v1/*`→api, 그 외→web) | — | 공개 포트 0. cloudflared가 내부망으로 접근 |
| **cloudflared** | Cloudflare Tunnel(아웃바운드 전용) | — | **인바운드 0의 핵심** — 공유기 포트 개방·공인IP 불필요. 호스트명 매핑은 CF Zero Trust 대시보드 |

### 백업 계층
| 서비스 | 역할 | 게이트 | 특이점 |
|---|---|---|---|
| **backup** | 일일 pg_dump + MinIO 미러(30일 보존, SHA256 manifest) | 평시 | ✅ health. 성공/실패를 healthchecks.io로 핑(dead man's switch) |
| **backup-verify** | 격리 tmpfs DB에 스냅샷 실복원 검증 | `profile: ops` | 운영 DB 미접속, `restart:no` |
| **backup-replica** | restic 오프사이트 암호화 복제 데몬 | `profile: offsite-backup` | secret 없으면 fail-closed. 미가동 시 백업 장애도메인=맥 1대 |
| **backup-replica-verify** | 원격 repo 무결성 + 최신 snapshot 복원 확인 | `profile: offsite-backup-ops` | tmpfs 복원, `restart:no` |

### 관측·운영 계층
| 서비스 | 역할 | 포트 | 게이트 | 특이점 |
|---|---|---|---|---|
| **ops-sentinel** | 백업 신선도 + 백업 마운트 여유(%) 감시 → webhook | — | 평시 | read-only·`cap_drop ALL`·no-new-privileges·64m 하드닝. DB/socket 없이 파일시스템만. ⚠️ Docker Desktop에선 **퍼센트 임계만 실효**(바이트 임계는 VM 가상값이라 무효 — 절대 바이트 실측은 맥 네이티브 beszel-agent 영역) |
| **gatus** | 외형 감시(내부 app health + 공개 터널 URL 능동점검) | 8080 | 평시 | **`depends_on` 없음(의도)** — 감시자는 대상보다 먼저·독립적으로 떠야 사각지대를 안 만든다 |
| **socket-proxy** | read-only Docker API 프록시(GET만, `POST=0`) | — | 평시 | Docker socket을 만지는 **유일 지점**, internal 망 격리 |
| **dozzle** | 전 컨테이너 로그 라이브 뷰/검색 | 8081 | 평시 | socket-proxy 경유(raw socket 미마운트). ✅ health(`/dozzle healthcheck`) |
| **beszel** | 메트릭 대시보드(CPU/메모리/디스크/온도) | 8090 | `profile: observability` | hub=컨테이너, **실측은 맥 네이티브 agent**(Docker Desktop VM 경계) |

---

## 2. 운영툴 사용법 — "어떻게 보나"

### 상태 한눈에 (CLI)
```sh
docker compose -f docker-compose.prod.yml ps          # 전 컨테이너 상태/health
pnpm ops:infra:verify                                 # 서비스 health + 이미지 동일성 + 포트 미공개 + 공개URL health 종합
docker logs -f family-memory-ai-<서비스>-1             # 개별 컨테이너 로그
```

### Gatus — 외형 감시 UI · http://localhost:8080
- **볼 것**: 내부 3종(api/worker/web health) + 공개 2종(터널 URL) 점검 결과·업타임·응답시간 그래프
- **언제**: "터널은 Healthy인데 502" 같은 앱 정상성 확인, 경보의 근거 확인
- **설정**: 코드로 관리(`infrastructure/gatus/config.yaml`) — UI에서 수정하지 않는다

### Dozzle — 로그 뷰어 · http://localhost:8081
- **볼 것**: 전 컨테이너 실시간 로그·검색·다운로드(CLI `docker logs`보다 빠른 훑기)
- **언제**: CrashLoop·에러 추적. CLI 대안은 위 `docker logs -f`
- ⚠️ 로컬 전용. 원격 노출 시 전용망 + 2차 인증 필수(무인증이면 전 스택 로그 열람 위험)

### Beszel — 메트릭 대시보드 · http://localhost:8090 (먼저 기동 필요)
```sh
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml \
  --profile observability up -d beszel
```
- **볼 것**: 맥 호스트 실측 CPU/메모리/디스크/온도 시계열, 경보(상태/CPU/메모리)
- ⚠️ hub만 띄우면 안 됨 — **맥 네이티브 agent(launchd)** 가 실측 담당. 온보딩·경보 설정: [observability-ui.md](./observability-ui.md)

### HolmesGPT — AI 장애 조사 (호스트 네이티브 CLI)
```sh
sh infrastructure/holmesgpt/investigate.sh "api가 502를 내는 이유를 조사해줘"
```
- docker/core 툴셋으로 컨테이너를 read-only 조사(소켓 마운트 불필요), `GEMINI_API_KEY` 재사용
- 자동 조사(`pnpm ops:auto-investigate`)는 **기본 OFF**(반복 LLM 비용) — `AUTO_INVESTIGATE_ENABLED=true` + launchd 로드 시에만 동작

### ops-sentinel — UI 없음(경보만)
- 백업 stale·디스크 부족을 webhook으로 push. 상태 확인은 로그: `docker logs family-memory-ai-ops-sentinel-1`
- 합성 알림 검증: `pnpm ops:alert:verify`(실 receiver로 발사), 단위테스트: `pnpm ops:alert:test`

---

## 3. Profile 지도 (평시 vs 게이트)
| 상태 | 서비스 |
|---|---|
| **평시 기동**(profile 없음) | postgres, redis, minio, minio-setup, migrate, api, worker, web, caddy, cloudflared, backup, ops-sentinel, gatus, socket-proxy, dozzle |
| `--profile observability` | beszel |
| `--profile training` | trainer |
| `--profile ops` | backup-verify |
| `--profile offsite-backup` | backup-replica |
| `--profile offsite-backup-ops` | backup-replica-verify |

---

## 4. 네트워크 격리 지도 — "누가 누구에게 닿나"
```
default              : postgres redis minio minio-setup migrate api worker web
                       caddy cloudflared gatus beszel backup*   (앱 트래픽 + 대부분)
socket-proxy (internal, egress 없음): socket-proxy ↔ dozzle
observability        : dozzle 만                (127.0.0.1 포트 publish 전용 통로)
alert-egress         : ops-sentinel 만          (경보 송신 전용)
```
- **dozzle는 default에 없다** → api/web 등 앱 컨테이너가 로그 UI(`:8080`)에 도달 불가 = 침해 시 전 스택 로그 유출(lateral) 차단.
- **socket-proxy는 internal** → 인터넷 egress 없음. Docker API를 읽는 컨테이너를 외부에서 격리.
- **ops-sentinel은 alert-egress 전용** → 경보 송신 외 내부망 접근 없음(DB·socket 미접근 하드닝과 정합).
- `*` backup은 default에 붙어 postgres/minio에 도달(백업 대상 접근용).

---

## 5. 설계 노트 — 자주 오해하는 관측 계층 결정
겉보기 "중복"을 감사(2026-07)한 결과 전부 의도된 목적 분리로 확인됐다. 아래는 코드/설정에만 드러나 있어
후임자가 "중복이니 제거"로 오판하기 쉬운 결정들 — **지우기 전에 이 노트를 볼 것.**

1. **Docker healthcheck는 경보 채널이 아니다.** healthcheck 결과의 소비처는 오직 `restart`(자가치유)와
   `depends_on`(부팅 게이트)다. **컨테이너 `unhealthy`는 그 자체로 아무에게도 통지되지 않는다.** 앱 계열의
   실제 경보는 Gatus가, 호스트/백업은 ops-sentinel이 담당한다. "healthcheck 있으니 감시된다"는 오해 주의.
2. **api는 `/live`(Docker) vs `/ready`(Gatus)로 엔드포인트를 의도적으로 나눴다.** Docker는 liveness(항상 200,
   일시적 DB 블립에 컨테이너 churn 방지), Gatus는 readiness(의존성 down 시 503 경보). 복붙이면 같은 URL이었을 것.
3. **worker도 Gatus가 `/ready`를 친다(2026-07 수정).** worker는 프로세스는 살아도 redis/db 연결만 죽는
   degraded-but-alive가 가능한데 `/live`만 보면 이 상태가 어디에도 안 잡혔다(GAP-1). 지금은 `/ready`로 감시.
4. **ops-sentinel 디스크 경보는 Docker Desktop에서 퍼센트만 실효.** 컨테이너가 statfs하는 값이 진짜 APFS가
   아니라 VM 가상 디스크(~126TB)라 **바이트 임계는 절대 발화하지 않는다**(GAP-3). 퍼센트 임계가 유일한 실효 가드.
   절대 바이트 실측이 필요하면 맥 네이티브 beszel-agent가 올바른 소유자.
5. **ops-sentinel은 외부 하트비트(DMS)로 이중화된다.** `OPS_SENTINEL_HEARTBEAT_URL` 설정 시 매 성공 사이클마다
   healthchecks.io로 핑 → ops-sentinel(맥 안)이 통째로 죽으면 핑이 끊겨 맥 밖에서 감지(GAP-2, disk_low 사각지대 폐쇄).
   backup의 `HEALTHCHECK_PING_URL`과 **별개 체크로** 등록할 것.
6. **Beszel 디스크 경보는 OFF로 유지한다.** 디스크 경보 소유권은 ops-sentinel 단독(위 4·5). Beszel의 디스크
   지표는 시각화 전용 — Beszel 온보딩 시 디스크 경보를 켜지 말 것(observability-ui.md §경보). 이중 경보 방지.
7. **HolmesGPT는 Dozzle의 로그를 쓰지 않는다.** AI 조사는 호스트 docker CLI로 직접 read-only 조회한다.
   Dozzle MCP를 AI 로그원으로 붙이면 공격표면·이중 로그원이 생기므로 의도적으로 비활성(compose dozzle 주석).
   "Dozzle MCP 재활성" 유혹 시 이 결정을 먼저 볼 것.

---

## 참고
- 배포·롤백·검증 명령: [README.md](./README.md) §배포, §명령 인덱스
- 경보 3계층·경계(ADR-0022): [ai-pipeline-alerting.md](./ai-pipeline-alerting.md)
- 이미지 digest 고정(ADR-0021): `docker-compose.prod.yml` `x-image-pins`
