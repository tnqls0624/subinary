-- 정기 지출 Radar의 저장소 — 후보/확정 series와 그 근거 거래 (C-5).
--
-- 전부 가산적(additive)이다. 기존 테이블·컬럼·데이터를 하나도 건드리지 않으므로
-- 롤백은 두 테이블과 두 enum을 드롭하는 것으로 끝난다.
--
-- ⚠️ **이 마이그레이션이 끝났다는 이유로 사용자 노출을 켜지 마십시오.**
-- 금액 계약(ADR-0027)이 아직 enforce 전이라 `card_transactions.net_amount`가 확정이
-- 아니고, 그 위에서 계산한 "다음 달 12,900원" 류의 예고는 틀린 사실을 확정처럼 말하는
-- 것이 된다. 스키마 배포와 노출은 애플리케이션 flag(`RECURRING_RADAR_ENABLED`,
-- 기본 off)가 분리한다. 로드맵 5-1절: "S4는 후보 표시와 사용자 확정까지만".
--
-- 적용 전 참고 조회(영향 범위 없음을 확인하는 용도):
--   SELECT to_regclass('public.recurring_series');            -- NULL 이어야 한다
--   SELECT count(*) FROM pg_type WHERE typname IN
--     ('recurring_series_status', 'recurring_cadence');       -- 0 이어야 한다

-- (1) 상태 어휘.
--
-- 왜 enum인가: 값이 4개로 닫혀 있고(PO 판정 Q1-3), 애플리케이션이 오타로 만든
-- 알 수 없는 상태가 들어오면 "사용자가 확정했는지"를 판정할 수 없게 된다.
-- 'needs_review'가 어휘에 있는 이유: 재계산이 사용자의 결정을 **조용히 지우는** 대신
-- 다시 봐 달라고 남길 자리가 필요하다.
CREATE TYPE "public"."recurring_series_status" AS ENUM (
  'candidate',
  'confirmed',
  'rejected',
  'needs_review'
);
--> statement-breakpoint

-- (2) 주기 어휘. 6개월 창에서 표본이 확보되는 것만 둔다 — 연 단위 구독은 관측이
--     1~2회라 결정적으로 판별할 수 없어 아예 후보로 만들지 않는다(오탐 방지).
CREATE TYPE "public"."recurring_cadence" AS ENUM ('weekly', 'monthly');
--> statement-breakpoint

-- (3) series 본체.
--
-- **신원은 `id`(UUID)다.** `(merchant, amount)` 복합키를 쓰지 않는 이유: 별칭
-- merge/unmerge가 과거 거래의 merchant_normalized를 바꾸고(merchant.service 백필),
-- ADR-0027 수리가 금액을 바꾼다. 문자열·금액을 신원으로 삼으면 그때마다 사용자의
-- "정기 결제 맞음" 판단이 통째로 끊긴다.
--
-- `member_id`가 있는 이유는 공개범위다. 정기 결제는 사람·카드 단위 사건이고, 여기서
-- 갈라 두지 않으면 타인의 private 거래가 가족 후보로 새어 P0-6이 재발한다.
CREATE TABLE "recurring_series" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  -- 계산 시점의 canonical 가맹점명. **표시용이며 신원이 아니다.**
  "merchant_canonical" text NOT NULL,
  -- 금액을 단일 값이 아니라 범위로 두는 이유: 금액 변동형 구독을 "동일 금액"으로
  -- 묶으면 매달 다른 요금의 구독이 영원히 후보가 되지 못한다.
  "amount_min" integer NOT NULL,
  "amount_max" integer NOT NULL,
  -- 대표 금액은 중앙값. 평균이면 1회의 이상값이 대표값을 끌고 간다.
  "amount_median" integer NOT NULL,
  "currency" text DEFAULT 'KRW' NOT NULL,
  "interval_days" integer NOT NULL,
  "cadence" "recurring_cadence" NOT NULL,
  "occurrence_count" integer NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "status" "recurring_series_status" DEFAULT 'candidate' NOT NULL,
  "status_changed_at" timestamp with time zone,
  "status_changed_by" uuid,
  -- 어휘: evidence_lost | merged | split. 이유 없이 상태만 바꾸면 사용자에게
  -- 무엇을 다시 보라는 것인지 말할 수 없다.
  "needs_review_reason" text,
  "algorithm_version" integer NOT NULL,
  -- 근거 거래들의 money_contract_version **최솟값**. 하나라도 v1 근거가 섞이면
  -- series 전체가 v1 신뢰도다(ADR-0027).
  "money_contract_version" integer NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- (4) 근거 거래 집합.
