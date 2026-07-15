CREATE TYPE "public"."card_sms_parse_status" AS ENUM('pending', 'parsed', 'parse_failed', 'pending_review');--> statement-breakpoint
CREATE TYPE "public"."card_sms_txn_type" AS ENUM('approval', 'cancellation', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('card_sms', 'slack', 'manual');--> statement-breakpoint
CREATE TABLE "card_sms_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"sender" text NOT NULL,
	"raw_content" text NOT NULL,
	"content_hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"parse_status" "card_sms_parse_status" DEFAULT 'pending' NOT NULL,
	"parse_error" text,
	"issuer" text,
	"transaction_type" "card_sms_txn_type",
	"amount" integer,
	"currency" text DEFAULT 'KRW',
	"merchant_raw" text,
	"occurred_at" timestamp with time zone,
	"masked_card_number" text,
	"installment_months" integer,
	"confidence" integer,
	"parsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_sms_events_device_id_event_id_unique" UNIQUE("device_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"object_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"device_id" uuid,
	"member_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_sms_events" ADD CONSTRAINT "card_sms_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_sms_events" ADD CONSTRAINT "card_sms_events_member_id_household_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_sms_events" ADD CONSTRAINT "card_sms_events_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_sms_events" ADD CONSTRAINT "card_sms_events_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_member_id_household_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_sms_events_household_id_idx" ON "card_sms_events" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "card_sms_events_parse_status_idx" ON "card_sms_events" USING btree ("parse_status");--> statement-breakpoint
CREATE INDEX "card_sms_events_household_id_parse_status_idx" ON "card_sms_events" USING btree ("household_id","parse_status");--> statement-breakpoint
CREATE INDEX "source_items_household_id_idx" ON "source_items" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "source_items_content_hash_idx" ON "source_items" USING btree ("content_hash");