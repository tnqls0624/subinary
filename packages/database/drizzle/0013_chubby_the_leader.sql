CREATE TYPE "public"."merchant_rule_source" AS ENUM('human_confirmed', 'model_prediction', 'system_rule');--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD COLUMN "source" "merchant_rule_source" DEFAULT 'human_confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD COLUMN "prediction_trace_id" uuid;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "merchant_category_rules"
SET "source" = 'model_prediction'
WHERE "created_by" IS NULL;--> statement-breakpoint
UPDATE "merchant_category_rules"
SET "confirmed_at" = COALESCE("updated_at", "created_at")
WHERE "created_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD CONSTRAINT "merchant_category_rules_prediction_trace_id_ai_invocations_id_fk" FOREIGN KEY ("prediction_trace_id") REFERENCES "public"."ai_invocations"("id") ON DELETE no action ON UPDATE no action;
