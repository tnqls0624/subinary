-- 동의를 "철회할 수 있는 것"으로 만든다 (C-3 1단계).
--
-- 왜 필요한가: household_consents는 지금 append-only로 쌓이기만 하고 **취소를 표현할
-- 컬럼이 없다.** 그래서 화면이 없는 게 아니라 모델이 철회를 담지 못한다 — 철회 버튼을
-- 붙이려면 이 마이그레이션이 먼저다.
--
-- 전부 가산적(additive)이다. 기존 행을 지우지 않고, 기존 컬럼의 의미도 바꾸지 않는다.
--
-- ⚠️ 적용 전 아래 조회로 영향 범위를 **먼저 저장해 두십시오**:
--   -- (a) 타입·버전별 분포. (3)의 버전 레지스트리 검사가 무엇을 볼지 미리 안다.
--   SELECT consent_type, consent_version, count(*)
--   FROM household_consents GROUP BY 1, 2 ORDER BY 1, 2;
--
--   -- (b) 한 사람이 같은 가구에 남긴 동의 행 수(나갔다 재합류하면 2행 이상이 정상).
--   SELECT household_id, user_id, consent_type, count(*)
--   FROM household_consents GROUP BY 1, 2, 3 HAVING count(*) > 1;
--
--   -- (c) 이 마이그레이션이 'granted'로 백필할 총 행수.
--   SELECT count(*) FROM household_consents;

-- (1) 상태 전이 컬럼.
--
-- 기존 행에 어떤 상태를 부여하는가 — **전부 'granted'**.
-- 근거: 이 테이블에 들어간 행은 단 두 경로(가구 생성, 초대 수락)에서만 만들어지고,
-- 두 경로 모두 사용자가 실제로 동의를 표시했을 때만 insert한다(acceptInvitation은
-- consent !== true를 400으로 막는다). 즉 **모든 기존 행은 동의 사건 그 자체**이고,
-- 'granted'는 새 의미를 부여하는 게 아니라 이미 참인 사실을 컬럼으로 옮겨 적는 것이다.
-- 반대로 'revoked'나 NULL로 두면 "동의한 적 없는 사용자"가 되어 기존 사용자가 갑자기
-- 수집이 끊긴다 — 그쪽이야말로 의미를 바꾸는 선택이다.
--
-- 문구 개정(v1 → v2)은 여기서 처리하지 않는다. 개정은 "재동의 요청"이지 "동의 취소"가
-- 아니므로, 상태는 granted로 두고 애플리케이션이 현재 버전과 비교해 안내만 한다.
ALTER TABLE "household_consents" ADD COLUMN "status" text DEFAULT 'granted' NOT NULL;
--> statement-breakpoint
ALTER TABLE "household_consents" ADD COLUMN "revoked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "household_consents" ADD COLUMN "revoked_reason" text;
--> statement-breakpoint

-- (2) 상태 어휘와 status↔revoked_at 정합을 DB가 강제한다.
--
-- 두 번째 CHECK가 막는 것: "철회했다는데 언제 철회했는지 모르는 행". 개인정보 동의에서
-- 그 행은 증빙이 되지 못하므로 애플리케이션 버그로 생기지 않게 DB에서 잘라 둔다.
ALTER TABLE "household_consents"
  ADD CONSTRAINT "household_consents_status_check"
  CHECK ("status" in ('granted', 'revoked'));
--> statement-breakpoint
ALTER TABLE "household_consents"
  ADD CONSTRAINT "household_consents_revoked_at_check"
  CHECK (("status" = 'revoked') = ("revoked_at" is not null));
--> statement-breakpoint

-- (3) 코드에 원문이 없는 동의 버전이 DB에 있으면 **멈춘다**(0048과 같은 태도).
--
-- 왜 실패시키는가: 이 작업의 계약은 "DB에는 버전 문자열만 남기고 사용자가 실제로 읽은
-- 문구는 코드(@family/contracts의 householdConsentDocuments)에서 되짚을 수 있다"는
-- 것이다. 레지스트리에 없는 버전이 한 행이라도 있으면 그 사용자에 대해서는 "무엇에
-- 동의했는가"를 영영 말할 수 없다 — 개인정보 화면이 조용히 거짓말을 하게 된다.
-- 어느 문구였는지는 데이터만 보고 추측할 수 없으므로 사람이 결정하게 둔다.
--
-- 수동 정리 방법(걸렸을 때만):
--   1) 그 버전의 문구 원문을 찾아 contracts의 householdConsentDocuments에 등록하고
--      이 목록에 버전 문자열을 추가한 뒤 다시 실행한다. (원칙적 해법)
--   2) 원문을 끝내 못 찾으면, 해당 사용자에게 현재 버전으로 재동의를 받는 편이 낫다.
DO $$
DECLARE
  unknown_versions text;
BEGIN
  SELECT string_agg(DISTINCT consent_version, ', ')
  INTO unknown_versions
  FROM household_consents
  WHERE consent_version NOT IN ('v1', 'v2');

  IF unknown_versions IS NOT NULL THEN
    RAISE EXCEPTION
      'household_consents: consent_version without a document in code (%). Register the wording in @family/contracts householdConsentDocuments before applying.',
      unknown_versions;
  END IF;
END $$;
--> statement-breakpoint

-- (4) 조회 인덱스.
--
-- 지금까지 이 테이블에는 PK 외에 인덱스가 없었다 — 쓰기만 했고 읽은 적이 없기 때문이다.
-- Control Center가 "이 가구에서 내 최신 동의"를 매 화면 조회하므로 붙인다.
--
-- 부분 유니크(가구·사용자·타입당 granted 1행)는 **일부러 걸지 않는다**: 나갔다가 다시
-- 합류하면 서로 다른 시점의 정당한 동의 행이 여러 개 생기고, 인덱스를 붙이려면 그
-- 이력을 사람이 지워야 한다. "동의 이력을 지워야 제약이 붙는다"는 이 작업의 목적과
-- 정면으로 충돌한다. 대신 애플리케이션이 철회 시 살아있는 granted 행을 **전부** 전이시켜
-- 잔여 granted를 남기지 않는다.
CREATE INDEX "household_consents_scope_idx"
  ON "household_consents" ("household_id", "user_id", "consent_type");
