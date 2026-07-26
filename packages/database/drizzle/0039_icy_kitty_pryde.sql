ALTER TYPE "public"."operational_alert_kind" ADD VALUE 'card_sms_collection_gap';--> statement-breakpoint
ALTER TABLE "registered_devices" ADD COLUMN "first_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registered_devices" ADD COLUMN "last_event_at" timestamp with time zone;