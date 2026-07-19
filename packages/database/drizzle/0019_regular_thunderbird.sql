CREATE TYPE "public"."evaluation_gate_result" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."evaluation_run_status" AS ENUM('succeeded', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."model_alias_change_type" AS ENUM('promotion', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."model_registry_status" AS ENUM('candidate', 'approved', 'rejected', 'retired');--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_snapshot_id" uuid NOT NULL,
	"baseline_model_id" uuid,
	"candidate_model_id" uuid NOT NULL,
	"evaluator_version" text NOT NULL,
	"baseline_metrics" jsonb,
	"candidate_metrics" jsonb NOT NULL,
	"baseline_slice_metrics" jsonb,
	"candidate_slice_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gate_criteria" jsonb NOT NULL,
	"gate_details" jsonb NOT NULL,
	"gate_result" "evaluation_gate_result" NOT NULL,
	"evaluation_hash" text NOT NULL,
	"status" "evaluation_run_status" DEFAULT 'succeeded' NOT NULL,
	"pipeline_run_id" uuid,
	"created_by" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_runs_evaluation_hash_unique" UNIQUE("evaluation_hash"),
	CONSTRAINT "evaluation_runs_baseline_pair_check" CHECK (("evaluation_runs"."baseline_model_id" is null) = ("evaluation_runs"."baseline_metrics" is null)),
	CONSTRAINT "evaluation_runs_hash_check" CHECK ("evaluation_runs"."evaluation_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "evaluation_runs_revocation_check" CHECK ("evaluation_runs"."status" <> 'revoked' or "evaluation_runs"."revoked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "model_alias_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_alias_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_model_registry_id" uuid,
	"model_registry_id" uuid NOT NULL,
	"evaluation_run_id" uuid,
	"change_type" "model_alias_change_type" NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_alias_revisions_alias_revision_unique" UNIQUE("model_alias_id","revision"),
	CONSTRAINT "model_alias_revisions_revision_check" CHECK ("model_alias_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"household_id" uuid,
	"task" text NOT NULL,
	"alias" text NOT NULL,
	"model_registry_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"evaluation_run_id" uuid,
	"last_change_type" "model_alias_change_type" NOT NULL,
	"activated_by" uuid NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspension_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_aliases_scope_check" CHECK (num_nonnulls("model_aliases"."workspace_id", "model_aliases"."household_id") = 1),
	CONSTRAINT "model_aliases_revision_check" CHECK ("model_aliases"."revision" > 0),
	CONSTRAINT "model_aliases_suspension_pair_check" CHECK (("model_aliases"."suspended_at" is null) = ("model_aliases"."suspension_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"household_id" uuid,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"version" text NOT NULL,
	"artifact_hash" text,
	"dimensions" integer,
	"status" "model_registry_status" DEFAULT 'candidate' NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_registry_scope_check" CHECK (num_nonnulls("model_registry"."workspace_id", "model_registry"."household_id") = 1),
	CONSTRAINT "model_registry_dimensions_check" CHECK ("model_registry"."dimensions" is null or "model_registry"."dimensions" > 0),
	CONSTRAINT "model_registry_artifact_hash_check" CHECK ("model_registry"."artifact_hash" is null or "model_registry"."artifact_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "model_registry_approval_check" CHECK ("model_registry"."status" not in ('approved', 'retired') or ("model_registry"."approved_at" is not null and "model_registry"."approved_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "model_registry_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_registry_id" uuid NOT NULL,
	"evaluation_run_id" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_registry_approvals_model_unique" UNIQUE("model_registry_id")
);
--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_dataset_snapshot_id_dataset_snapshots_id_fk" FOREIGN KEY ("dataset_snapshot_id") REFERENCES "public"."dataset_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_baseline_model_id_model_registry_id_fk" FOREIGN KEY ("baseline_model_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_candidate_model_id_model_registry_id_fk" FOREIGN KEY ("candidate_model_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_alias_revisions" ADD CONSTRAINT "model_alias_revisions_model_alias_id_model_aliases_id_fk" FOREIGN KEY ("model_alias_id") REFERENCES "public"."model_aliases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_alias_revisions" ADD CONSTRAINT "model_alias_revisions_previous_model_registry_id_model_registry_id_fk" FOREIGN KEY ("previous_model_registry_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_alias_revisions" ADD CONSTRAINT "model_alias_revisions_model_registry_id_model_registry_id_fk" FOREIGN KEY ("model_registry_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_alias_revisions" ADD CONSTRAINT "model_alias_revisions_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_alias_revisions" ADD CONSTRAINT "model_alias_revisions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_model_registry_id_model_registry_id_fk" FOREIGN KEY ("model_registry_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_registry" ADD CONSTRAINT "model_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_registry" ADD CONSTRAINT "model_registry_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_registry" ADD CONSTRAINT "model_registry_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_registry" ADD CONSTRAINT "model_registry_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_registry_approvals" ADD CONSTRAINT "model_registry_approvals_model_registry_id_model_registry_id_fk" FOREIGN KEY ("model_registry_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_registry_approvals" ADD CONSTRAINT "model_registry_approvals_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_registry_approvals" ADD CONSTRAINT "model_registry_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_runs_dataset_created_at_idx" ON "evaluation_runs" USING btree ("dataset_snapshot_id","created_at");--> statement-breakpoint
CREATE INDEX "evaluation_runs_candidate_created_at_idx" ON "evaluation_runs" USING btree ("candidate_model_id","created_at");--> statement-breakpoint
CREATE INDEX "evaluation_runs_gate_created_at_idx" ON "evaluation_runs" USING btree ("gate_result","created_at");--> statement-breakpoint
CREATE INDEX "model_alias_revisions_model_idx" ON "model_alias_revisions" USING btree ("model_registry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_aliases_workspace_task_alias_unique" ON "model_aliases" USING btree ("workspace_id","task","alias") WHERE "model_aliases"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "model_aliases_household_task_alias_unique" ON "model_aliases" USING btree ("household_id","task","alias") WHERE "model_aliases"."household_id" is not null;--> statement-breakpoint
CREATE INDEX "model_aliases_model_registry_id_idx" ON "model_aliases" USING btree ("model_registry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_registry_workspace_identity_unique" ON "model_registry" USING btree ("workspace_id","task","provider","model","version") WHERE "model_registry"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "model_registry_household_identity_unique" ON "model_registry" USING btree ("household_id","task","provider","model","version") WHERE "model_registry"."household_id" is not null;--> statement-breakpoint
CREATE INDEX "model_registry_task_status_created_at_idx" ON "model_registry" USING btree ("task","status","created_at");--> statement-breakpoint
CREATE INDEX "model_registry_approvals_evaluation_idx" ON "model_registry_approvals" USING btree ("evaluation_run_id");