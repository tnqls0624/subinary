-- 카테고리 소급 재분류의 되돌리기 원장 — 배치 1건과, 그 배치가 바꾼 **거래별 이전 값**.
--
-- 왜 필요한가: "이 가맹점 거래를 전부 이 카테고리로"는 클릭 한 번으로 과거 수백 건의
-- `card_transactions.category_id`를 덮어쓴다. 지금 구조에는 덮어쓰기 전 값이 **어디에도
-- 남지 않는다.** `merchant_category_rules`는 앞으로의 분류만 학습하고(그 테이블 주석:
-- "과거 거래 소급 안 함"), 거래 행의 옛 카테고리는 UPDATE와 함께 사라진다. 즉 잘못
-- 누른 사용자에게 되돌릴 방법이 없다. 되돌리기를 지원하려면 이전 값을 따로 적어 두는
-- 방법밖에 없고, 이 두 테이블이 그 자리다.
--
-- ⚠️ **왜 "이전 카테고리"를 배치에 단일 컬럼(`from_category_id`)으로 두지 않는가:**
-- 한 배치의 대상 거래들이 같은 카테고리라는 보장이 없기 때문이다. 실제 데이터에서는
-- 일부는 식비, 일부는 장보기, 일부는 아직 미분류(NULL)인 상태가 섞여 있다 — 애초에
-- 그 뒤죽박죽이 사용자가 일괄 재분류를 누르는 이유다. 배치에 단일 from을 적어 두면
-- 되돌릴 때 그 하나의 값으로 전부 되돌려 **원래 없던 분류를 만들어 낸다**(미분류였던
-- 거래에 식비가 생긴다). 그래서 from은 배치가 아니라 items에 행별로 남긴다
-- (`previous_category_id`). 배치에는 대상 전체가 실제로 공유하는 사실인 to만 둔다.
--
-- PII: 자유 텍스트 컬럼을 **일부러 만들지 않았다**(메모·사유·원문 문자 자리 없음).
-- `merchant_canonical`은 가맹점 표시명이고 표시·감사용이다 — 되돌리기 자체는 이 문자열이
-- 아니라 items의 거래 ID로 동작하므로, 나중에 별칭 merge가 이름을 바꿔도 원장은 멀쩡하다.
--
-- 전부 가산적(additive)이다. 기존 테이블·컬럼·데이터를 하나도 건드리지 않는다.
-- 롤백(역순 — items가 batches를 참조한다):
--   DROP TABLE "category_recategorize_items";
--   DROP TABLE "category_recategorize_batches";
--
-- 적용 전 참고 조회(영향 범위 없음을 확인하는 용도):
--   SELECT to_regclass('public.category_recategorize_batches');  -- NULL 이어야 한다
--   SELECT to_regclass('public.category_recategorize_items');    -- NULL 이어야 한다

-- (1) 배치 1건 = "사용자가 재분류를 한 번 눌렀다"는 사건.
--
-- `applied_count`를 items 행 수로 대체하지 않고 컬럼으로 못 박는 이유: 아래 items는
-- 거래가 삭제되면 함께 사라진다(ON DELETE cascade). 그러면 "그때 몇 건을 바꿨나"라는
-- **과거의 사실**까지 조용히 줄어든다. 감사 기록은 현재 상태를 따라다니면 안 된다.
CREATE TABLE IF NOT EXISTS "category_recategorize_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL,
  -- 적용 시점의 canonical 가맹점명. 표시·감사용이며 **신원이 아니다.**
  "merchant_canonical" text NOT NULL,
  -- 대상 전체가 공유하는 유일한 카테고리 값. from은 여기 없다(머리주석 참고).
  "to_category_id" uuid NOT NULL,
  "applied_count" integer NOT NULL,
  "applied_by" uuid NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- 되돌리기 3종은 NULL인 채로 시작해 **함께** 채워진다. NULL은 "아직 되돌리지 않음"
  -- 이고, 이는 `reverted_count = 0`("되돌렸는데 실제로 바뀐 건 0건")과 **다른 사실**이다
  -- (0054 규약: '아직 모름'과 '0건'이 다른 축은 nullable로 둔다).
  "reverted_at" timestamp with time zone,
  "reverted_by" uuid,
  "reverted_count" integer
);
--> statement-breakpoint

-- (2) 배치가 바꾼 거래와 그 거래의 **이전 카테고리**. 되돌리기의 실제 재료다.
--
-- PK를 대리키가 아니라 (batch_id, transaction_id) 복합키로 두는 이유: 한 배치에서 한
-- 거래는 한 번만 기록돼야 한다. 중복 행이 생기면 되돌릴 값이 둘이 되어 "어느 쪽으로
-- 되돌리는가"가 비결정적이 된다. 재시도·중복 요청도 이 PK가 그대로 막는다.
-- 덤으로 (batch_id, ...) 선두 컬럼 인덱스가 생겨 "이 배치의 항목 전부" 조회가 공짜다.
CREATE TABLE IF NOT EXISTS "category_recategorize_items" (
  "batch_id" uuid NOT NULL,
  "transaction_id" uuid NOT NULL,
  -- 덮어쓰기 **직전** 값. NULL이 정상값이다 — 미분류 거래를 분류하는 것이 일괄
  -- 재분류의 가장 흔한 경우고, 되돌리면 다시 미분류(NULL)로 돌아가야 한다.
  -- "미분류였다"와 "기록을 못 남겼다"를 구분할 필요가 없으므로 여기서는 NULL 하나면 된다.
  "previous_category_id" uuid,
  CONSTRAINT "category_recategorize_items_batch_id_transaction_id_pk"
    PRIMARY KEY("batch_id","transaction_id")
);
--> statement-breakpoint

