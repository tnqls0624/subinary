-- 수동 자산·주택 기록만 추가한다. 기존 거래/잔액/공유/자동화는 변경하지 않는다.
-- 금액은 KRW 정수 문자열로 입출력하며 미입력은 NULL이다.
CREATE TABLE manual_assets (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  label text NOT NULL,
  visibility text NOT NULL DEFAULT 'private',
  amount numeric(20,0),
  currency text NOT NULL DEFAULT 'KRW',
  as_of_date date,
  source text,
  legal_owner_label text,
  note text,
  version integer NOT NULL DEFAULT 1,
  creation_payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT manual_assets_kind_check CHECK (kind IN ('account', 'saving', 'stock', 'loan')),
  CONSTRAINT manual_assets_visibility_check CHECK (visibility IN ('private', 'household')),
  CONSTRAINT manual_assets_amount_check CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT manual_assets_currency_check CHECK (currency = 'KRW'),
  CONSTRAINT manual_assets_snapshot_check CHECK (
    (amount IS NULL AND as_of_date IS NULL AND source IS NULL)
    OR (amount IS NOT NULL AND as_of_date IS NOT NULL AND source IS NOT NULL AND source = 'manual')
  ),
  CONSTRAINT manual_assets_date_check CHECK (as_of_date IS NULL OR (as_of_date >= DATE '0001-01-01' AND as_of_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date)),
  CONSTRAINT manual_assets_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  CONSTRAINT manual_assets_notes_check CHECK ((legal_owner_label IS NULL OR char_length(btrim(legal_owner_label)) BETWEEN 1 AND 100) AND (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 1000)),
  CONSTRAINT manual_assets_version_check CHECK (version > 0),
  CONSTRAINT manual_assets_creation_hash_check CHECK (creation_payload_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX manual_assets_household_scope_idx ON manual_assets (household_id, visibility, owner_user_id);
--> statement-breakpoint
CREATE TABLE manual_housing_plans (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  label text NOT NULL,
  visibility text NOT NULL DEFAULT 'private',
  occupancy_year integer,
  contract_stage text,
  funding_note text,
  version integer NOT NULL DEFAULT 1,
  creation_payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT manual_housing_plans_visibility_check CHECK (visibility IN ('private', 'household')),
  CONSTRAINT manual_housing_plans_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  CONSTRAINT manual_housing_plans_notes_check CHECK ((contract_stage IS NULL OR char_length(btrim(contract_stage)) BETWEEN 1 AND 100) AND (funding_note IS NULL OR char_length(btrim(funding_note)) BETWEEN 1 AND 2000)),
  CONSTRAINT manual_housing_plans_year_check CHECK (occupancy_year IS NULL OR occupancy_year BETWEEN 1 AND 9999),
  CONSTRAINT manual_housing_plans_version_check CHECK (version > 0),
  CONSTRAINT manual_housing_plans_creation_hash_check CHECK (creation_payload_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX manual_housing_plans_household_scope_idx ON manual_housing_plans (household_id, visibility, owner_user_id);
--> statement-breakpoint
CREATE TABLE manual_housing_payments (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES manual_housing_plans(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  kind text NOT NULL,
  installment integer,
  due_date date,
  amount numeric(20,0),
  paid_amount numeric(20,0),
  paid_date date,
  CONSTRAINT manual_housing_payments_plan_position_unique UNIQUE (plan_id, position),
  CONSTRAINT manual_housing_payments_position_check CHECK (position BETWEEN 0 AND 99),
  CONSTRAINT manual_housing_payments_kind_check CHECK (kind IN ('contract', 'interim', 'balance', 'option')),
  CONSTRAINT manual_housing_payments_installment_check CHECK (installment IS NULL OR installment BETWEEN 1 AND 1000),
  CONSTRAINT manual_housing_payments_amount_check CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT manual_housing_payments_paid_check CHECK (paid_amount IS NULL OR (amount IS NOT NULL AND paid_amount >= 0 AND paid_amount <= amount)),
  CONSTRAINT manual_housing_payments_paid_date_check CHECK (
    (paid_amount IS NOT NULL AND paid_amount > 0 AND paid_date IS NOT NULL)
    OR ((paid_amount IS NULL OR paid_amount = 0) AND paid_date IS NULL)
  ),
  CONSTRAINT manual_housing_payments_calendar_check CHECK (
    (due_date IS NULL OR due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND (paid_date IS NULL OR (paid_date >= DATE '0001-01-01' AND paid_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date))
  )
);
--> statement-breakpoint
-- 감사에는 식별자·행위·버전만 남긴다. 입력 금액/이름/메모를 복제하지 않는다.
CREATE TABLE manual_finance_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manual_finance_audit_entity_version_action_unique UNIQUE (entity_type, entity_id, version, action),
  CONSTRAINT manual_finance_audit_entity_type_check CHECK (entity_type IN ('asset', 'housing_plan')),
  CONSTRAINT manual_finance_audit_action_check CHECK (action IN ('create', 'update', 'delete', 'membership_removed')),
  CONSTRAINT manual_finance_audit_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX manual_finance_audit_household_idx ON manual_finance_audit (household_id, created_at);
