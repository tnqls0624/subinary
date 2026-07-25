CREATE TABLE "card_sms_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"sender" text NOT NULL,
	"skeleton" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"source_event_id" uuid,
	"confirmed_by" uuid,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_sms_templates_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "card_sms_templates" ADD CONSTRAINT "card_sms_templates_source_event_id_card_sms_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."card_sms_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_sms_templates" ADD CONSTRAINT "card_sms_templates_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;