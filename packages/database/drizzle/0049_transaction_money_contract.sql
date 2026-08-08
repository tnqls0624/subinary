-- ADR-0027 금액 계약: 역사 환율 스냅샷 · 원통화 취소 누계 · 계약 버전 · 수리 로그.
--
-- **이 마이그레이션은 추가만 한다.** 기존 행을 바꾸거나 지우지 않고, 새 컬럼은 전부
-- NULL 또는 v1 기본값으로 들어간다. 적용 후에도 사용자에게 보이는 금액은 1원도
-- 달라지지 않아야 한다 — 달라졌다면 그건 이 마이그레이션의 버그다.
--
-- v2 금액 계약을 실제로 강제하는 CHECK는 (6)에서 **NOT VALID**로만 붙인다. 기존 행은
-- 전부 v1이고 그중 일부는 이미 계약을 어기고 있으므로(ADR-0027 D-1~D-3), 지금 검증하면
-- 배포가 그 자리에서 멈춘다. VALIDATE는 데이터 수리가 끝난 뒤 `0050`이 한다.
--
-- 외부 환율 API를 여기서 호출하지 않는다. ADR-0027이 명시적으로 금지한다 —
-- 마이그레이션이 네트워크에 의존하면 재현도 롤백도 불가능해진다. 스냅샷 채우기는
-- 중단·재개 가능한 별도 복구 작업의 몫이다.
--
-- ⚠️ 적용 전 아래 조회 결과를 **먼저 저장해 두십시오**. 수리 dry-run의 모집단이자
--    "적용해도 동작이 안 바뀌었다"를 나중에 증명할 유일한 기준값입니다.
--
--   -- (a) D-3: 저장 통화가 KRW가 아닌 행(수동 입력·사람 검토가 KRW 저장 계약을 우회)
--   SELECT household_id, currency, count(*), sum(net_amount)
--   FROM card_transactions WHERE currency <> 'KRW' GROUP BY 1, 2;
--
--   -- (b) D-1: 외화 원본이 있는 행(승격일 환율로 환산된 재계산 대상)
--   SELECT count(*) AS total,
--          count(*) FILTER (WHERE exchange_rate IS NULL) AS missing_rate
--   FROM card_transactions WHERE original_currency IS NOT NULL;
--
--   -- (c) D-2: 부모에 연결되지 않은 취소 행(승인을 상계하지 못하고 떠 있는 취소)
--   SELECT count(*) FROM card_transactions
--   WHERE transaction_type = 'cancellation' AND parent_transaction_id IS NULL;
--
--   -- (d) 0050이 VALIDATE하기 전 반드시 0이 되어야 하는 승인 합 위반 건수
--   SELECT count(*) FROM card_transactions
--   WHERE transaction_type = 'approval' AND amount <> cancelled_amount + net_amount;
--
--   -- (e) ADR-0026 무회귀 기준값(수리 전후 delta를 설명할 기준선)
--   SELECT date_trunc('month', coalesce(approved_at, created_at)) AS month,
--          count(*), sum(net_amount)
--   FROM card_transactions
--   WHERE transaction_type = 'approval' AND excluded_at IS NULL AND currency = 'KRW'
--   GROUP BY 1 ORDER BY 1;
--
-- 되돌리는 법: 추가형이므로 **코드만 롤백해도 안전하다**(이전 바이너리는 새 컬럼을
-- 그냥 무시하고, money_contract_version 기본값이 v1이라 새로 들어온 행도 v1로 남는다).
-- 스키마까지 되돌려야 한다면:
--   ALTER TABLE "card_transactions"
--     DROP CONSTRAINT IF EXISTS "card_transactions_v2_currency_krw_check",
--     DROP CONSTRAINT IF EXISTS "card_transactions_v2_original_pair_check",
--     DROP CONSTRAINT IF EXISTS "card_transactions_v2_fx_snapshot_check",
--     DROP CONSTRAINT IF EXISTS "card_transactions_v2_original_cancelled_check",
--     DROP CONSTRAINT IF EXISTS "card_transactions_v2_approval_sum_check",
--     DROP CONSTRAINT IF EXISTS "card_transactions_v2_cancellation_net_zero_check",
--     DROP CONSTRAINT IF EXISTS "card_transactions_original_cancelled_amount_check",
--     DROP CONSTRAINT IF EXISTS "card_transactions_money_contract_version_check",
--     DROP COLUMN IF EXISTS "money_contract_version",
--     DROP COLUMN IF EXISTS "fx_rate_snapshot_id",
--     DROP COLUMN IF EXISTS "original_cancelled_amount";
--   DROP TRIGGER IF EXISTS "fx_rate_snapshots_immutable" ON "fx_rate_snapshots";
--   DROP FUNCTION IF EXISTS "fx_rate_snapshots_reject_mutation"();
--   DROP TABLE IF EXISTS "transaction_money_repair_log";
--   DROP TABLE IF EXISTS "fx_rate_snapshots";
--
-- 단, **수리 배치를 한 번이라도 돌린 뒤라면 fx_rate_snapshots와
-- transaction_money_repair_log는 남겨 두십시오.** ADR-0027 §되돌림이 명시한다 —
-- 이 둘을 지우면 무엇이 어떻게 바뀌었는지 되살릴 근거가 사라진다.

