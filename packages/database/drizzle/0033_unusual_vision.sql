CREATE TABLE "budget_alert_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"period_month" text NOT NULL,
	"threshold" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_alert_state_budget_period_threshold_unique" UNIQUE("budget_id","period_month","threshold")
);
--> statement-breakpoint
ALTER TABLE "budget_alert_state" ADD CONSTRAINT "budget_alert_state_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;