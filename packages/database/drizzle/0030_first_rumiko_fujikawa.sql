CREATE TYPE "public"."training_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'blocked', 'revoked');--> statement-breakpoint
CREATE TABLE "training_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_snapshot_id" uuid NOT NULL,
	"model_registry_id" uuid,
	"task" text NOT NULL,
	"trainer_version" text NOT NULL,
	"status" "training_run_status" DEFAULT 'queued' NOT NULL,
	"artifact_key" text,
	"artifact_hash" text,
	"environment" jsonb,
	"metrics" jsonb,
	"pipeline_run_id" uuid,
	"requested_by" uuid NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"artifact_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_runs_artifact_hash_check" CHECK ("training_runs"."artifact_hash" is null or "training_runs"."artifact_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "training_runs_execution_state_check" CHECK (
        ("training_runs"."status" = 'queued' and "training_runs"."started_at" is null and "training_runs"."completed_at" is null)
        or ("training_runs"."status" = 'running' and "training_runs"."started_at" is not null and "training_runs"."completed_at" is null)
        or ("training_runs"."status" in ('succeeded', 'failed', 'blocked', 'revoked') and "training_runs"."completed_at" is not null)
      ),
	CONSTRAINT "training_runs_success_artifact_check" CHECK ("training_runs"."status" <> 'succeeded' or num_nonnulls("training_runs"."model_registry_id", "training_runs"."artifact_key", "training_runs"."artifact_hash", "training_runs"."environment", "training_runs"."metrics") = 5),
	CONSTRAINT "training_runs_error_check" CHECK ("training_runs"."status" not in ('failed', 'blocked') or "training_runs"."error_code" is not null),
	CONSTRAINT "training_runs_revocation_check" CHECK ("training_runs"."status" <> 'revoked' or ("training_runs"."revoked_at" is not null and "training_runs"."revocation_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "training_runs" ADD CONSTRAINT "training_runs_dataset_snapshot_id_dataset_snapshots_id_fk" FOREIGN KEY ("dataset_snapshot_id") REFERENCES "public"."dataset_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_runs" ADD CONSTRAINT "training_runs_model_registry_id_model_registry_id_fk" FOREIGN KEY ("model_registry_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_runs" ADD CONSTRAINT "training_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_runs" ADD CONSTRAINT "training_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_runs_dataset_created_at_idx" ON "training_runs" USING btree ("dataset_snapshot_id","created_at");--> statement-breakpoint
CREATE INDEX "training_runs_status_created_at_idx" ON "training_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "training_runs_model_registry_id_idx" ON "training_runs" USING btree ("model_registry_id");