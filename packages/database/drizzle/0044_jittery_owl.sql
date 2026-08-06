CREATE TABLE "card_sms_decline_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"merchant" text,
	"amount" integer,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_by" uuid,
	CONSTRAINT "card_sms_decline_dismissals_bucket_unique" UNIQUE NULLS NOT DISTINCT("household_id","merchant","amount")
);
--> statement-breakpoint
ALTER TABLE "card_sms_decline_dismissals" ADD CONSTRAINT "card_sms_decline_dismissals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_sms_decline_dismissals" ADD CONSTRAINT "card_sms_decline_dismissals_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_sms_decline_dismissals_household_idx" ON "card_sms_decline_dismissals" USING btree ("household_id");