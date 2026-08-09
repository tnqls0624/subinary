-- C-4 예산 월 원장.
--
-- 적용 전 재고 조사(읽기 전용):
--   SELECT scope_type, count(*) FROM budgets GROUP BY scope_type ORDER BY scope_type;
--   SELECT household_id, scope_type, scope_ref_id, count(*)
--     FROM budgets
--    GROUP BY household_id, scope_type, scope_ref_id
--   HAVING count(*) > 1;
--   SELECT count(*) AS invalid_scope_rows
--     FROM budgets
--    WHERE (scope_type = 'household') <> (scope_ref_id IS NULL);
--
-- 기존 값이 과거 어느 달에 얼마였는지 보여 주는 변경 이력이 없다. 따라서 created_at의
-- 달이나 모든 과거 달로 복제하면 없던 계획을 발명한다. 배포 순간의 서울 회계월만 최초
-- 신뢰 월로 귀속하고, 그 이전 월은 "예산 기록 없음 / 월 원장 도입 전"으로 남긴다.

DO $$
DECLARE
  invalid_scope_rows bigint;
BEGIN
  SELECT count(*)
    INTO invalid_scope_rows
    FROM budgets
   WHERE (scope_type = 'household') <> (scope_ref_id IS NULL);

  IF invalid_scope_rows > 0 THEN
    RAISE EXCEPTION
      'budgets: scope_type/scope_ref_id 정합이 깨진 %개 행을 먼저 수동 검토해야 한다',
      invalid_scope_rows;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "budgets" ADD COLUMN "effective_month" date;
--> statement-breakpoint

-- 왜 현재 서울월인가: 기존 단일 행에는 과거 계획 변경 이력이 없어서 이것만 사실을
-- 만들지 않는 귀속이다. current_timestamp를 서울 wall-clock으로 바꾼 뒤 월초 date를 만든다.
UPDATE "budgets"
   SET "effective_month" = date_trunc('month', current_timestamp AT TIME ZONE 'Asia/Seoul')::date
 WHERE "effective_month" IS NULL;
--> statement-breakpoint

ALTER TABLE "budgets" ALTER COLUMN "effective_month" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "budgets" DROP CONSTRAINT "budgets_household_scope_type_scope_ref_id_unique";
--> statement-breakpoint
DROP INDEX "budgets_household_scope_unique";
--> statement-breakpoint
DROP INDEX "budgets_household_id_idx";
--> statement-breakpoint

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_household_month_scope_ref_unique"
  UNIQUE("household_id", "effective_month", "scope_type", "scope_ref_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_household_month_scope_unique"
  ON "budgets" ("household_id", "effective_month")
  WHERE "scope_type" = 'household';
--> statement-breakpoint
CREATE INDEX "budgets_household_effective_month_idx"
  ON "budgets" ("household_id", "effective_month");
--> statement-breakpoint

CREATE TABLE "budget_copy_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "source_month" date NOT NULL,
  "target_month" date NOT NULL,
  "copied_budget_ids" jsonb NOT NULL,
  "copied_count" integer NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "budget_copy_ops_household_idempotency_unique"
    UNIQUE("household_id", "idempotency_key"),
  CONSTRAINT "budget_copy_operations_copied_count_check"
    CHECK ("copied_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "budget_copy_operations"
  ADD CONSTRAINT "budget_copy_operations_household_id_households_id_fk"
  FOREIGN KEY ("household_id") REFERENCES "public"."households"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_copy_operations"
  ADD CONSTRAINT "budget_copy_operations_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "budget_copy_ops_household_target_month_idx"
  ON "budget_copy_operations" ("household_id", "target_month");
