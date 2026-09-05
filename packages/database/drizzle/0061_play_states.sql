-- 플레이그라운드 미니앱의 진행 상태.
--
-- ## 왜 필요한가
--
-- `/play`의 화면들(페이스·도감·리듬)은 전부 **읽기 전용**이다. 쌓인 거래를 계산해
-- 보여줄 뿐이라 사용자가 무언가를 정하거나 이어갈 수 없다. 토스가 게임 미니앱의
-- 최소 조건으로 요구하는 것이 정확히 이것이다 — "사용자 식별자로 저장하고 재접속
-- 시 데이터를 복구할 것"(앱인토스 게임 출시 가이드).
--
-- ## 왜 미니앱마다 테이블을 만들지 않는가
--
-- 게임 하나 붙일 때마다 마이그레이션을 하면 실험이 느려지고, 실험이 느리면 안 쓰일
-- 기능을 미리 설계하게 된다. 상태는 대개 작고(월 하나에 숫자 하나) 모양이 자주
-- 바뀌므로 jsonb가 맞다.
--
-- 대신 **의미 검증은 미니앱 코드가 한다.** 이 테이블은 크기와 키 형식만 지킨다 —
-- 저장소가 값의 뜻을 알면 미니앱마다 저장소를 고쳐야 한다.
--
-- ## 왜 가구 단위인가
--
-- 사용자가 2명이고 "우리 이번 달 얼마 쓸까"는 함께 답하는 질문이다. 개인별로 나누면
-- 같은 화면을 보는 가족이 서로 다른 진행을 보게 된다. `created_by`는 누가 마지막으로
-- 바꿨는지를 남길 뿐 격리 축이 아니다.
--
-- 개인 상태가 필요해지면 그때 `member_id`를 유니크 키에 더한다 — 지금 넣으면 쓰지
-- 않는 축이 유니크 제약에 박혀 나중에 빼기 어렵다.
CREATE TABLE IF NOT EXISTS play_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  -- 미니앱 식별자(`monthly-forecast` 등). 코드가 정하는 값이라 자유 텍스트다.
  app_key text NOT NULL,
  -- 미니앱 안의 키. 월별 상태면 `2026-09`처럼 쓴다.
  state_key text NOT NULL,
  state jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 같은 가구·미니앱·키는 하나뿐이다. upsert가 이 제약 위에서 동작한다.
  CONSTRAINT play_states_scope_unique UNIQUE (household_id, app_key, state_key),

  -- 키 길이를 묶는다. 저장소가 값의 뜻은 몰라도 **모양**은 지켜야 한다 —
  -- 제한이 없으면 실수로 만든 긴 키가 인덱스를 망가뜨린다.
  CONSTRAINT play_states_app_key_len CHECK (char_length(app_key) BETWEEN 1 AND 64),
  CONSTRAINT play_states_state_key_len CHECK (char_length(state_key) BETWEEN 1 AND 64),
  -- 상태 크기 상한. 미니앱 진행 상태는 작아야 하고(월 하나에 숫자 몇 개), 커지면
  -- 그건 이 저장소가 아니라 전용 테이블이 필요하다는 신호다.
  CONSTRAINT play_states_state_size CHECK (pg_column_size(state) <= 8192)
);

CREATE INDEX IF NOT EXISTS play_states_household_app_idx
  ON play_states (household_id, app_key);
