CREATE TYPE "public"."card_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."card_visibility" AS ENUM('private', 'household', 'summary_only');--> statement-breakpoint
CREATE TYPE "public"."txn_status" AS ENUM('approved', 'partially_cancelled', 'cancelled', 'pending_review', 'duplicate_suspected');--> statement-breakpoint
CREATE TYPE "public"."txn_type" AS ENUM('approval', 'cancellation');--> statement-breakpoint
CREATE TABLE "card_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"card_id" uuid,
	"source_event_id" uuid NOT NULL,
	"transaction_type" "txn_type" NOT NULL,
	"status" "txn_status" NOT NULL,
	"amount" integer NOT NULL,
	"cancelled_amount" integer DEFAULT 0 NOT NULL,
	"net_amount" integer NOT NULL,
	"currency" text DEFAULT 'KRW' NOT NULL,
	"merchant_raw" text,
	"merchant_normalized" text,
	"category_id" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"authorization_code" text,
	"installment_months" integer,
	"parent_transaction_id" uuid,
	"visibility" "card_visibility" DEFAULT 'household' NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_transactions_source_event_id_unique" UNIQUE("source_event_id")
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_household_id_slug_unique" UNIQUE("household_id","slug")
);
--> statement-breakpoint
CREATE TABLE "merchant_category_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"merchant_pattern" text NOT NULL,
	"category_id" uuid NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_category_rules_household_id_merchant_pattern_unique" UNIQUE("household_id","merchant_pattern")
);
--> statement-breakpoint
CREATE TABLE "payment_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_member_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"alias" text NOT NULL,
	"masked_number" text,
	"card_fingerprint" text,
	"visibility" "card_visibility" DEFAULT 'household' NOT NULL,
	"status" "card_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_member_id_household_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_card_id_payment_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."payment_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_source_event_id_card_sms_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."card_sms_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_parent_transaction_id_card_transactions_id_fk" FOREIGN KEY ("parent_transaction_id") REFERENCES "public"."card_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD CONSTRAINT "merchant_category_rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD CONSTRAINT "merchant_category_rules_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_rules" ADD CONSTRAINT "merchant_category_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_transactions_household_id_idx" ON "card_transactions" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "card_transactions_household_id_member_id_idx" ON "card_transactions" USING btree ("household_id","member_id");--> statement-breakpoint
CREATE INDEX "card_transactions_card_id_idx" ON "card_transactions" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "card_transactions_household_id_transaction_type_idx" ON "card_transactions" USING btree ("household_id","transaction_type");--> statement-breakpoint
CREATE INDEX "card_transactions_parent_transaction_id_idx" ON "card_transactions" USING btree ("parent_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_system_slug_unique" ON "expense_categories" USING btree ("slug") WHERE "expense_categories"."household_id" is null;--> statement-breakpoint
CREATE INDEX "payment_cards_household_id_idx" ON "payment_cards" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "payment_cards_household_id_masked_number_idx" ON "payment_cards" USING btree ("household_id","masked_number");