-- (3) 외래키.
--
-- 이름을 drizzle 관례(`<table>_<col>_<reftable>_<refcol>_fk`)보다 짧게 짓는 이유:
-- 관례대로면 `category_recategorize_batches_to_category_id_expense_categories_id_fk`가
-- 70자라 Postgres의 식별자 한도(63바이트)에서 **조용히 잘린다.** 잘린 이름은 나중에
-- DROP CONSTRAINT로 지목할 때 문서와 실제가 어긋나므로, 처음부터 한도 안의 이름을 쓴다.
ALTER TABLE "category_recategorize_batches"
  ADD CONSTRAINT "category_recategorize_batches_household_id_fk"
  FOREIGN KEY ("household_id") REFERENCES "public"."households"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "category_recategorize_batches"
  ADD CONSTRAINT "category_recategorize_batches_to_category_id_fk"
  FOREIGN KEY ("to_category_id") REFERENCES "public"."expense_categories"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "category_recategorize_batches"
  ADD CONSTRAINT "category_recategorize_batches_applied_by_fk"
  FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "category_recategorize_batches"
  ADD CONSTRAINT "category_recategorize_batches_reverted_by_fk"
  FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- 배치가 사라지면 그 항목은 가리킬 곳이 없다. 고아 항목은 존재하지 않는 사건의
-- 이전 값을 계속 주장하므로 함께 지운다.
ALTER TABLE "category_recategorize_items"
  ADD CONSTRAINT "category_recategorize_items_batch_id_fk"
  FOREIGN KEY ("batch_id") REFERENCES "public"."category_recategorize_batches"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- 거래가 지워지면 되돌릴 대상 자체가 없다. no action으로 두면 이 원장이 거래 삭제를
-- 영구히 막아 사용자에게는 "왜 삭제가 안 되지"로 보인다(0053 evidence와 같은 판단).
ALTER TABLE "category_recategorize_items"
  ADD CONSTRAINT "category_recategorize_items_transaction_id_fk"
  FOREIGN KEY ("transaction_id") REFERENCES "public"."card_transactions"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- 이전 카테고리는 no action이다 — 되돌릴 목적지가 조용히 사라지면 되돌리기가 거짓말이
-- 된다. `card_transactions.category_id`도 같은 정책이라 새로 막는 것은 없다.
ALTER TABLE "category_recategorize_items"
  ADD CONSTRAINT "category_recategorize_items_previous_category_id_fk"
  FOREIGN KEY ("previous_category_id") REFERENCES "public"."expense_categories"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- (4) 정합 CHECK. 새 테이블이라 기존 행이 없어 즉시 검증돼도 안전하다.
ALTER TABLE "category_recategorize_batches"
  ADD CONSTRAINT "category_recategorize_batches_applied_count_check"
  CHECK ("applied_count" >= 0);
--> statement-breakpoint

-- 되돌리기 3종은 **한 UPDATE에서 함께** 써야 한다. 반쯤 채워진 행(시각은 있는데 건수가
-- NULL)은 "되돌렸는가?"에 답할 수 없고, 그 애매함이 그대로 화면에 나간다.
--
-- 두 번째 가지에 `IS NOT NULL`을 일일이 적은 이유: CHECK는 NULL을 통과시킨다. 그냥
-- `"reverted_count" >= 0`만 쓰면 건수가 NULL일 때 그 가지가 FALSE가 아니라 NULL이 되고,
-- `FALSE OR NULL` = NULL이라 **막고 싶던 반쪽 행이 그대로 들어온다.**
ALTER TABLE "category_recategorize_batches"
  ADD CONSTRAINT "category_recategorize_batches_revert_completeness_check"
  CHECK (
    ("reverted_at" IS NULL AND "reverted_by" IS NULL AND "reverted_count" IS NULL)
    OR (
      "reverted_at" IS NOT NULL
      AND "reverted_by" IS NOT NULL
      AND "reverted_count" IS NOT NULL
      AND "reverted_count" >= 0
    )
  );
--> statement-breakpoint

-- (5) 인덱스.
--
-- 화면이 묻는 것은 "이 가족이 최근에 무엇을 일괄 재분류했나"다(되돌리기 UI의 목록).
CREATE INDEX IF NOT EXISTS "category_recategorize_batches_household_applied_at_idx"
  ON "category_recategorize_batches" USING btree ("household_id", "applied_at" DESC);
--> statement-breakpoint

-- 역방향 조회: "이 거래는 어느 배치가 건드렸나". 거래 상세에서 출처를 설명할 때와,
-- 나중 배치가 앞선 배치의 결과를 다시 덮어쓴 경우를 판별할 때 쓴다.
CREATE INDEX IF NOT EXISTS "category_recategorize_items_transaction_id_idx"
  ON "category_recategorize_items" USING btree ("transaction_id");
