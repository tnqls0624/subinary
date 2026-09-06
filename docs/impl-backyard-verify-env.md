# 검증 환경 지침 — 뒷마당 슬라이스 5 (2026-09-06)

> 코디네이터 회신. 워커의 「검증 환경 확인 요청」에 대한 답이며 **확정 지침**이다.

## 1. 지금 떠 있는 스택은 운영이다 — 쓰기 금지

`docker compose ps`가 보여주는 12개 컨테이너는 전부
`/Users/soobeen/Desktop/Project/subinary/docker-compose.prod.yml` 소속이다
(컨테이너 라벨 `com.docker.compose.project.config_files`로 확인).
그 postgres에는 **실제 사용자 2명의 데이터**가 있다.

구현 설계서 §6.5도 이미 적었다 — "운영 사용자 상태로 경계 실험을 하지 않는다."
**테스트 가구를 만들더라도 운영 DB에 만들지 않는다.**
운영 API에 PUT을 보내지 않는다. 운영 컨테이너를 내리지 않는다.

## 2. 쓸 것 — 이 저장소에 이미 있는 격리 관례

일회용 검증 DB를 만들고 폐기하는 도구가 이미 있다. **새로 만들지 않는다.**

| 파일 | 역할 |
|---|---|
| `scripts/lib/verification-database-guard.mjs` | 가드. 허용된 이름의 DB만 생성·폐기 |
| `scripts/verify-card-sms-ingest-isolated.mjs` | **가장 가까운 참고 사례** |
| `scripts/verify-model-promotion-isolated.mjs` | 참고 |
| `scripts/verify-training-runner-isolated.mjs` | 참고 |

가드는 `family_memory_verify_<YYYYMMDDhhmmss>_<8자리hex>` 형식만 허용한다.
**우회하지 말고 그대로 따른다.** 위 스크립트 하나를 읽고 같은 구조로
`scripts/verify-play-state-isolated.mjs`를 만드는 것이 이번 검증의 올바른 형태다.

## 3. 개발 스택

루트 `docker-compose.yml`이 개발용이다(운영은 `docker-compose.prod.yml`).
띄우기 전에 **포트 충돌을 먼저 확인**한다. 운영이 이미 점유 중일 수 있다.
가능하면 §2의 격리 DB만으로 끝낸다 — 그게 이 저장소의 관례이고 더 안전하다.

## 4. API 접속

기존 스크립트 관례는 `process.env.API_BASE_URL || 'http://localhost:3001'`이다.

API 계층 검증이 격리 환경에서 불가능하면 **그 사실을 "확인 못 함"으로 적고**
DB 계층(`pg_column_size`)과 codec 계층 검증까지만 한다. 추정으로 통과를 적지 않는다.

## 5. 환경과 무관한 게이트를 먼저 끝낸다

슬라이스 5의 최비용 게이트인 **"초기 GET 실패 시 PUT 횟수 0"**은
가짜 브릿지 주입으로 확인 가능하다. **환경 문제로 미루지 않는다.**

API/DB 왕복만 격리 환경에 의존한다.

## 6. MCP 부재는 정상

Memory·context7가 도구 목록에 없는 것은 정상이며 막힐 이유가 아니다.
필요한 사실은 저장소 코드와 앞선 설계서·보고서에 전부 있다.
확인 못 한 것은 추정하지 말고 **"확인 못 함"**으로 적는다.