-- (1) 역사 환율 스냅샷 — (원통화, 기준일, 계약 버전)당 첫 성공 값을 영구 고정한다.
--
-- 왜 테이블인가: 지금 `getRateToKrw(currency)`는 거래일을 받지 않고 `new Date()`의 서울
-- 날짜를 캐시 키로 쓴다(ADR-0027 D-1). 그래서 같은 이벤트를 **언제 재시도하느냐가 KRW
-- 금액을 바꾸고**, 승인과 취소가 서로 다른 날 환율로 환산돼 전액취소가 상계되지 않는다
-- (USD 100 승인 @1,300 = 130,000원, 같은 건의 전액취소 @1,400 = 140,000원 → 후보 조건
-- 탈락 → 130,000원이 지출로 남는다). 기준일을 명령 입력으로 받고 그 날짜 값을 한 번만
-- 고정해 두면 재시도가 결과를 바꾸지 못한다.
--
-- rate 단위는 **원통화 1 major unit당 KRW**이고 numeric(24,12)이다. double precision을
-- 쓰지 않는 이유: 이진 부동소수는 십진 환율을 정확히 담지 못해 같은 입력이 실행 환경에
-- 따라 1원 차이를 낼 수 있다. 금액 산술은 이 고정 소수를 정수 스케일로 올려서 한다
-- (KRW = minor units × 10^12스케일환율 / (10^ISO지수 × 10^12), ROUND_HALF_UP).
--
-- as_of_date가 timestamptz가 아니라 date인 이유: 기준일은 "서울의 그 날"이지 순간이
-- 아니다. timestamptz로 두면 읽는 쪽 타임존에 따라 하루가 밀린다.
--
-- money_contract_version에 기본값을 두지 않는 이유: 공급자 오류로 잘못 고정된 스냅샷은
-- **행을 고치지 않고** 새 계약 버전의 정정 스냅샷을 만든다(ADR-0027 §3). 어느 계약에
-- 속하는 값인지는 호출자가 매번 명시해야 하고, 기본값이 있으면 그 판단이 조용히 생략된다.
--
-- 통화 지수(ISO 4217 exponent)를 여기 두지 않는 이유: 지수는 코드의 단일 ISO 매핑에서만
-- 가져온다(ADR-0027 §3). 스냅샷에도 두면 진실의 출처가 둘이 되고, 둘이 어긋나는 순간
-- 어느 쪽이 맞는지 판단할 수 없다.
CREATE TABLE "fx_rate_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text DEFAULT 'KRW' NOT NULL,
	"as_of_date" date NOT NULL,
	"rate" numeric(24, 12) NOT NULL,
	"provider" text NOT NULL,
	"provider_version" text NOT NULL,
	"provider_reference" text,
	"money_contract_version" integer NOT NULL,
	"note" text,
	"created_by" uuid,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rate_snapshots_natural_key_unique" UNIQUE("base_currency","quote_currency","as_of_date","money_contract_version"),
	CONSTRAINT "fx_rate_snapshots_rate_positive_check" CHECK ("fx_rate_snapshots"."rate" > 0),
	CONSTRAINT "fx_rate_snapshots_currency_format_check" CHECK ("fx_rate_snapshots"."base_currency" ~ '^[A-Z]{3}$' and "fx_rate_snapshots"."quote_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "fx_rate_snapshots_quote_krw_check" CHECK ("fx_rate_snapshots"."quote_currency" = 'KRW'),
	CONSTRAINT "fx_rate_snapshots_base_not_quote_check" CHECK ("fx_rate_snapshots"."base_currency" <> "fx_rate_snapshots"."quote_currency"),
	CONSTRAINT "fx_rate_snapshots_contract_version_check" CHECK ("fx_rate_snapshots"."money_contract_version" >= 2)
);
--> statement-breakpoint

