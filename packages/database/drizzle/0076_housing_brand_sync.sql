-- SOO-47: 수자인 신축 주택 납부·옵션 조회 연결. 토스증권·신한 금고 테이블과 섞지 않는다.
-- 자격증명은 AES-256-GCM envelope(jsonb)만 두고 평문 컬럼은 없다.
CREATE TABLE housing_brand_connections (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES manual_housing_plans(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  brand text NOT NULL,
  login_fingerprint text NOT NULL,
  credentials jsonb,
  status text NOT NULL DEFAULT 'connected',
  status_message text,
  version integer NOT NULL DEFAULT 1,
  last_fetch_at timestamptz,
  last_success_at timestamptz,
  /** 확인/새로고침 때 읽은 미리보기. 반영은 클라이언트가 보낸 금액이 아니라 이 값을 쓴다. */
  last_preview jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  CONSTRAINT housing_brand_connections_plan_scope_unique UNIQUE (id, plan_id, household_id, owner_user_id),
  CONSTRAINT housing_brand_connections_brand_check CHECK (brand = 'sujain'),
  CONSTRAINT housing_brand_connections_status_check CHECK (status IN ('connected', 'needs_confirmation', 'failed')),
  CONSTRAINT housing_brand_connections_version_check CHECK (version > 0),
  CONSTRAINT housing_brand_connections_fingerprint_check CHECK (login_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT housing_brand_connections_message_check CHECK (status_message IS NULL OR char_length(btrim(status_message)) BETWEEN 1 AND 200),
  CONSTRAINT housing_brand_connections_disconnected_check CHECK (
    disconnected_at IS NULL
    OR (status = 'failed' AND credentials IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX housing_brand_connections_active_plan_unique
  ON housing_brand_connections(plan_id)
  WHERE disconnected_at IS NULL;
--> statement-breakpoint
CREATE INDEX housing_brand_connections_owner_idx
  ON housing_brand_connections(household_id, owner_user_id);
--> statement-breakpoint
-- 납부 일정 숫자 출처·기준시각·옵션 이름. 기존 행은 직접 입력으로 본다(NULL 허용).
ALTER TABLE manual_housing_payments ADD COLUMN label text;
--> statement-breakpoint
ALTER TABLE manual_housing_payments ADD COLUMN amount_source text;
--> statement-breakpoint
ALTER TABLE manual_housing_payments ADD COLUMN amount_as_of_at timestamptz;
--> statement-breakpoint
ALTER TABLE manual_housing_payments ADD COLUMN paid_amount_source text;
--> statement-breakpoint
ALTER TABLE manual_housing_payments ADD COLUMN paid_amount_as_of_at timestamptz;
--> statement-breakpoint
ALTER TABLE manual_housing_payments ADD CONSTRAINT manual_housing_payments_label_check
  CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE manual_housing_payments ADD CONSTRAINT manual_housing_payments_amount_source_check
  CHECK (
    (amount IS NULL AND amount_source IS NULL AND amount_as_of_at IS NULL)
    OR (amount IS NOT NULL AND (
      amount_source IS NULL
      OR (amount_source IN ('manual', 'sujain_fetch', 'confirmed') AND amount_as_of_at IS NOT NULL)
    ))
  );
--> statement-breakpoint
ALTER TABLE manual_housing_payments ADD CONSTRAINT manual_housing_payments_paid_source_check
  CHECK (
    (paid_amount IS NULL AND paid_amount_source IS NULL AND paid_amount_as_of_at IS NULL)
    OR (paid_amount IS NOT NULL AND (
      paid_amount_source IS NULL
      OR (paid_amount_source IN ('manual', 'sujain_fetch', 'confirmed') AND paid_amount_as_of_at IS NOT NULL)
    ))
  );
--> statement-breakpoint
CREATE FUNCTION revoke_housing_brand_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.role = 'viewer' OR NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
    UPDATE housing_brand_connections
      SET status = 'failed',
          status_message = '가족 구성 상태가 바뀌어 연결이 해제됐어요.',
          disconnected_at = now(),
          credentials = NULL,
          updated_at = now(),
          version = LEAST(version::bigint + 1, 2147483647)::integer
      WHERE owner_user_id = OLD.user_id
        AND household_id = OLD.household_id
        AND disconnected_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER housing_brand_membership_revoke
  AFTER UPDATE OF status, role, joined_at ON household_members
  FOR EACH ROW EXECUTE FUNCTION revoke_housing_brand_membership();
