-- Slack import의 관찰 가능한 상태 — C-6 업로드를 열기 위한 최소 계약.
--
-- 왜 필요한가: 지금 `POST /v1/slack/import`는 **항상 `queued`만** 돌려주고
-- (`packages/contracts/src/slack.ts`), `importId`는 `source_items.id`인데 그 테이블에
-- 상태 컬럼이 없다. 그래서 HTTP 200을 받은 뒤 워커에서 실패해도 **사용자는 이유를
-- 영영 알 수 없다.** ZIP 업로드를 열면 실패 종류가 늘어나므로(경로 탈출·폭탄·구조
-- 불일치) 이 구멍을 먼저 메워야 한다. PO 판정 Q3-4의 선행 조건이다.
--
-- 왜 `source_items`에 컬럼을 붙이지 않는가: 그 테이블은 카드 문자(`card_sms`)와
-- 공유한다. Slack 전용 상태·건수를 거기 넣으면 카드 경로가 영원히 NULL인 컬럼을
-- 들고 다니고, 다음 소스 종류마다 컬럼이 또 는다. 종류별 상태는 종류별 테이블에 둔다.
--
-- 왜 BullMQ 잡 상태를 쓰지 않는가: 잡은 `removeOnComplete: { count: 1_000 }`로 사라진다
-- (`apps/worker/src/outbox/outbox-dispatcher.service.ts`). 새로고침·앱 재시작 뒤에도
-- 복구돼야 하는 상태를 휘발성 큐에 두면 "성공했는지조차 모르는" 상태로 돌아간다.
--
-- 전부 가산적(additive)이다. 기존 테이블·컬럼·데이터를 하나도 건드리지 않으므로
-- 롤백은 테이블 1개와 enum 2개를 드롭하는 것으로 끝난다.
--
-- 적용 전 참고 조회(영향 범위 없음을 확인하는 용도):
--   SELECT to_regclass('public.slack_imports');            -- NULL 이어야 한다
--   SELECT count(*) FROM pg_type WHERE typname IN
--     ('slack_import_status', 'slack_import_format');      -- 0 이어야 한다

-- (1) 상태 어휘. 4개로 닫혀 있다(PO 판정 Q3-4가 지정한 그대로).
--
-- `queued`  : API가 수락하고 outbox에 실었다. 아직 워커가 잡지 않았다.
-- `processing`: 워커가 잡았다. 재시도로 여러 번 들어올 수 있다(attempt로 구분).
-- `completed`: 정규화까지 끝났다. 건수가 채워진다.
-- `failed`  : 더 시도하지 않는다. `error_code`가 이유를 담는다.
CREATE TYPE "public"."slack_import_status" AS ENUM (
  'queued',
  'processing',
  'completed',
  'failed'
);
--> statement-breakpoint

-- (2) 업로드 형식. 기존 단일 JSON 번들 경로를 깨지 않기 위해 **둘 다** 유지한다 —
--     고급 사용자·스크립트가 이미 JSON을 올리고 있을 수 있다(ADR-0011 §1).
CREATE TYPE "public"."slack_import_format" AS ENUM ('json', 'zip');
--> statement-breakpoint

-- (3) import 1건의 상태.
--
-- 신원은 `source_item_id`다 — API가 응답으로 돌려주는 `importId`가 곧 그 값이라
-- 사용자가 들고 있는 유일한 손잡이다. UNIQUE로 두어 재시도가 행을 늘리지 않게 한다.
--
-- ⚠️ **`error_code`에 원문·경로·PII를 넣지 마십시오.** 이 저장소의 로깅 규약이고
-- (`apps/api/src/slack/slack.service.ts` 상단 주석), 이 값은 그대로 사용자 화면까지
-- 간다. 코드와 숫자만 남긴다. 자유 텍스트를 담을 컬럼을 **일부러 만들지 않았다.**
CREATE TABLE IF NOT EXISTS "slack_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_item_id" uuid NOT NULL,
  "slack_workspace_id" uuid NOT NULL,
  "status" "slack_import_status" DEFAULT 'queued' NOT NULL,
  "format" "slack_import_format" NOT NULL,
  "sync_mode" text NOT NULL,
  -- 업로드된 압축 파일의 크기. 해제 후 크기는 completed일 때만 알 수 있다.
  "upload_bytes" integer DEFAULT 0 NOT NULL,
  -- 안전한 실패 코드(자유 텍스트 아님). 성공하면 NULL로 되돌린다.
  "error_code" text,
  -- 워커 재시도 횟수. 같은 import가 processing으로 여러 번 들어올 수 있다.
  "attempt" integer DEFAULT 0 NOT NULL,
  -- 처리 건수. completed 전에는 NULL이다("아직 모른다"와 "0건"은 다른 사실이다).
  "channel_count" integer,
  "user_count" integer,
  "message_count" integer,
  "created_message_count" integer,
  "updated_message_count" integer,
  "deleted_message_count" integer,
  "skipped_message_count" integer,
  "warning_count" integer,
  "queued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "slack_imports_source_item_id_unique" UNIQUE("source_item_id")
);
--> statement-breakpoint

ALTER TABLE "slack_imports"
  ADD CONSTRAINT "slack_imports_source_item_id_source_items_id_fk"
  FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "slack_imports"
  ADD CONSTRAINT "slack_imports_slack_workspace_id_slack_workspaces_id_fk"
  FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- 워크스페이스별 최근 import 조회(화면이 "마지막 가져오기가 어떻게 됐나"를 묻는다).
CREATE INDEX IF NOT EXISTS "slack_imports_workspace_queued_at_idx"
  ON "slack_imports" USING btree ("slack_workspace_id", "queued_at" DESC);
--> statement-breakpoint

-- 오래 갇힌 import를 찾는 운영 조회(queued인 채로 남은 것 = outbox가 막혔다는 신호).
CREATE INDEX IF NOT EXISTS "slack_imports_status_queued_at_idx"
  ON "slack_imports" USING btree ("status", "queued_at");