-- quote_currency 컬럼을 두면서 'KRW'로 못 박은 이유: 이 제품의 환산 대상은 KRW뿐이고
-- 금액 산술 함수도 KRW를 가정한다. 컬럼 없이 암묵적으로 두면 나중에 다통화 기준통화를
-- 넣을 때 자연키가 통째로 바뀐다. 반대로 제약 없이 두면 KRW가 아닌 행이 조용히 들어와
-- 산술이 틀린다. 다통화 기준통화가 실제로 필요해지면 이 CHECK 하나만 DROP한다.

ALTER TABLE "fx_rate_snapshots" ADD CONSTRAINT "fx_rate_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- (2) 스냅샷 불변성을 DB가 강제한다.
--
-- 왜 트리거까지 거는가: ADR-0027 §1이 "런타임 규약을 코드 리뷰 기억에만 맡기지 않는다"고
-- 정한 그 규약 중 하나다. 잘못된 환율을 나중에 UPDATE로 고치면 **과거 재시도가 다른 값을
-- 내놓게 되고**, 그 순간 이 테이블의 존재 이유(재시도 재현성)가 사라진다. 정정은 새 계약
-- 버전의 새 행으로 한다.
--
-- 새 테이블이라 기존 행이 없으므로 v2 CHECK와 달리 지금 바로 강제해도 배포가 막히지 않는다.
--
-- TRUNCATE는 막지 않는다(FOR EACH ROW 트리거는 TRUNCATE에 걸리지 않는다) — 테스트
-- 픽스처 정리를 위해 일부러 남겨 둔 문이다. 운영에서 TRUNCATE를 쓸 일은 없다.
--
-- ⚠️ 스냅샷 채우기는 `ON CONFLICT DO UPDATE`가 아니라 **`ON CONFLICT DO NOTHING` 후
--    SELECT**로 하십시오. DO UPDATE는 UPDATE라 이 트리거에 걸립니다. 그게 맞는 의미이기도
--    합니다 — "첫 성공 값을 고정하고 모든 재시도가 같은 행을 참조한다"(ADR-0027 §3).
CREATE FUNCTION "fx_rate_snapshots_reject_mutation"() RETURNS trigger AS $fx_immutable$
BEGIN
  RAISE EXCEPTION
    'fx_rate_snapshots is immutable (ADR-0027 §3): % rejected for (% -> %, %, contract v%). Insert a corrected snapshot under a new money_contract_version instead.',
    TG_OP, OLD."base_currency", OLD."quote_currency", OLD."as_of_date", OLD."money_contract_version";
END;
$fx_immutable$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "fx_rate_snapshots_immutable"
  BEFORE UPDATE OR DELETE ON "fx_rate_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "fx_rate_snapshots_reject_mutation"();
