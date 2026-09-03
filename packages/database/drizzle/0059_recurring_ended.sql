-- =============================================================================
-- 0059 — 정기 지출 해지 확정 (금액 레이어 S4)
-- -----------------------------------------------------------------------------
-- ## 무엇을 추가하는가
--
--   1. `recurring_series_status`에 `ended` — 사용자가 "해지했어요"라고 **확정한** 상태.
--   2. `stopped_dismissed_at` — 사용자가 "아니에요, 계속 써요"라고 답한 시각.
--
-- ## 왜 `needs_review`로 올리지 않는가 (기획 D4의 취지를 지키려면)
--
-- 기획 §4 S4는 "예상일 + 유예 경과 → `needs_review` + 사유 `stopped`"라고 적었다.
-- 그대로 구현하면 D4가 막으려던 일이 그대로 일어난다: `GET /v1/recurring/upcoming`은
-- `status = 'confirmed'`만 조회하므로, 상태를 바꾸는 순간 그 series가 **이번 달 예상
-- 총액에서 조용히 빠진다.** D4가 쓴 문장이 정확히 그것이다 — "자동으로 status를 바꾸면
-- 사용자 모르게 이번 달 예상 총액이 줄어든다."
--
-- 그래서 감지는 **상태를 바꾸지 않는다.** 유예 경과 판정(`stoppedCandidate`)은 이미
-- `resolveRecurringPhase()`가 조회 시각에 계산하고 있고, 화면은 그 값으로 "해지하셨나요?"를
-- 묻기만 한다. 총액에는 사용자가 확정할 때까지 그대로 남는다.
--
-- 상태가 바뀌는 것은 **사용자가 답할 때뿐**이다:
--   - "해지했어요"    → `ended`  (예상에서 빠진다)
--   - "계속 써요"      → `confirmed` 유지 + `stopped_dismissed_at` 기록
--
-- `needs_review`는 원래 용도(근거 소실·병합·분할 — 시스템이 계산을 다시 해야 하는 경우)로
-- 남긴다. 해지는 계산 문제가 아니라 사실 확인이라 성격이 다르다.
--
-- ## `stopped_dismissed_at`이 필요한 이유
--
-- `stoppedCandidate`는 시간의 함수라 한 번 true가 되면 결제가 들어올 때까지 계속 true다.
-- 사용자가 "계속 써요"라고 답했는데 다음 조회에서 또 물으면 그건 답을 무시하는 것이다.
-- 이 시각 뒤 **한 주기가 더 지나야** 다시 묻는다(판정은 애플리케이션이 소유).
-- =============================================================================

-- 기존 enum에 값 추가. PostgreSQL 12+는 트랜잭션 안에서도 안전하다.
ALTER TYPE "recurring_series_status" ADD VALUE IF NOT EXISTS 'ended';--> statement-breakpoint

ALTER TABLE "recurring_series" ADD COLUMN "stopped_dismissed_at" timestamp with time zone;
