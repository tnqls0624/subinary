CREATE TYPE "public"."model_canary_status" AS ENUM('monitoring', 'passed', 'rolled_back', 'superseded');--> statement-breakpoint
CREATE TABLE "model_canary_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_alias_id" uuid NOT NULL,
	"alias_revision" integer NOT NULL,
	"minimum_invocation_count" integer NOT NULL,
	"maximum_error_rate_basis_points" integer NOT NULL,
	"maximum_p95_duration_ms" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"status" "model_canary_status" DEFAULT 'monitoring' NOT NULL,
	"observed_invocation_count" integer DEFAULT 0 NOT NULL,
	"observed_failed_invocation_count" integer DEFAULT 0 NOT NULL,
	"observed_error_rate_basis_points" integer DEFAULT 0 NOT NULL,
	"observed_p95_duration_ms" integer DEFAULT 0 NOT NULL,
	"decision_reason" text,
	"rollback_revision" integer,
	"created_by" uuid NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_canary_runs_alias_revision_unique" UNIQUE("model_alias_id","alias_revision"),
	CONSTRAINT "model_canary_runs_revision_check" CHECK ("model_canary_runs"."alias_revision" > 0 and ("model_canary_runs"."rollback_revision" is null or "model_canary_runs"."rollback_revision" > "model_canary_runs"."alias_revision")),
	CONSTRAINT "model_canary_runs_policy_check" CHECK ("model_canary_runs"."minimum_invocation_count" > 0 and "model_canary_runs"."maximum_error_rate_basis_points" between 0 and 10000 and "model_canary_runs"."maximum_p95_duration_ms" > 0 and "model_canary_runs"."window_ends_at" > "model_canary_runs"."window_started_at"),
	CONSTRAINT "model_canary_runs_observation_check" CHECK ("model_canary_runs"."observed_invocation_count" >= 0 and "model_canary_runs"."observed_failed_invocation_count" between 0 and "model_canary_runs"."observed_invocation_count" and "model_canary_runs"."observed_error_rate_basis_points" between 0 and 10000 and "model_canary_runs"."observed_p95_duration_ms" >= 0),
	CONSTRAINT "model_canary_runs_decision_check" CHECK (("model_canary_runs"."status" = 'monitoring' and "model_canary_runs"."decision_reason" is null and "model_canary_runs"."rollback_revision" is null) or ("model_canary_runs"."status" = 'passed' and "model_canary_runs"."decision_reason" is not null and "model_canary_runs"."rollback_revision" is null) or ("model_canary_runs"."status" = 'rolled_back' and "model_canary_runs"."decision_reason" is not null and "model_canary_runs"."rollback_revision" is not null) or ("model_canary_runs"."status" = 'superseded' and "model_canary_runs"."rollback_revision" is null))
);
--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "model_alias_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "model_alias_revision" integer;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "model_registry_id" uuid;--> statement-breakpoint
ALTER TABLE "model_canary_runs" ADD CONSTRAINT "model_canary_runs_model_alias_id_model_aliases_id_fk" FOREIGN KEY ("model_alias_id") REFERENCES "public"."model_aliases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_canary_runs" ADD CONSTRAINT "model_canary_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_canary_runs_status_window_ends_at_idx" ON "model_canary_runs" USING btree ("status","window_ends_at");--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_model_alias_id_model_aliases_id_fk" FOREIGN KEY ("model_alias_id") REFERENCES "public"."model_aliases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_model_registry_id_model_registry_id_fk" FOREIGN KEY ("model_registry_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_invocations_alias_revision_started_at_idx" ON "ai_invocations" USING btree ("model_alias_id","model_alias_revision","started_at");--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_serving_trace_check" CHECK (num_nonnulls("ai_invocations"."model_alias_id", "ai_invocations"."model_alias_revision", "ai_invocations"."model_registry_id") in (0, 3));--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_alias_revision_check" CHECK ("ai_invocations"."model_alias_revision" is null or "ai_invocations"."model_alias_revision" > 0);