--> statement-breakpoint

-- (3) card_transactions 추가 컬럼 세 개. 전부 NULL 또는 v1 기본값으로 들어간다.
--
-- original_cancelled_amount: 원통화 기준 취소 누계(ADR-0027 §4). 지금은 취소 후보를
-- **환산된 KRW 잔액**으로 비교하는데, 승인과 취소가 다른 날 환율을 쓰면 같은 원통화
-- 전액취소가 잔액 비교에서 탈락한다. 원통화 잔액(original_amount -
-- original_cancelled_amount)으로 비교해야 환율 방향과 무관하게 연결된다.
-- KRW 거래는 NULL이다 — 기존 amount - cancelled_amount가 이미 원통화 잔액이다.
--
-- fx_rate_snapshot_id: 이 거래가 어느 스냅샷으로 환산됐는지. 연결된 외화 취소는 취소일
-- 환율이 아니라 **승인에 저장된 이 스냅샷**을 재사용한다(ADR-0027 §4). 부모를 따라가야
-- 하는 값을 자식이 다시 조회하면 그 순간 두 날짜의 환율이 섞인다.
--
-- money_contract_version: 기본값 1(v1). 새 컬럼을 붙여도 기존 행은 전부 v1로 남고,
-- 새 서비스만 v2를 **명시적으로** 쓴다. 롤백 창 동안 이전 바이너리로 돌아가도 조건부 v2
-- 제약과 충돌하지 않는 이유가 이 기본값이다(ADR-0027 §5).
-- PG11+의 fast default라 테이블 재작성 없이 붙는다.
ALTER TABLE "card_transactions" ADD COLUMN "original_cancelled_amount" integer;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD COLUMN "fx_rate_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD COLUMN "money_contract_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_fx_rate_snapshot_id_fx_rate_snapshots_id_fk" FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "public"."fx_rate_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "card_transactions_fx_rate_snapshot_id_idx" ON "card_transactions" USING btree ("fx_rate_snapshot_id");--> statement-breakpoint

-- (4) 새 컬럼 자체의 정합성만 보는 CHECK — 여기는 NOT VALID가 아니다.
--
-- 왜 이 둘만 즉시 검증하는가: 기존 행의 original_cancelled_amount는 전부 NULL이고
-- money_contract_version은 전부 1이므로 **어떤 기존 행도 위반할 수 없다**. 검증 스캔이
-- 실패할 여지가 없는 제약을 굳이 NOT VALID로 미루면, 0050에서 진짜 v2 제약과 섞여
-- "무엇이 아직 검증 안 됐는지"가 흐려진다.
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_original_cancelled_amount_check" CHECK ("card_transactions"."original_cancelled_amount" is null or "card_transactions"."original_cancelled_amount" >= 0);--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_money_contract_version_check" CHECK ("card_transactions"."money_contract_version" >= 1);--> statement-breakpoint

