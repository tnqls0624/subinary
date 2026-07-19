# AI 파이프라인 운영 대시보드

가족 owner/admin은 **더보기 → AI 파이프라인 운영**에서 최근 24시간 지표를 확인한다. 화면은 30초마다
갱신되며 원문, job payload, job ID, 사용자 ID를 반환하지 않는다.

## 지표 범위

- 서버 전체: BullMQ queue depth/age/active/delayed/failed, 운영 경보 pending/failed
- 선택 가족: data outbox backlog/quarantine, pipeline 실행·실패율·p95, AI 오류율·p95·토큰,
  사람 확정 라벨·클래스, 승인/revoke 데이터셋, offline gate 통과/실패

토큰은 모델별 단가가 자주 바뀌고 과거 호출 시점 가격표가 아직 고정되지 않았으므로 비용의 직접 금액이
아닌 **비용 프록시**로 표시한다. 가격표를 도입할 때는 provider/model/revision별 단가 버전을 실행 trace와
함께 고정해야 하며 현재 단가를 과거 호출에 소급 적용하지 않는다.

## 권한과 장애 처리

`GET /v1/learning/operations/metrics?householdId=...&windowHours=24`는 활성 household owner/admin만
허용한다. 가족 범위 데이터는 해당 household로 제한한다. 큐와 경보는 단일 맥 서버 전체 운영 상태이므로
응답에서 `scope=server`로 명시한다.

Redis 큐 하나를 읽지 못해도 DB 지표 전체를 실패시키지 않는다. 해당 큐는 `available=false`로 반환하고
API 로그에는 큐 이름과 오류 class만 남긴다.

## 검증

```bash
# 계약, 집계 SQL, owner 권한, Redis 연결, 모델 승격/경보 회귀를 일회성 DB에서 확인
pnpm verify:ai-pipeline:isolated

# 운영 컨테이너 상태
docker compose --env-file .env --env-file .env.production \
  -f docker-compose.prod.yml ps api web worker redis
```
