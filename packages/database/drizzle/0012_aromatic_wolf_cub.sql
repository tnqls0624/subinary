CREATE TYPE "public"."ai_invocation_outcome" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ai_operation" AS ENUM('llm_generate', 'embedding', 'rerank');--> statement-breakpoint
CREATE TYPE "public"."feedback_source" AS ENUM('human_confirmed', 'human_rejected', 'system_rule', 'model_prediction', 'imported_gold');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'quarantined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pipeline_trigger" AS ENUM('api', 'bullmq', 'scheduled', 'backfill', 'system');--> statement-breakpoint
CREATE TABLE "ai_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_run_id" uuid,
	"task" text NOT NULL,
	"operation" "ai_operation" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text,
	"input_fingerprint" text NOT NULL,
	"input_count" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer NOT NULL,
	"outcome" "ai_invocation_outcome" NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_invocations_input_count_check" CHECK ("ai_invocations"."input_count" >= 0),
	CONSTRAINT "ai_invocations_duration_ms_check" CHECK ("ai_invocations"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"household_id" uuid,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"prediction_trace_id" uuid,
	"label_schema_version" text NOT NULL,
	"label" jsonb NOT NULL,
	"source" "feedback_source" NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_events_scope_check" CHECK (num_nonnulls("feedback_events"."workspace_id", "feedback_events"."household_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_name" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"scope_type" text,
	"scope_id" text,
	"trigger" "pipeline_trigger" NOT NULL,
	"external_run_id" text,
	"code_sha" text,
	"config_hash" text,
	"status" "pipeline_run_status" DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_runs_scope_pair_check" CHECK (("pipeline_runs"."scope_type" is null) = ("pipeline_runs"."scope_id" is null))
);
--> statement-breakpoint
CREATE TABLE "pipeline_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"step_name" text NOT NULL,
	"step_version" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "pipeline_run_status" DEFAULT 'queued' NOT NULL,
	"input_count" integer,
	"output_count" integer,
	"rejected_count" integer,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_step_runs_run_step_attempt_unique" UNIQUE("pipeline_run_id","step_name","attempt")
);
--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_prediction_trace_id_ai_invocations_id_fk" FOREIGN KEY ("prediction_trace_id") REFERENCES "public"."ai_invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_invocations_task_started_at_idx" ON "ai_invocations" USING btree ("task","started_at");--> statement-breakpoint
CREATE INDEX "ai_invocations_model_started_at_idx" ON "ai_invocations" USING btree ("model","started_at");--> statement-breakpoint
CREATE INDEX "ai_invocations_outcome_started_at_idx" ON "ai_invocations" USING btree ("outcome","started_at");--> statement-breakpoint
CREATE INDEX "ai_invocations_pipeline_run_id_idx" ON "ai_invocations" USING btree ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "feedback_events_workspace_id_occurred_at_idx" ON "feedback_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "feedback_events_household_id_occurred_at_idx" ON "feedback_events" USING btree ("household_id","occurred_at");--> statement-breakpoint
CREATE INDEX "feedback_events_target_idx" ON "feedback_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "feedback_events_prediction_trace_id_idx" ON "feedback_events" USING btree ("prediction_trace_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_pipeline_name_started_at_idx" ON "pipeline_runs" USING btree ("pipeline_name","started_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_status_started_at_idx" ON "pipeline_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_external_run_id_idx" ON "pipeline_runs" USING btree ("external_run_id");--> statement-breakpoint
CREATE INDEX "pipeline_step_runs_status_started_at_idx" ON "pipeline_step_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "embeddings_model_dim_idx" ON "embeddings" USING btree ("model","dim");