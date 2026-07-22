ALTER TABLE "card_transactions" ADD COLUMN "original_amount" integer;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD COLUMN "original_currency" text;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD COLUMN "exchange_rate" double precision;