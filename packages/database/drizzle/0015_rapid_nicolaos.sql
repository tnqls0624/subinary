CREATE TABLE "data_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"revision_id" uuid,
	"workspace_id" uuid,
	"household_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"producer_pipeline_run_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"published_at" timestamp with time zone,
	"quarantined_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_events_aggregate_event_revision_unique" UNIQUE("aggregate_type","aggregate_id","event_type","revision_id"),
	CONSTRAINT "data_events_scope_check" CHECK (num_nonnulls("data_events"."workspace_id", "data_events"."household_id") <= 1),
	CONSTRAINT "data_events_lock_pair_check" CHECK (("data_events"."locked_at" is null) = ("data_events"."locked_by" is null)),
	CONSTRAINT "data_events_terminal_check" CHECK (num_nonnulls("data_events"."published_at", "data_events"."quarantined_at") <= 1),
	CONSTRAINT "data_events_attempts_check" CHECK ("data_events"."publish_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_events" ADD CONSTRAINT "data_events_producer_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("producer_pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_events_aggregate_idx" ON "data_events" USING btree ("aggregate_type","aggregate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "data_events_unpublished_available_idx" ON "data_events" USING btree ("available_at","id") WHERE "data_events"."published_at" is null and "data_events"."quarantined_at" is null;--> statement-breakpoint
CREATE INDEX "data_events_producer_pipeline_run_id_idx" ON "data_events" USING btree ("producer_pipeline_run_id");