-- =============================================================================
-- 0058 — 정기 지출 다음 예상일 저장 (금액 레이어 S1)
-- -----------------------------------------------------------------------------
-- ## 왜 저장하는가
--
-- 지금은 목록 조회가 `forecastRecurring`을 매번 돌려 예상일을 만든다. 화면 하나만
-- 볼 때는 문제가 없지만, 금액 레이어는 **세 곳이 같은 값을 봐야** 한다 — 목록 카드,
-- 홈 "앞으로 나갈 돈", 예정 알림. 각자 계산하면 요청 시각 차이로 서로 다른 날짜를
-- 말하고, 그건 "내일 빠져요"라고 알린 뒤 목록에서 모레로 보이는 종류의 사고가 된다.
--
-- `next_expected_at`은 `last_seen_at`·`interval_days`의 순수 함수이므로 재계산 시점에
-- 확정할 수 있다. 반면 `phase`(upcoming/due/overdue)는 **조회 시각에 의존**하므로
-- 저장하지 않는다 — 저장하면 하루만 지나도 거짓이 된다. 저장된 예상일 하나에서
-- 각자 phase를 계산하면 값은 자연히 일치한다.
--
-- ## 왜 nullable인가
--
-- 재계산을 한 번도 거치지 않은 기존 행이 있다. 컬럼을 추가하는 시점에 값을 만들지
-- 않는다 — 예상일은 `interval_days`·`cadence`에서 나오고 그 계산은 애플리케이션이
-- 소유하므로, 마이그레이션이 흉내 내면 규칙이 두 곳으로 갈라진다.
--
-- 값은 **모든 series에** 저장하고 노출만 `confirmed`로 제한한다. 저장을 confirmed로
-- 좁히면 사용자가 확정하는 순간 값이 없어 그때 다시 계산해야 하는데, 그 `now`는
-- 재계산 시점의 `now`와 달라 같은 series가 두 날짜를 갖게 된다.
--
-- `next_expected_window_days`도 같이 둔다. 창 폭은 `cadence`에서 유도되는 상수지만,
-- 상수를 바꿀 때 과거 예상이 소급 변하지 않아야 한다 — "8월 24일쯤(±2일)"이라고
-- 알린 뒤 창이 ±3일로 바뀌면 그 알림이 사후에 다른 말을 한 셈이 된다.
-- =============================================================================

ALTER TABLE "recurring_series" ADD COLUMN "next_expected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD COLUMN "next_expected_window_days" integer;--> statement-breakpoint

-- 홈·알림이 "이번 달 남은 정기"를 뽑는 경로. 확정 series만 대상이라 부분 인덱스로 좁힌다.
CREATE INDEX "recurring_series_next_expected_idx"
  ON "recurring_series" ("household_id", "next_expected_at")
  WHERE "status" = 'confirmed' AND "next_expected_at" IS NOT NULL;--> statement-breakpoint

-- 창 폭은 양수여야 한다. 0이면 "정확히 그날"이라는 뜻이 되어 D3(범위로 말한다)을 어긴다.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_next_window_check"
  CHECK ("next_expected_window_days" IS NULL OR "next_expected_window_days" > 0);
