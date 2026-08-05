CREATE TYPE "public"."card_sms_decline_reason" AS ENUM('lost_or_stolen', 'limit_exceeded', 'insufficient_balance', 'expired_card', 'suspended', 'invalid_credential', 'unknown');--> statement-breakpoint
ALTER TABLE "card_sms_events" ADD COLUMN "decline_reason" "card_sms_decline_reason";--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN "is_transfer" boolean DEFAULT false NOT NULL;