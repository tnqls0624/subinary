# 카드 문자 파서 품질 지표 (ADR-0023 §관측)

카드사가 문구를 개편하면 규칙 파서(L0)가 **예외 없이** 실패하기 시작한다. 그 결과는 지출 누락이고,
사용자 눈에는 "결제가 없던 것"으로 보인다. 로그·경보로는 드러나지 않으므로 **캐스케이드 레이어별
성공/실패 비율**이 유일한 조기 신호다.

ADR-0023이 지표 이름까지 정해 뒀지만 원자료가 어디에도 저장되지 않아 계산할 수 없었다.
2026-08-10 라운드에서 저장·집계·조회를 붙였다.

## 지표

| 이름 | 정의 | 분모 | 오르면 |
|---|---|---|---|
| `llm_span_reject_rate` | L2(LLM span 추출)가 유효 span을 못 낸 비율 | L2를 호출한 파싱 건수 | 카드사 문구 개편 또는 프롬프트 회귀 |
| `human_correction_rate` | 사람이 확정·교정한 비율 | 창 안에서 파싱이 확정된 이벤트 수 | 파서가 조용히 틀리기 시작함 |
| `template_cache_hit_rate` | L1(템플릿 레시피)이 결정적으로 추출한 비율 | L1을 조회한 건수(= L0 미스) | 정상(LLM 호출이 0으로 수렴) |
| 검토 대기 적체 | `parse_status ∈ (quarantined, parse_failed)` 현재 건수 | — | 사람 검토가 밀림 |

`pending_review`는 적체에 세지 않는다 — 이미 거래로 승격돼 집계에 잡히므로 "멈춘 것"이 아니다.

## 저장 위치 — 새 테이블을 만들지 않았다

| 원자료 | 위치 | 쓰는 곳 |
|---|---|---|
| 레이어별 카운터(`llmAttempted`·`llmSpanRejected`·`recipeAttempted`·`recipeHit`·`llmRejectedSpans`·`parseSource`) | `pipeline_step_runs.metrics` (jsonb) | `apps/worker/src/processors/card-sms-parse.processor.ts` |
| 사람 교정 | `feedback_events` (`target_type='card-sms-parse'`, `source='human_confirmed'`) | `apps/api/src/card-sms/card-sms-review.service.ts` (기존) |
| 검토 적체 | `card_sms_events.parse_status` | 기존 |

**비율은 저장하지 않는다.** 비율은 창(window)에 종속이고 한 건 단위로는 0 또는 1뿐이다. 정수 카운터만
남기고 읽을 때 계산한다 — 창을 나중에 바꿀 수 있어야 한다.

**PII 금지**: `metrics`에는 정수 카운터와 닫힌 열거값(`parseSource`·`parseStatus`)만 들어간다. 문자
원문·가맹점명·금액은 넣지 않는다(ADR-0017). 이 규약은 `apps/worker/src/card-sms/parse-quality.test.ts`가
키 집합을 고정해 지킨다.

## 읽기

워커는 prod에서 포트를 외부로 열지 않으므로(내부 도커 네트워크 전용) 인증 없는 진단 창구를 쓴다.

```bash
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml \
  exec worker node -e "fetch('http://localhost:3002/v1/health/parser-quality').then(r=>r.json()).then(o=>console.log(JSON.stringify(o,null,2)))"

# 창 조정(기본 14일, 1~365)
# .../v1/health/parser-quality?windowDays=7
```

응답 예:

```json
{
  "windowStart": "2026-07-27T13:00:00.000Z",
  "llmSpanRejectRate": null,
  "humanCorrectionRate": 0,
  "templateCacheHitRate": null,
  "reviewBacklogCount": 3,
  "counts": { "llmAttempted": 0, "llmSpanRejected": 0, "recipeAttempted": 0, "recipeHit": 0, "parsedEvents": 41, "humanCorrections": 0 }
}
```

### `null`과 `0`은 다르다

`null`은 **표본이 없다**는 뜻이고 `0`은 **표본이 있는데 한 건도 해당되지 않았다**는 뜻이다. 0/0을 0으로
보고하면 "거절률 0% — 파서 완벽"으로 읽히지만 실제 뜻은 "LLM을 한 번도 안 불렀다"다(현재
`CARD_SMS_LLM_MODE=off`이므로 `llmSpanRejectRate`는 정상적으로 `null`이다). 이 구분이 무너지면 지표가
있으나 없으나 같아진다.

**임계값 판단은 `counts`를 함께 봐야 한다** — 1/1 = 100%도 비율만 보면 최악처럼 보인다.

### SQL로 직접 세기

```sql
-- 레이어별 카운터(최근 14일)
SELECT
  coalesce(sum((psr.metrics ->> 'llmAttempted')::int), 0)     AS llm_attempted,
  coalesce(sum((psr.metrics ->> 'llmSpanRejected')::int), 0)  AS llm_span_rejected,
  coalesce(sum((psr.metrics ->> 'recipeAttempted')::int), 0)  AS recipe_attempted,
  coalesce(sum((psr.metrics ->> 'recipeHit')::int), 0)        AS recipe_hit
FROM pipeline_step_runs psr
JOIN pipeline_runs pr ON pr.id = psr.pipeline_run_id
WHERE pr.pipeline_name = 'card-sms-parse'
  AND psr.step_name = 'parse-and-promote'
  AND psr.started_at >= now() - interval '14 days';
```

키가 없는 옛 실행 행은 `->>`가 NULL이라 자연히 제외된다(소급 백필은 하지 않는다 — 지표의 목적이
추세 감지이므로 도입 이전 구간은 표본에서 빠지는 편이 낫다).

## 아직 없는 것

- **자동 경보.** 임계 초과를 `operational_alerts`로 올리려면 `operational_alert_kind` enum에 값을
  추가하는 마이그레이션이 필요하다. 마이그레이션을 적용하기 전에 워커가 새 kind를 넣으면 INSERT가
  실패하므로, 배포와 함께 처리할 수 있는 라운드로 미뤘다. 그때까지는 위 엔드포인트를 사람이 본다.
- **화면 노출.** AI 파이프라인 운영 대시보드(`docs/operations/ai-pipeline-dashboard.md`)에 붙이려면
  `@family/contracts` 계약이 필요하다.

## 관련

- `docs/adr/0023-card-sms-ai-parsing-cascade.md`
- `packages/database/src/parser-quality.ts` (집계) · `apps/worker/src/card-sms/parse-quality.ts` (기록)
