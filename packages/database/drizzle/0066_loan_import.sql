-- Add reviewed browser observations without rewriting manual assets or prior balances.
-- Only a masked account identifier and fingerprint are stored; no bank session or credentials.
CREATE TABLE loan_records (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  account_fingerprint text NOT NULL,
  account_last4 text NOT NULL,
  loan_type text NOT NULL,
  label text NOT NULL,
  visibility text NOT NULL DEFAULT 'private',
  total_mode text NOT NULL DEFAULT 'reference',
  replaces_manual_asset_id uuid REFERENCES manual_assets(id),
  manual_expected_version integer,
  shared_member_id uuid REFERENCES household_members(id),
  shared_joined_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT loan_records_snapshot_scope_unique UNIQUE (id, household_id, owner_user_id),
  CONSTRAINT loan_records_fingerprint_check CHECK (account_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT loan_records_last4_check CHECK (account_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT loan_records_type_check CHECK (loan_type IN ('interim', 'jeonse')),
  CONSTRAINT loan_records_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  CONSTRAINT loan_records_visibility_check CHECK (visibility IN ('private', 'household')),
  CONSTRAINT loan_records_total_mode_check CHECK (total_mode IN ('reference', 'distinct', 'replacement')),
  CONSTRAINT loan_records_mapping_check CHECK (
    (total_mode = 'replacement' AND replaces_manual_asset_id IS NOT NULL AND manual_expected_version IS NOT NULL AND manual_expected_version > 0)
    OR (total_mode IN ('reference', 'distinct') AND replaces_manual_asset_id IS NULL AND manual_expected_version IS NULL)
  ),
  CONSTRAINT loan_records_sharing_grant_check CHECK (
    (visibility = 'household' AND shared_member_id IS NOT NULL AND shared_joined_at IS NOT NULL)
    OR (visibility = 'private' AND shared_member_id IS NULL AND shared_joined_at IS NULL)
  ),
  CONSTRAINT loan_records_version_check CHECK (version > 0)
);
--> statement-breakpoint
-- A new reviewed record may replace a deleted import. Snapshot request IDs and
-- deleted record IDs remain immutable tombstones; replay cannot restore them.
-- Scope identity to a household so an inaccessible former-family record cannot
-- block a new reviewed import after the owner joins a different household.
CREATE UNIQUE INDEX loan_records_owner_fingerprint_unique ON loan_records (household_id, owner_user_id, account_fingerprint)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX loan_records_manual_replacement_unique ON loan_records (replaces_manual_asset_id)
  WHERE deleted_at IS NULL AND replaces_manual_asset_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX loan_records_household_scope_idx ON loan_records (household_id, visibility, owner_user_id);
--> statement-breakpoint
CREATE TABLE loan_snapshots (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL,
  household_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  outstanding_principal_krw numeric(20,0) NOT NULL,
  maturity_date date,
  captured_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'browser_assisted',
  format_version integer NOT NULL DEFAULT 1,
  payload_hash text NOT NULL,
  record_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loan_snapshots_record_scope_fk FOREIGN KEY (record_id, household_id, owner_user_id)
    REFERENCES loan_records(id, household_id, owner_user_id),
  CONSTRAINT loan_snapshots_record_version_unique UNIQUE (record_id, record_version),
  CONSTRAINT loan_snapshots_amount_check CHECK (outstanding_principal_krw >= 0),
  CONSTRAINT loan_snapshots_maturity_check CHECK (maturity_date IS NULL OR maturity_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  CONSTRAINT loan_snapshots_capture_check CHECK (captured_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND captured_at <= CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
  CONSTRAINT loan_snapshots_source_check CHECK (source = 'browser_assisted'),
  CONSTRAINT loan_snapshots_format_version_check CHECK (format_version = 1),
  CONSTRAINT loan_snapshots_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT loan_snapshots_record_version_check CHECK (record_version > 0)
);
--> statement-breakpoint
-- Correcting a capture appends an observation; it cannot alter the reviewed evidence.
CREATE FUNCTION reject_loan_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loan snapshots are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loan_snapshots_immutable
  BEFORE UPDATE OR DELETE ON loan_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_loan_snapshot_mutation();
