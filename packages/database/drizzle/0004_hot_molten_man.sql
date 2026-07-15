CREATE TYPE "public"."budget_period" AS ENUM('monthly');--> statement-breakpoint
CREATE TYPE "public"."budget_scope_type" AS ENUM('household', 'member', 'category', 'card');--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text,
	"scope_type" "budget_scope_type" NOT NULL,
	"scope_ref_id" uuid,
	"amount" integer NOT NULL,
	"period" "budget_period" DEFAULT 'monthly' NOT NULL,
	"currency" text DEFAULT 'KRW' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_household_scope_type_scope_ref_id_unique" UNIQUE("household_id","scope_type","scope_ref_id")
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budgets_household_id_idx" ON "budgets" USING btree ("household_id");