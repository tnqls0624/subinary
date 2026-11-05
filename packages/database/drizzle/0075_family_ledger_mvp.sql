-- 모아 가족 원장 MVP 1차.
-- Person=household_members, Category=expense_categories.
-- OpenAccount/CreateGoal/CloseGoal/UpsertBudgetRule는 2차(테이블만 준비).
CREATE TABLE "institutions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id"),
  "name" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "institutions_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX "institutions_household_idx" ON "institutions" ("household_id");
--> statement-breakpoint
CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id"),
  "person_id" uuid NOT NULL REFERENCES "household_members"("id"),
  "institution_id" uuid REFERENCES "institutions"("id"),
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "currency" text DEFAULT 'KRW' NOT NULL,
  "balance" numeric(20, 0) DEFAULT '0' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "closed_at" timestamptz,
  CONSTRAINT "accounts_kind_check" CHECK ("kind" IN ('checking','savings','cash','loan','investment')),
  CONSTRAINT "accounts_currency_check" CHECK ("currency" = 'KRW'),
  CONSTRAINT "accounts_balance_check" CHECK ("balance" >= 0),
  CONSTRAINT "accounts_status_check" CHECK (("status" = 'open' AND "closed_at" IS NULL) OR ("status" = 'closed' AND "closed_at" IS NOT NULL)),
  CONSTRAINT "accounts_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 100),
  CONSTRAINT "accounts_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE INDEX "accounts_household_status_idx" ON "accounts" ("household_id", "status");
--> statement-breakpoint
CREATE INDEX "accounts_person_idx" ON "accounts" ("person_id");
--> statement-breakpoint
CREATE TABLE "loan_terms" (
  "account_id" uuid PRIMARY KEY NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "original_principal" numeric(20, 0) NOT NULL,
  "interest_rate_bps" integer,
  "maturity_date" date,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loan_terms_principal_check" CHECK ("original_principal" >= 0),
  CONSTRAINT "loan_terms_rate_check" CHECK ("interest_rate_bps" IS NULL OR "interest_rate_bps" BETWEEN 0 AND 100000),
  CONSTRAINT "loan_terms_maturity_check" CHECK ("maturity_date" IS NULL OR "maturity_date" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
);
--> statement-breakpoint
CREATE TABLE "goals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id"),
  "person_id" uuid NOT NULL REFERENCES "household_members"("id"),
  "name" text NOT NULL,
  "target_amount" numeric(20, 0) NOT NULL,
  "saved_amount" numeric(20, 0) DEFAULT '0' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "closed_at" timestamptz,
  CONSTRAINT "goals_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 100),
  CONSTRAINT "goals_target_check" CHECK ("target_amount" > 0),
  CONSTRAINT "goals_saved_check" CHECK ("saved_amount" >= 0),
  CONSTRAINT "goals_status_check" CHECK (("status" = 'open' AND "closed_at" IS NULL) OR ("status" = 'closed' AND "closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "goals_household_status_idx" ON "goals" ("household_id", "status");
--> statement-breakpoint
CREATE TABLE "budget_rules" (
  "id" uuid PRIMARY KEY NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id"),
  "person_id" uuid REFERENCES "household_members"("id"),
  "category_id" uuid REFERENCES "expense_categories"("id"),
  "period" text DEFAULT 'monthly' NOT NULL,
  "amount_limit" numeric(20, 0) NOT NULL,
  "effective_month" date NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "budget_rules_period_check" CHECK ("period" = 'monthly'),
  CONSTRAINT "budget_rules_limit_check" CHECK ("amount_limit" >= 0),
  CONSTRAINT "budget_rules_month_check" CHECK ("effective_month" = date_trunc('month', "effective_month"::timestamp)::date)
);
--> statement-breakpoint
CREATE INDEX "budget_rules_household_month_idx" ON "budget_rules" ("household_id", "effective_month");
--> statement-breakpoint
CREATE TABLE "account_transactions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "household_id" uuid NOT NULL REFERENCES "households"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id"),
  "person_id" uuid NOT NULL REFERENCES "household_members"("id"),
  "category_id" uuid REFERENCES "expense_categories"("id"),
  "kind" text NOT NULL,
  "amount" numeric(20, 0) NOT NULL,
  "currency" text DEFAULT 'KRW' NOT NULL,
  "memo" text,
  "counterparty_account_id" uuid REFERENCES "accounts"("id"),
  "transfer_group_id" uuid,
  "goal_id" uuid REFERENCES "goals"("id"),
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "idempotency_key" text NOT NULL,
  CONSTRAINT "account_transactions_household_idempotency_unique" UNIQUE ("household_id", "idempotency_key"),
  CONSTRAINT "account_transactions_kind_check" CHECK ("kind" IN ('expense','income','transfer_out','transfer_in')),
  CONSTRAINT "account_transactions_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "account_transactions_currency_check" CHECK ("currency" = 'KRW'),
  CONSTRAINT "account_transactions_memo_check" CHECK ("memo" IS NULL OR char_length(btrim("memo")) BETWEEN 1 AND 500),
  CONSTRAINT "account_transactions_transfer_check" CHECK (
    ("kind" IN ('expense','income') AND "counterparty_account_id" IS NULL AND "transfer_group_id" IS NULL AND "goal_id" IS NULL)
    OR ("kind" IN ('transfer_out','transfer_in') AND "counterparty_account_id" IS NOT NULL AND "transfer_group_id" IS NOT NULL AND "category_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "account_transactions_account_occurred_idx" ON "account_transactions" ("account_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "account_transactions_household_occurred_idx" ON "account_transactions" ("household_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "account_transactions_transfer_group_idx" ON "account_transactions" ("transfer_group_id");
--> statement-breakpoint
CREATE TABLE "account_balance_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id"),
  "household_id" uuid NOT NULL REFERENCES "households"("id"),
  "balance" numeric(20, 0) NOT NULL,
  "currency" text DEFAULT 'KRW' NOT NULL,
  "captured_at" timestamptz NOT NULL,
  "source" text DEFAULT 'scheduled' NOT NULL,
  "batch_id" uuid NOT NULL,
  CONSTRAINT "account_balance_snapshots_account_batch_unique" UNIQUE ("account_id", "batch_id"),
  CONSTRAINT "account_balance_snapshots_balance_check" CHECK ("balance" >= 0),
  CONSTRAINT "account_balance_snapshots_currency_check" CHECK ("currency" = 'KRW'),
  CONSTRAINT "account_balance_snapshots_source_check" CHECK ("source" = 'scheduled')
);
--> statement-breakpoint
CREATE INDEX "account_balance_snapshots_household_captured_idx" ON "account_balance_snapshots" ("household_id", "captured_at");
