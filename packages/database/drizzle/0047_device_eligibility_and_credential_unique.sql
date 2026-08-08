-- 장치 수집 자격을 멤버십에 묶고, 장치당 active credential을 DB가 강제하게 한다.
--
-- 두 가지를 한 마이그레이션에 담는다 — 둘 다 `registered_devices`/`device_credentials`
-- 도메인이고, 아래 (1)이 만들어 놓은 revoked credential이 (3)의 중복 판정 모집단을
-- 줄여 주므로 순서상으로도 붙어 있어야 한다.
--
-- ⚠️ 적용 전 아래 조회로 영향 범위를 **먼저 저장해 두십시오**(롤백에 필요합니다):
--   SELECT d.id, d.household_id, d.member_id, d.status
--   FROM registered_devices d
--   JOIN household_members m ON m.id = d.member_id
--   WHERE d.status = 'active' AND m.status <> 'active';
--
--   SELECT device_id, array_agg(id ORDER BY created_at DESC, id DESC)
--   FROM device_credentials WHERE status = 'active'
--   GROUP BY device_id HAVING count(*) > 1;

-- (1) 이미 제거된 구성원이 소유한 활성 장치를 폐기한다.
--
-- 왜 삭제가 아니라 상태 전이인가: 장치 행은 card_sms_events / device_nonces /
-- device_credentials의 FK 대상이고 수집 이력 감사에 쓰인다. 지우면 되돌릴 수 없다.
-- status 전이는 접근만 좁히고 행은 남긴다.
--
-- collect_token_hash를 NULL로 지우는 이유: 이미 유출됐을 수 있는 Bearer 토큰이
-- 어떤 경로로든 장치가 다시 active가 됐을 때 되살아나면 안 된다. UNIQUE 제약은
-- 다수 NULL을 허용하므로 충돌하지 않는다.
--
-- 애플리케이션 가드(device-token.guard / device-hmac.guard)가 이미 멤버십을 조인해
-- 확인하므로 이 정리가 없어도 수집은 막힌다. 그래도 하는 이유는 장치 목록 화면이
-- 떠난 구성원의 장치를 계속 '활성'으로 보여주기 때문이다 — 남은 가족이 "정리됐다"고
-- 믿을 수 있어야 한다.
UPDATE "registered_devices" AS d
SET "status" = 'revoked',
    "revoked_at" = now(),
    "updated_at" = now(),
    "collect_token_hash" = NULL
FROM "household_members" AS m
WHERE m."id" = d."member_id"
  AND d."status" = 'active'
  AND m."status" <> 'active';
--> statement-breakpoint

-- (2) 위에서 폐기된 장치의 살아있는 자격증명도 함께 폐기한다.
UPDATE "device_credentials" AS c
SET "status" = 'revoked',
    "revoked_at" = now()
FROM "registered_devices" AS d
WHERE d."id" = c."device_id"
  AND c."status" = 'active'
  AND d."status" <> 'active';
--> statement-breakpoint

-- (3) 장치당 active credential이 2개 이상인 잔여 중복을 정리한다.
--
-- 무엇을 남기는가: **가장 최근에 만들어진 것**(created_at DESC, id DESC).
-- 근거: 앱의 회전 의미론이 "새 secret을 발급하고 이전 것을 폐기"이므로, 마지막
-- 회전 응답으로 클라이언트에 나간 secret이 최신 행이다. 나머지는 원래 revoked가
-- 됐어야 하는데 동시 회전 때문에 남은 것이다.
--
-- 삭제하지 않고 revoked로 표시한다 — 되돌리려면 revoked_at이 이 마이그레이션 시각인
-- 행을 다시 active로 되돌리면 된다(단, 그 순간 부분 유니크를 먼저 DROP해야 한다).
UPDATE "device_credentials" AS c
SET "status" = 'revoked',
    "revoked_at" = now()
WHERE c."status" = 'active'
  AND c."id" <> (
    SELECT keep."id"
    FROM "device_credentials" AS keep
    WHERE keep."device_id" = c."device_id"
      AND keep."status" = 'active'
    ORDER BY keep."created_at" DESC, keep."id" DESC
    LIMIT 1
  );
--> statement-breakpoint

-- (4) 방어선: 장치당 active credential은 1개.
--    앱은 회전 트랜잭션에서 registered_devices 행을 FOR UPDATE로 잠가 직렬화하지만,
--    선언만으로 유지되던 불변식을 DB가 실제로 강제하게 둔다.
CREATE UNIQUE INDEX "device_credentials_device_active_unique"
  ON "device_credentials" ("device_id")
  WHERE "status" = 'active';
