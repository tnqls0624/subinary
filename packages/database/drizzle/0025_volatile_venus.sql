CREATE TYPE "public"."model_traffic_mode" AS ENUM('shadow', 'live');--> statement-breakpoint
CREATE TYPE "public"."model_traffic_policy_status" AS ENUM('active', 'paused', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."model_traffic_role" AS ENUM('primary', 'candidate');--> statement-breakpoint
CREATE TABLE "model_traffic_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_alias_id" uuid NOT NULL,
	"alias_revision" integer NOT NULL,
	"candidate_model_registry_id" uuid NOT NULL,
	"evaluation_run_id" uuid NOT NULL,
	"mode" "model_traffic_mode" NOT NULL,
	"traffic_basis_points" integer NOT NULL,
	"routing_salt" text NOT NULL,
	"status" "model_traffic_policy_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_traffic_policies_alias_revision_check" CHECK ("model_traffic_policies"."alias_revision" > 0),
	CONSTRAINT "model_traffic_policies_basis_points_check" CHECK ("model_traffic_policies"."traffic_basis_points" between 1 and 10000),
	CONSTRAINT "model_traffic_policies_routing_salt_check" CHECK (length("model_traffic_policies"."routing_salt") between 1 and 200),
	CONSTRAINT "model_traffic_policies_deactivation_check" CHECK (("model_traffic_policies"."status" = 'active') = ("model_traffic_policies"."deactivated_at" is null))
);
--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "traffic_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "traffic_mode" "model_traffic_mode";--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "traffic_role" "model_traffic_role";--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "traffic_bucket" integer;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD COLUMN "traffic_selected" boolean;--> statement-breakpoint
ALTER TABLE "model_traffic_policies" ADD CONSTRAINT "model_traffic_policies_model_alias_id_model_aliases_id_fk" FOREIGN KEY ("model_alias_id") REFERENCES "public"."model_aliases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_traffic_policies" ADD CONSTRAINT "model_traffic_policies_candidate_model_registry_id_model_registry_id_fk" FOREIGN KEY ("candidate_model_registry_id") REFERENCES "public"."model_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_traffic_policies" ADD CONSTRAINT "model_traffic_policies_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_traffic_policies" ADD CONSTRAINT "model_traffic_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_traffic_policies_active_alias_unique" ON "model_traffic_policies" USING btree ("model_alias_id") WHERE "model_traffic_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "model_traffic_policies_candidate_idx" ON "model_traffic_policies" USING btree ("candidate_model_registry_id");--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_traffic_policy_id_model_traffic_policies_id_fk" FOREIGN KEY ("traffic_policy_id") REFERENCES "public"."model_traffic_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_invocations_traffic_policy_started_at_idx" ON "ai_invocations" USING btree ("traffic_policy_id","started_at");--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_traffic_trace_check" CHECK (num_nonnulls("ai_invocations"."traffic_policy_id", "ai_invocations"."traffic_mode", "ai_invocations"."traffic_role", "ai_invocations"."traffic_bucket", "ai_invocations"."traffic_selected") in (0, 5));--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_traffic_bucket_check" CHECK ("ai_invocations"."traffic_bucket" is null or ("ai_invocations"."traffic_bucket" >= 0 and "ai_invocations"."traffic_bucket" < 10000));