-- (5) 금액 수리 로그 — 무엇을 왜 바꿨고 어떻게 되돌리는지의 유일한 근거.
--
-- transaction_id에 FK를 걸지 않는다. 광고 문자가 거래로 승격된 D-4 행은 사람이 비거래로
-- 확정하면 **제거**될 수 있는데(ADR-0027 §데이터 마이그레이션 계획 §3), FK가 있으면
-- 그 제거가 막히거나(NO ACTION) 로그가 함께 지워진다(CASCADE). 둘 다 최악이다 —
-- 감사 로그는 감사 대상보다 오래 살아야 한다. source_event_id도 같은 이유로 FK가 없다.
-- household_id만 FK를 둔다(가구가 지워지려면 어차피 거래부터 지워야 한다).
--
-- before_money/after_money가 jsonb인 이유: 보호 컬럼이 12개(amount, currency,
-- original_amount, original_currency, exchange_rate, fx_rate_snapshot_id,
-- cancelled_amount, original_cancelled_amount, net_amount, parent_transaction_id,
-- status, money_contract_version)라 스칼라로 펼치면 24개가 된다. 대신 ADR-0026 무회귀
-- 대조에 실제로 쓰이는 net_amount와 currency만 별도 컬럼으로 승격했다.
--
-- net_amount_delta를 생성 컬럼으로 두는 이유: ADR-0027 회귀 기준이 "수리 전후 월 합계
-- 차이 = 수리 로그의 행별 delta 합"이다. 이 값을 조회할 때마다 손으로 계산하면 조회마다
-- 다른 식이 생기고, 그러면 "설명되지 않는 delta 0건"을 증명할 수 없다.
-- 제거(action='delete')는 after가 NULL이라 delta가 -before가 된다 — 의도한 부호다.
--
-- checksum이 둘인 이유: before는 **적용 직전** 대상 행을 다시 읽어 manifest가 낡지
-- 않았는지 보는 값이고(그 사이 새 거래·사용자 수정이 끼어들 수 있다), after는 **되돌릴
-- 때** 사용자가 그 뒤로 이 거래를 손댔는지 보는 값이다. 하나로 합치면 둘 중 하나를 못 본다.
--
-- ⚠️ 이 테이블은 금액과 (restore_image를 통해) 가맹점명을 담는다. 운영 로그·관측
-- 싱크로 내보내지 마십시오. ADR-0027은 운영 로그에는 집계 수치만 쓰라고 정한다.
CREATE TABLE "transaction_money_repair_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"source_event_id" uuid,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"before_money" jsonb NOT NULL,
	"after_money" jsonb,
	"net_amount_before" integer,
	"net_amount_after" integer,
	"currency_before" text,
	"currency_after" text,
	"net_amount_delta" integer GENERATED ALWAYS AS (coalesce("net_amount_after", 0) - coalesce("net_amount_before", 0)) STORED,
	"checksum_before" text NOT NULL,
	"checksum_after" text,
	"restore_image" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"revert_blocked_reason" text,
	CONSTRAINT "transaction_money_repair_log_batch_transaction_unique" UNIQUE("batch_id","transaction_id"),
	CONSTRAINT "transaction_money_repair_log_action_check" CHECK ("transaction_money_repair_log"."action" in ('recalculate_chain', 'normalize_currency', 'link_cancellation', 'unlink_cancellation', 'delete')),
	CONSTRAINT "transaction_money_repair_log_lifecycle_check" CHECK (("transaction_money_repair_log"."applied_at" is null and "transaction_money_repair_log"."checksum_after" is null and "transaction_money_repair_log"."reverted_at" is null) or ("transaction_money_repair_log"."applied_at" is not null and "transaction_money_repair_log"."action" = 'delete' and "transaction_money_repair_log"."checksum_after" is null and "transaction_money_repair_log"."restore_image" is not null) or ("transaction_money_repair_log"."applied_at" is not null and "transaction_money_repair_log"."action" <> 'delete' and "transaction_money_repair_log"."checksum_after" is not null))
);
--> statement-breakpoint

ALTER TABLE "transaction_money_repair_log" ADD CONSTRAINT "transaction_money_repair_log_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_money_repair_log" ADD CONSTRAINT "transaction_money_repair_log_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "transaction_money_repair_log_batch_id_idx" ON "transaction_money_repair_log" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "transaction_money_repair_log_transaction_id_idx" ON "transaction_money_repair_log" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_money_repair_log_household_id_created_at_idx" ON "transaction_money_repair_log" USING btree ("household_id","created_at");--> statement-breakpoint

