# 검증+평가 리포트 - Task 1

**생성일**: 2026-07-19
**태스크**: 외부 운영 경보 수신 채널 연결
**평가자**: Codex reviewer
**재검증 범위**: 최신 코드, 운영 컨테이너, 실제 receiver 연결, Cloudflare 외부 알림

## 결론

### 종합 등급: **B (3.4/4.0)**

- **코드 결함 High 항목**: 없음
- **구현 완료 가능 여부**: 가능
- **운영 Task 완료 가능 여부**: 가능
- **권장 Task Master 상태**: `done`
- **fix-plan**: 불필요

이전 리뷰에서 완료를 막던 두 운영 입력이 해소됐다. Discord의 Slack-compatible HTTPS webhook으로 실제
`receiver_test`가 2xx 전달됐고, Cloudflare의 `subin-mac-tunnel-allert` Tunnel Health notification이 정상·성능
저하·다운 전이와 Email 전달 방식으로 활성화된 증거가 확인됐다. 애플리케이션 outbox, host-local sentinel,
Mac 밖의 tunnel 감시라는 세 장애 도메인이 모두 연결됐으므로 Task 1의 완료 조건을 충족한다.

## 검증 결과

| 항목 | 결과 | 근거 |
|------|------|------|
| 관련 diff·구문 검사 | PASS | 관련 파일 `git diff --check`, Node `--check`, 두 운영 shell `sh -n` 통과 |
| TypeScript 정적 분석 | PASS | API, Worker, Shared, Config `tsc --noEmit` 오류 0; config는 수정 후 재검증 |
| Shared 단위 테스트 | PASS | Vitest 11 files, 64 tests 통과 증거 확인 |
| Config 회귀 테스트 | PASS | 빈 값·정상 값·오류 값 포함 Node test 5/5, tsup build, `tsc --noEmit` 통과 |
| Sentinel 단위·경계 테스트 | PASS | 재실행 결과 5 suites, 17/17 tests 통과 |
| Sentinel coverage | PASS | line 86.89%, branch 81.77%, function 87.06% 증거 확인 |
| 관련 빌드 | PASS | Shared tsup, API/Worker SWC, pinned sentinel image 빌드 통과 증거 확인 |
| Compose 정적 검사 | PASS | 재실행한 `docker compose ... config --quiet` 통과 |
| Container 보안 | PASS | non-root, read-only rootfs, `cap_drop: ALL`, no-new-privileges, CPU 0.1/64MiB/PID 64 |
| 운영 컨테이너 | PASS | 빈 bearer 설정 수정·재생성 후 `api`, `ops-sentinel` 모두 healthy |
| 인프라 운영 검증 | PASS | 재실행 결과 전체 서비스 정상, public routes healthy, alert webhook configured |
| 실제 receiver synthetic | PASS | `npm run ops:alert:verify` 성공, `receiver_test_delivered` |
| 격리 outbox 통합 검증 | PASS | terminal failure, retry suppression, quarantine, delivery recovery 모두 true; 임시 DB 폐기 |
| Cloudflare host-down 경보 | PASS | Tunnel Health notification enabled; 정상·성능 저하·다운 전이, Email destination |

현재 셸에는 `pnpm`과 root local Vitest binary가 없어 Shared 테스트와 전체 typecheck를 이번 리뷰에서 다시 실행하지
못했다. 해당 결과는 직전 구현 단계의 통과 증거를 사용했다. Sentinel 테스트, Compose 검사, 컨테이너 상태와
전체 인프라 검증은 이번 재검증에서 직접 다시 실행했다. 외부 메시지를 중복 발송하지 않기 위해 실제 receiver
probe와 Cloudflare 테스트 이메일은 재실행하지 않았다.

## 카테고리별 점수

| 카테고리 | 점수 | 평가 |
|----------|------|------|
| 코드 품질 | 3.4/4.0 | adapter 주입, 명시적 설정 검증, atomic state, 오류 코드 중심 로깅이 견고함 |
| 아키텍처 및 설계 | 3.7/4.0 | DB outbox/local sentinel/Cloudflare edge의 장애 도메인 분리가 명확함 |
| 베스트 프랙티스·보안 | 3.2/4.0 | PII allowlist와 least privilege는 우수하나 노출된 Discord URL 회전 부채가 남음 |
| 성능 및 자원 | 3.6/4.0 | 저빈도 filesystem 측정, bounded/coalesced pending, 엄격한 container limit 적용 |
| 문서화 및 테스트 | 3.3/4.0 | 주요 Happy/Edge/Error와 운영 runbook을 보유하나 Cloudflare Email E2E는 미실행 |

## 상세 평가

### PII·secret trust boundary

- 공용 generic payload는 kind별 detail allowlist와 scalar 제한을 적용한다.
- unknown key, 중첩 객체, 원문, 사용자 식별자, secret 성격 필드를 제거한다.
- 허용 문자열의 제어문자와 길이를 제한하고 Slack markup·mention을 escape한다.
- sentinel은 state에서 변조된 id, source, summary, timestamp, detail을 고정 계약으로 재투영한다.
- URL, bearer token, 응답 본문, backup path는 정상·오류 로그에 출력하지 않는다.
- 운영 URL은 gitignored `.env.production`에만 있고 저장소에는 기록되지 않았다.

### 상태 변조·재시도·중복 억제

- state schema와 persisted alert를 검증하며 손상 state는 현재 조건으로 재평가한다.
- 조건 전이를 네트워크보다 먼저 atomic rename으로 보존하고, 성공한 pending만 제거한다.
- receiver 장애 중 firing/recovered flap은 kind별 첫 event와 최신 상태로 축약해 무한 증가와 단순 절단 유실을
  방지한다.
