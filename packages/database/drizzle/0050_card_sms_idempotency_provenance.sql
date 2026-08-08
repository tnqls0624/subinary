-- P0-9 카드 문자 멱등 키 출처 기록 + 중복 판정 원문 보관.
--
-- **이 마이그레이션은 추가만 한다.** 기존 행을 바꾸거나 지우지 않고, 새 컬럼은 NULL로
-- 들어간다. 적용 후에도 사용자에게 보이는 거래·금액은 1원도 달라지지 않아야 한다 —
-- 달라졌다면 그건 이 마이그레이션의 버그다.
--
-- ## 무엇을 고치는 마이그레이션인가
--
-- 수집 계약에서 `eventId`와 `receivedAt`이 둘 다 선택값이라, 자동화(MacroDroid/단축어)가
-- 둘 다 비우면 멱등 키가 `sha256(sender+content)` **뿐**이었다. 시간 축이 전혀 없으므로
-- 서로 다른 두 결제가 바이트 단위로 같은 문자를 만들면(타임스탬프 없는 짧은 문자)
-- 두 번째가 영구히 `duplicate`로 버려졌다. **원문조차 남지 않아 복구할 근거가 없었다.**
--
-- 코드 쪽 해결은 파생 키에 서버 수신 시각 창을 섞는 것이고(창 밖이면 별개 이벤트),
-- 이 마이그레이션은 그 판단에 필요한 세 가지를 DB에 만든다:
--   (1) 어느 경로로 키가 정해졌는지(`key_source`) — 필수화 시점 판단의 유일한 근거
--   (2) 창 기반 중복 조회가 탈 인덱스 — 없으면 수집 지연이 이벤트 수에 비례해 늘어난다
--   (3) 중복으로 버려진 시도의 원문 보관소 — 오판이었을 때 되살릴 근거
--
-- ⚠️ 적용 전 아래 조회 결과를 **먼저 저장해 두십시오**. "적용해도 동작이 안 바뀌었다"를
--    나중에 증명할 기준값이자, 창 크기가 적절했는지 사후 판단할 모집단입니다.
--
--   -- (a) 이벤트 총량·장치별 분포(적용 후 새 유입 속도와 비교할 기준선)
--   SELECT count(*) AS events, count(DISTINCT device_id) AS devices,
--          min(received_at), max(received_at)
--   FROM card_sms_events;
--
--   -- (b) 이미 뭉쳐 버렸을 가능성이 있는 모집단 — 같은 (장치, 본문 지문)에 이벤트가
--   --     하나뿐인데 그 문자가 실제로는 여러 번 왔을 수 있는 건들. 이 값이 크면
--   --     과소집계의 상한이 그만큼이라는 뜻입니다(정확한 손실량은 알 수 없습니다 —
--   --     그게 이 버그의 핵심입니다).
--   SELECT count(*) FROM (
--     SELECT device_id, content_hash FROM card_sms_events
--     GROUP BY 1, 2 HAVING count(*) = 1
--   ) s;
--
--   -- (c) ADR-0026 무회귀 기준값(수집 변경이 지출 합계를 건드리지 않았음을 증명)
--   SELECT date_trunc('month', coalesce(approved_at, created_at)) AS month,
--          count(*), sum(net_amount)
--   FROM card_transactions
--   WHERE transaction_type = 'approval' AND excluded_at IS NULL AND currency = 'KRW'
--   GROUP BY 1 ORDER BY 1;
--
-- 되돌리는 법: 추가형이므로 **코드만 롤백해도 안전하다**. 이전 바이너리는 `key_source`를
-- 그냥 쓰지 않고(NULL로 남는다), 보관 테이블에도 아무것도 넣지 않는다. 이전 바이너리의
-- 옛 키 파생 규칙(`sha256(sender+content)`)으로 돌아가면 P0-9 버그도 함께 돌아온다 —
-- 그 사이 쌓인 보관 행이 무엇을 잃었는지 알려주므로 **테이블은 남겨 두십시오**.
-- 스키마까지 되돌려야 한다면:
--   DROP TABLE IF EXISTS "card_sms_ingest_suppressions";
--   DROP INDEX IF EXISTS "card_sms_events_device_id_content_hash_received_at_idx";
--   ALTER TABLE "card_sms_events"
--     DROP CONSTRAINT IF EXISTS "card_sms_events_key_source_check",
--     DROP COLUMN IF EXISTS "key_source";

-- (1) 멱등 키의 출처. NULL은 **이 마이그레이션 적용 이전 행**이다(판별 불가).
--
-- 기본값을 두지 않는 이유: 기본값으로 채우면 "옛 행은 어느 경로였는지 모른다"는 사실이
-- 사라지고, 없는 정보를 있는 것처럼 세게 된다. 필수화 판단은 **적용 이후 유입만** 보고
-- 해야 한다 — NULL이 그 경계선을 그어 준다.
-- PG11+ 의 fast default 여부와 무관하게 NULL 컬럼 추가는 테이블 재작성이 없다.
ALTER TABLE "card_sms_events" ADD COLUMN "key_source" text;--> statement-breakpoint

-- 값 집합은 코드(`CARD_SMS_KEY_SOURCES`)와 DB 양쪽에 있다. 한쪽만 바뀌면 오타 난 값이
-- 조용히 들어와 집계가 한 갈래를 통째로 놓치고, 그 상태로 "키 없는 수집이 사라졌다"고
-- 잘못 판단하게 된다. 기존 행은 전부 NULL이라 즉시 검증해도 실패할 여지가 없다.
ALTER TABLE "card_sms_events" ADD CONSTRAINT "card_sms_events_key_source_check" CHECK ("card_sms_events"."key_source" is null or "card_sms_events"."key_source" in ('client', 'derived_received_at', 'derived_window'));--> statement-breakpoint