-- (6) v2 금액 계약 불변식 — **NOT VALID**. 새로 들어오거나 수정되는 행만 검사한다.
--
-- 왜 NOT VALID인가: 기존 행은 전부 v1이고 그중 일부는 이미 이 불변식을 어기고 있다
-- (D-3의 currency='USD' 행, D-2의 상계되지 않은 승인). 지금 VALIDATE하면 그 행들 때문에
-- ALTER가 실패해 배포가 통째로 멈춘다. NOT VALID는 **기존 행 검증만 건너뛰고 이후의
-- INSERT/UPDATE에는 그대로 걸린다** — 즉 지금부터 잘못된 v2 행이 새로 생기는 것은 막힌다.
-- 기존 행 검증(VALIDATE CONSTRAINT)은 데이터 수리가 끝난 뒤 0050이 한다.
--
-- 모든 조건이 `money_contract_version < 2 or ...` 로 시작하는 이유: v1 행은 v2 계약의
-- 적용 대상이 아니다. 이 가드가 없으면 롤백 창에서 이전 바이너리가 만든 v1 행이 거부된다.
--
-- 제약을 여섯 개로 쪼갠 이유: 하나의 거대한 CHECK는 위반했을 때 **무엇을 어겼는지**
-- 알려주지 않는다. 이름이 곧 위반 사유가 되게 나눈다.

-- v2-1. 저장 통화는 항상 KRW. 외화는 환산해서 넣고 원통화는 original_* 에 병기한다
--       (D-3: 수동/검토 경로가 USD를 그대로 넣어 화면마다 금액 의미가 달랐다).
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_v2_currency_krw_check" CHECK ("card_transactions"."money_contract_version" < 2 or "card_transactions"."currency" = 'KRW') NOT VALID;--> statement-breakpoint

-- v2-2. original_amount와 original_currency는 함께 있거나 함께 없다.
--       한쪽만 있으면 "얼마인지는 아는데 무슨 돈인지 모르는" 행이 된다.
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_v2_original_pair_check" CHECK ("card_transactions"."money_contract_version" < 2 or (("card_transactions"."original_amount" is null) = ("card_transactions"."original_currency" is null))) NOT VALID;--> statement-breakpoint

-- v2-3. 외화 원본이면 환율 스냅샷이 반드시 있다. 스냅샷 없이 환산된 KRW는 어느 날짜
--       환율로 만들어졌는지 증명할 수 없고, 재계산도 되돌림도 불가능하다.
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_v2_fx_snapshot_check" CHECK ("card_transactions"."money_contract_version" < 2 or "card_transactions"."original_currency" is null or "card_transactions"."fx_rate_snapshot_id" is not null) NOT VALID;--> statement-breakpoint

-- v2-4. 외화 **승인**은 원통화 취소 누계를 가지며 원금액을 넘지 않는다.
--       취소 행에는 요구하지 않는다 — 취소가 취소되는 개념은 없다.
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_v2_original_cancelled_check" CHECK ("card_transactions"."money_contract_version" < 2 or "card_transactions"."transaction_type" <> 'approval' or "card_transactions"."original_currency" is null or ("card_transactions"."original_cancelled_amount" is not null and "card_transactions"."original_cancelled_amount" <= "card_transactions"."original_amount")) NOT VALID;--> statement-breakpoint

-- v2-5. 승인 순액 항등식(ADR-0009부터의 규약). 지출 합계는 승인 net_amount의 합이므로
--       이 식이 깨지면 총액이 조용히 틀린다.
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_v2_approval_sum_check" CHECK ("card_transactions"."money_contract_version" < 2 or "card_transactions"."transaction_type" <> 'approval' or "card_transactions"."amount" = "card_transactions"."cancelled_amount" + "card_transactions"."net_amount") NOT VALID;--> statement-breakpoint

-- v2-6. 취소 행의 순액은 0. 취소는 승인 쪽 순액을 줄여서 반영하고, 자기 자신은 이력이다.
--       0이 아니면 같은 취소가 두 번 계상된다.
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_v2_cancellation_net_zero_check" CHECK ("card_transactions"."money_contract_version" < 2 or "card_transactions"."transaction_type" <> 'cancellation' or "card_transactions"."net_amount" = 0) NOT VALID;
