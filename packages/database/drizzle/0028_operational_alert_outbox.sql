CREATE TYPE "public"."operational_alert_kind" AS ENUM('pipeline_failed', 'outbox_quarantined', 'canary_rolled_back', 'canary_suspended');--> statement-breakpoint
CREATE TYPE "public"."operational_alert_severity" AS ENUM('warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."operational_alert_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "operational_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" "operational_alert_kind" NOT NULL,
	"severity" "operational_alert_severity" NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "operational_alert_status" DEFAULT 'pending' NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_alerts_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "operational_alerts_lock_pair_check" CHECK (("operational_alerts"."locked_at" is null) = ("operational_alerts"."locked_by" is null)),
	CONSTRAINT "operational_alerts_terminal_check" CHECK (("operational_alerts"."status" = 'pending' and "operational_alerts"."delivered_at" is null and "operational_alerts"."failed_at" is null) or ("operational_alerts"."status" = 'delivered' and "operational_alerts"."delivered_at" is not null and "operational_alerts"."failed_at" is null) or ("operational_alerts"."status" = 'failed' and "operational_alerts"."delivered_at" is null and "operational_alerts"."failed_at" is not null)),
	CONSTRAINT "operational_alerts_attempts_check" CHECK ("operational_alerts"."delivery_attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "operational_alerts_pending_available_idx" ON "operational_alerts" USING btree ("available_at","id") WHERE "operational_alerts"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "operational_alerts_kind_occurred_at_idx" ON "operational_alerts" USING btree ("kind","occurred_at");