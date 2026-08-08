-- 가구 전체 예산이 둘 이상 생기지 못하게 부분 유니크를 건다.
--
-- 왜 필요한가: 기존 UNIQUE(household_id, scope_type, scope_ref_id)는 household
-- 스코프에서 scope_ref_id가 NULL이라 SQL의 NULL != NULL 규칙 때문에 서로 다른 행으로
-- 취급한다. 서비스의 사전 중복 조회와 insert 사이에는 직렬화 지점이 없어, 동시 생성
-- 두 건은 둘 다 통과해 가구 전체 예산이 두 개 남는다(사용률 화면에 같은 예산이 두 줄).

-- (1) 기존 중복이 있으면 **실패시킨다**. 조용히 지우지 않는다.
--
-- 예산은 사용자가 직접 입력한 금액이고, budgets에는 soft-delete 컬럼이 없어 보존용
-- 표시를 남길 자리가 없다. 어느 금액이 "맞는" 값인지는 데이터만 보고 판단할 수 없으므로
-- (가장 오래된 것? 가장 큰 것? 마지막에 수정한 것?), 사람이 고르게 두는 편이 낫다.
-- 실제로 중복이 있으면 이 마이그레이션은 아래 메시지와 함께 멈춘다.
--
-- 수동 정리 방법(중복이 있을 때만):
--   SELECT id, name, amount, created_at FROM budgets
--   WHERE scope_type = 'household' AND household_id = '<가구 id>'
--   ORDER BY created_at;
--   -- 남길 행을 고른 뒤 나머지를 DELETE 하고 이 마이그레이션을 다시 실행한다.
DO $$
DECLARE
  duplicate_households text;
BEGIN
  SELECT string_agg(household_id::text, ', ')
  INTO duplicate_households
  FROM (
    SELECT household_id
    FROM budgets
    WHERE scope_type = 'household'
    GROUP BY household_id
    HAVING count(*) > 1
  ) AS dup;

  IF duplicate_households IS NOT NULL THEN
    RAISE EXCEPTION
      'budgets: household-scope duplicates must be resolved by hand before this index can be created (household_id: %)',
      duplicate_households;
  END IF;
END $$;
--> statement-breakpoint

-- (2) 가구당 household 스코프 예산 1개.
CREATE UNIQUE INDEX "budgets_household_scope_unique"
  ON "budgets" ("household_id")
  WHERE "scope_type" = 'household';
