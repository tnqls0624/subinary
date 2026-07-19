ALTER TABLE "model_canary_runs" ADD COLUMN "last_evaluation_trigger" text;--> statement-breakpoint
UPDATE "model_canary_runs"
SET "last_evaluation_trigger" = 'manual'
WHERE "status" IN ('passed', 'rolled_back')
   OR ("status" = 'superseded' AND "decision_reason" = 'rollback_unavailable');--> statement-breakpoint
ALTER TABLE "model_canary_runs" ADD CONSTRAINT "model_canary_runs_evaluation_trigger_check" CHECK ("model_canary_runs"."last_evaluation_trigger" is null or "model_canary_runs"."last_evaluation_trigger" in ('manual', 'scheduled'));
