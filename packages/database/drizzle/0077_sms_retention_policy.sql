-- SOO-34: 문자 원문 보존 정책 + 삭제 이력.
-- 기본값은 기존과 같은 'none'(계속) — 이미 있는 가구가 갑자기 원문을 잃지 않게 한다.
ALTER TABLE "households"
  ADD COLUMN "sms_retention_policy" text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "households"
  ADD CONSTRAINT "households_sms_retention_policy_check"
  CHECK ("sms_retention_policy" IN ('none', 'days_30', 'after_parse', 'failures_only'));
--> statement-breakpoint
-- 원문 본문은 절대 넣지 않는다. 언제·어떤 정책으로·성공/실패 건수만 남긴다.
-- 일부만 지워진 실행은 status='failed' + failed_* 건수로 남긴다(completed 금지).
CREATE TABLE "sms_raw_purge_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id"),
  "policy" text NOT NULL,
  "purged_event_count" integer NOT NULL,
  "purged_suppression_count" integer NOT NULL,
  "failed_event_count" integer NOT NULL DEFAULT 0,
  "failed_suppression_count" integer NOT NULL DEFAULT 0,
  "triggered_by" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "status" text NOT NULL,
  "error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "sms_raw_purge_logs_policy_check"
    CHECK ("policy" IN ('none', 'days_30', 'after_parse', 'failures_only')),
  CONSTRAINT "sms_raw_purge_logs_triggered_by_check"
    CHECK ("triggered_by" IN ('user', 'scheduler')),
  CONSTRAINT "sms_raw_purge_logs_status_check"
    CHECK ("status" IN ('completed', 'failed')),
  CONSTRAINT "sms_raw_purge_logs_counts_check"
    CHECK (
      "purged_event_count" >= 0
      AND "purged_suppression_count" >= 0
      AND "failed_event_count" >= 0
      AND "failed_suppression_count" >= 0
    ),
  CONSTRAINT "sms_raw_purge_logs_completed_no_failures_check"
    CHECK (
      "status" <> 'completed'
      OR ("failed_event_count" = 0 AND "failed_suppression_count" = 0)
    ),
  CONSTRAINT "sms_raw_purge_logs_actor_check"
    CHECK (
      ("triggered_by" = 'scheduler' AND "actor_user_id" IS NULL)
      OR ("triggered_by" = 'user' AND "actor_user_id" IS NOT NULL)
    ),
  CONSTRAINT "sms_raw_purge_logs_error_check"
    CHECK (
      ("status" = 'completed' AND "error_code" IS NULL)
      OR ("status" = 'failed' AND "error_code" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE INDEX "sms_raw_purge_logs_household_created_idx"
  ON "sms_raw_purge_logs" ("household_id", "created_at" DESC);