- 동일 상태에서는 새 event를 만들지 않고 회복 시 `recovered`를 전달한다.
- 애플리케이션 경보는 기존 PostgreSQL outbox의 claim, lease, 지수 backoff, terminal 처리와 호환된다.

### 환경변수 복구 경계

- 운영 재생성 과정에서 `PIPELINE_ALERT_WEBHOOK_BEARER_TOKEN=`이 선택값이 아니라 빈 문자열로 Zod에 전달돼
  API restart loop를 유발하는 결함을 실제 운영과 같은 경로에서 발견했다.
- `optionalEnvValue()`를 webhook URL과 bearer token에 공통 적용해 빈 문자열과 공백만 있는 값을
  `undefined`로 정규화한다.
- RED 테스트로 기존 실패를 확인한 뒤, 빈 선택값, 유효한 URL/token 보존, 잘못된 URL의 secret-free 오류라는
  Happy/Edge/Error 회귀 테스트를 추가했다.
- 현재 운영 파일에서는 불필요한 빈 bearer key도 제거했으며, 코드 수정과 운영 설정 양쪽에서 재발 경계를
  닫았다.

### 파일시스템·Docker 경계

- backup marker 누락·손상·미래 시각과 정확한 age threshold 경계를 테스트한다.
- `statfs` BigInt 계산, bytes/percent OR 조건, 측정 실패의 안전한 경보 변환을 검증한다.
- sentinel은 backup bind를 read-only로 받고 `/state`만 쓸 수 있다.
- Docker socket, 제품 env file, DB/Redis/MinIO credential과 제품 service network를 받지 않는다.
- non-root, read-only rootfs, 모든 capability 제거, no-new-privileges와 resource limit이 적용됐다.

### 운영 연결

- URL 미설정 시 daemon은 disabled heartbeat를 유지하고 `send-test`만 exit 64로 fail-closed한다.
- 현재는 Discord Slack-compatible HTTPS receiver가 설정돼 API와 sentinel이 healthy다.
- 실제 synthetic receiver probe와 격리 outbox 통합 검증이 성공했다.
- Cloudflare notification이 동일 Mac 밖의 host/tunnel failure 감지를 담당한다.
- 공개 route와 stateful 서비스는 인프라 검증에서 정상이며, 관련 발송자만 재생성됐다.

## 개선 권장 사항

### High

없음.

### Medium

1. **대화에 노출된 Discord webhook URL 회전**
   - 현재 URL은 사용자의 명시적 지시로 동작 중이고 Git에는 포함되지 않았지만, webhook URL 자체가 발송
     credential이다.
   - 새 URL을 발급해 `.env.production`을 교체하고 `api`와 `ops-sentinel`만 재생성한 뒤 synthetic probe를
     다시 확인하며 기존 URL은 폐기할 것을 권고한다.

2. **Cloudflare Email 실제 수신 시험**
   - notification은 enabled로 확인됐지만 테스트 이메일은 외부 메시지이므로 사용자 확인 없이 발송하지 않았다.
   - 다음 운영 점검 창에 테스트 알림을 1회 보내 실제 mailbox 도착, 지연 시간, 복구 알림 표현을 기록한다.

### Low

1. `ops-sentinel.mjs`의 config, measurement, state, delivery, CLI 책임을 안정화 이후 모듈로 분리한다.
2. 로컬 검증 환경에서 `pnpm` 실행 경로를 표준화해 리뷰어가 동일 명령을 재현할 수 있게 한다.
3. Task 16에서 tunnel health와 별개인 외부 application synthetic monitor와 SLO를 추가한다.

## Reflection

재검증에서 실제 receiver 2xx와 notification enabled를 코드 품질과 혼동하지 않고 별도 운영 증거로 확인했다.
또한 단위 테스트만으로는 놓쳤던 Docker `env_file`의 `KEY=` 의미 차이를 실제 서비스 재생성에서 발견했고,
RED→GREEN 회귀 테스트와 운영 설정 정리 후 health까지 확인했다. 이는 운영 경로 검증이 설정 스키마의 현실적인
입력 형태까지 포함해야 한다는 반복 가능한 교훈이다.
Discord URL 노출은 저장소 유출은 아니며 사용자가 현재 사용을 승인했으므로 Task 완료를 차단하는 High 결함으로
과장하지 않았다. 반대로 URL이 발송 credential이라는 사실은 남으므로 회전 권고를 Medium 보안 부채로 유지했다.
Cloudflare 테스트 이메일도 미실행 자체를 설정 실패로 간주하지 않았지만, end-to-end 전달 증거가 아직 없다는
한계는 명시했다.

Memory MCP와 sequential-thinking MCP는 현재 도구 목록에 없어 convention graph 기록과 도구 기반 단계 추론은
수행하지 못했다. 아키텍처 결정은 ADR-0022, 반복 가능한 검증 결과는 이 보고서에 보존한다.

## 완료 판정

- [x] B 이상
- [x] High 코드 결함 없음
- [x] 실제 receiver URL이 운영 secret으로 설정됨
- [x] synthetic webhook 2xx 전달 확인
- [x] 애플리케이션 outbox 격리 검증 확인
- [x] API와 ops-sentinel healthy
- [x] 빈 webhook 선택값의 config 회귀 테스트와 운영 재시작 검증
- [x] Cloudflare Tunnel Health notification 활성화 확인
- [x] 운영 데이터와 임시 검증 DB 정리 확인

**최종 판정: Task 1 완료 가능. Task Master를 `done`으로 변경할 수 있다.**