-- (2) 창 기반 중복 판정의 조회 경로: (장치, 본문 지문, 최근 N분).
--
-- 수집 **요청마다** 타는 조회다. 인덱스가 없으면 이벤트가 쌓일수록 수집이 선형으로
-- 느려지고, 느려진 수집은 자동화 타임아웃 → 재전송 → 다시 이 조회로 이어진다.
--
-- `content_hash`가 키 형식과 무관하게 예전부터 `sha256(sender\ncontent)`로 채워져 있는
-- 것이 중요하다 — 그래서 이 조회가 **적용 이전에 옛 키로 저장된 행과도 맞물리고**,
-- 배포 직후 재전송이 중복 폭증을 만들지 않는다.
--
-- received_at을 인덱스 세 번째에 두는 이유: 앞 두 컬럼은 등치, 마지막만 범위 조건이다.
-- 순서가 바뀌면 범위 스캔이 앞서서 등치 조건이 인덱스를 못 탄다.
CREATE INDEX "card_sms_events_device_id_content_hash_received_at_idx" ON "card_sms_events" USING btree ("device_id","content_hash","received_at");--> statement-breakpoint

-- (3) 중복으로 판정해 `card_sms_events`에 넣지 않은 시도의 원문 보관소.
--
-- 왜 필요한가: 지금까지 중복 판정된 문자는 **아무 흔적도 남기지 않았다**. 나중에 그
-- 판정이 오판(= 같은 문자를 만든 별개 결제)으로 밝혀져도 복구할 근거가 없었다. 지출이
-- 조용히 과소집계되고 사용자는 이유를 알 방법이 없다. 이 테이블이 그 근거다.
--
-- 왜 `card_sms_events`에 넣지 않는가: 그 테이블의 행은 곧 거래 승격 후보다. 중복 판정된
-- 시도를 같이 넣으면 승격·집계·목록·예산·알림이 전부 이 문제를 다시 안는다. 승격 대상이
-- 아닌 원문은 승격 대상과 다른 테이블에 있어야 한다.
--
-- matched_event_id / restored_event_id에 FK를 걸지 않는다: 이벤트가 지워져도 버려진
-- 원문은 남아야 한다. NO ACTION이면 이벤트 삭제가 막히고 CASCADE면 보관이 함께 지워진다 —
-- 둘 다 최악이다. 감사 기록은 감사 대상보다 오래 살아야 한다(0049 수리 로그와 같은 판단).
-- household/member/device는 FK를 둔다(가구가 지워지려면 어차피 이벤트부터 지워야 한다).
--
-- UNIQUE(device_id, event_id, content_hash) + attempts로 접는 이유: 자동화가 공격적으로
-- 재시도하면(설정 실수·연결 플랩) 같은 시도가 수십 건 쌓인다. 보관의 목적은 "무엇이
-- 버려졌는가"이지 "몇 번 눌렀는가"의 낱개 이력이 아니다 — 횟수는 카운터로 충분하고,
-- 그래야 이 테이블이 이벤트 테이블보다 빨리 커지는 일이 없다.
--
-- ⚠️ raw_content는 카드 문자 원문(가맹점·금액·마스킹 카드번호)이다. 운영 로그·관측
--    싱크로 내보내지 마십시오. 로그에는 집계 수치만 씁니다.
CREATE TABLE "card_sms_ingest_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"key_source" text NOT NULL,
	"reason" text NOT NULL,
	"matched_event_id" uuid,
	"sender" text NOT NULL,
	"raw_content" text NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"restored_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_sms_ingest_suppressions_device_event_content_unique" UNIQUE("device_id","event_id","content_hash"),
	CONSTRAINT "card_sms_ingest_suppressions_reason_check" CHECK ("card_sms_ingest_suppressions"."reason" in ('event_id_conflict', 'fingerprint_window', 'insert_race')),
	CONSTRAINT "card_sms_ingest_suppressions_key_source_check" CHECK ("card_sms_ingest_suppressions"."key_source" in ('client', 'derived_received_at', 'derived_window')),
	CONSTRAINT "card_sms_ingest_suppressions_attempts_check" CHECK ("card_sms_ingest_suppressions"."attempts" >= 1)
);
--> statement-breakpoint

ALTER TABLE "card_sms_ingest_suppressions" ADD CONSTRAINT "card_sms_ingest_suppressions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_sms_ingest_suppressions" ADD CONSTRAINT "card_sms_ingest_suppressions_member_id_household_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_sms_ingest_suppressions" ADD CONSTRAINT "card_sms_ingest_suppressions_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 가구별 최근 보관 목록(사용자에게 "이 문자가 중복으로 접혔다"를 보여줄 때의 조회 경로).
CREATE INDEX "card_sms_ingest_suppressions_household_id_last_seen_at_idx" ON "card_sms_ingest_suppressions" USING btree ("household_id","last_seen_at");--> statement-breakpoint
-- 복구 도구가 "이 지문으로 버려진 게 무엇인가"를 찾을 때의 조회 경로.
CREATE INDEX "card_sms_ingest_suppressions_device_id_content_hash_idx" ON "card_sms_ingest_suppressions" USING btree ("device_id","content_hash");