--
-- 재계산이 기존 series와 새 후보를 잇는 **유일한 연결선**이다. 문자열·금액이 아니라
-- 거래 ID로 이어야 별칭 merge/unmerge와 금액 수리를 견딘다.
--
-- `transaction_id`에 전역 UNIQUE를 걸지 않는다: needs_review가 된 옛 series가 과거
-- 근거를 들고 있는 동안 새 후보가 같은 거래를 근거로 잡을 수 있고, UNIQUE면 그
-- 순간 재계산이 죽는다. 사용자의 판단을 지키는 쪽이 우선이다.
--
-- ON DELETE CASCADE: 거래가 지워지면 그 근거도 함께 사라져야 한다(고아 근거로
-- 남으면 series가 존재하지 않는 사실을 계속 주장한다).
CREATE TABLE "recurring_series_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "series_id" uuid NOT NULL,
  "transaction_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recurring_series_evidence_series_transaction_unique"
    UNIQUE("series_id","transaction_id")
);
--> statement-breakpoint

ALTER TABLE "recurring_series"
  ADD CONSTRAINT "recurring_series_household_id_households_id_fk"
  FOREIGN KEY ("household_id") REFERENCES "public"."households"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_series"
  ADD CONSTRAINT "recurring_series_member_id_household_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."household_members"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_series"
  ADD CONSTRAINT "recurring_series_status_changed_by_users_id_fk"
  FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_series_evidence"
  ADD CONSTRAINT "recurring_series_evidence_series_id_recurring_series_id_fk"
  FOREIGN KEY ("series_id") REFERENCES "public"."recurring_series"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_series_evidence"
  ADD CONSTRAINT "recurring_series_evidence_transaction_id_card_transactions_id_fk"
  FOREIGN KEY ("transaction_id") REFERENCES "public"."card_transactions"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- (5) 정합 CHECK. 새 테이블이라 기존 행이 없어 즉시 검증돼도 안전하다.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_amount_band_check"
  CHECK ("amount_min" > 0 AND "amount_min" <= "amount_median" AND "amount_median" <= "amount_max");
--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_interval_days_check"
  CHECK ("interval_days" > 0);
--> statement-breakpoint
-- 2회는 "반복"의 하한이다. 엔진은 더 보수적으로(서로 다른 달 3회) 요구하지만,
-- DB는 규칙 조정에 흔들리지 않는 최소 정합만 강제한다.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_occurrence_count_check"
  CHECK ("occurrence_count" >= 2);
--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_seen_window_check"
  CHECK ("first_seen_at" <= "last_seen_at");
--> statement-breakpoint
-- 상태 이유는 needs_review일 때만 의미가 있다.
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_needs_review_reason_check"
  CHECK ("needs_review_reason" IS NULL OR "status" = 'needs_review');
--> statement-breakpoint

-- (6) 인덱스.
CREATE INDEX "recurring_series_household_id_idx"
  ON "recurring_series" USING btree ("household_id");
--> statement-breakpoint
CREATE INDEX "recurring_series_household_member_idx"
  ON "recurring_series" USING btree ("household_id","member_id");
--> statement-breakpoint
CREATE INDEX "recurring_series_household_status_idx"
  ON "recurring_series" USING btree ("household_id","status");
--> statement-breakpoint
-- 교집합 계산은 거래 ID로 역방향 조회한다.
CREATE INDEX "recurring_series_evidence_transaction_id_idx"
  ON "recurring_series_evidence" USING btree ("transaction_id");
