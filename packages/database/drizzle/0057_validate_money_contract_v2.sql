-- =============================================================================
-- 0057 — 금액 계약 v2 제약 VALIDATE (ADR-0027 8단계)
-- -----------------------------------------------------------------------------
-- ## 왜 지금인가
--
-- `0049`는 v2 제약 6종을 **NOT VALID**로 걸었다. 그때는 기존 행이 전부 v1이라 즉시
-- 검증하면 배포가 막혔기 때문이다. NOT VALID는 "앞으로 들어오는 행은 막지만 기존 행은
-- 검사하지 않는다"는 뜻이라, 제약이 절반만 살아 있는 상태였다.
--
-- 7단계(2026-09-03)가 끝나 `money_contract_version < 2`인 행이 **0건**이 됐다
-- (259/259, 적용 delta 합 0, 월별 지출 합계 무변경 대조 완료). 이제 전체 스캔이
-- 통과하므로 제약을 온전한 것으로 승격한다.
--
-- ## 무엇을 하지 않는가 (ADR §5가 명시적으로 금지한 것)
--
--   - `money_contract_version`의 **기본값을 바꾸지 않는다.** v1로 둔다. 롤백 창에
--     이전 바이너리로 돌아가도 조건부 v2 제약과 충돌하지 않아야 한다.
--   - 컬럼·수리 로그·legacy 읽기 경로를 **삭제하지 않는다.**
--   - 기본값 v2 전환과 호환 경로 제거는 롤백 관찰 기간이 끝난 뒤 **별도 정리
--     마이그레이션**에서 검토한다.
--
-- ## 잠금
--
-- `VALIDATE CONSTRAINT`는 SHARE UPDATE EXCLUSIVE만 잡는다. 읽기와 일반 쓰기를 막지
-- 않으므로 서비스 중단 없이 돌아간다. 전체 스캔이라 큰 테이블에서는 시간이 걸리지만
-- 현재 259행이라 즉시 끝난다.
--
-- ## 실패하면
--
-- VALIDATE는 위반 행을 만나면 그 문장만 실패하고 제약은 NOT VALID로 남는다. 데이터가
-- 깨지지 않으므로 되돌릴 것이 없다 — 위반 행을 찾아 7단계 도구
-- (`scripts/repair-money-contract.mjs`)로 처리한 뒤 다시 돌리면 된다.
-- =============================================================================

-- v2-1. 저장 통화는 항상 KRW.
ALTER TABLE "card_transactions" VALIDATE CONSTRAINT "card_transactions_v2_currency_krw_check";--> statement-breakpoint

-- v2-2. original_amount와 original_currency는 함께 있거나 함께 없다.
ALTER TABLE "card_transactions" VALIDATE CONSTRAINT "card_transactions_v2_original_pair_check";--> statement-breakpoint

-- v2-3. 외화 원본이면 환율 스냅샷이 반드시 있다.
ALTER TABLE "card_transactions" VALIDATE CONSTRAINT "card_transactions_v2_fx_snapshot_check";--> statement-breakpoint

-- v2-4. 외화 승인은 원통화 취소 누계를 가지며 원금액을 넘지 않는다.
ALTER TABLE "card_transactions" VALIDATE CONSTRAINT "card_transactions_v2_original_cancelled_check";--> statement-breakpoint

-- v2-5. 승인 순액 항등식. 지출 합계가 승인 net_amount의 합이므로 이 식이 깨지면 총액이
--       조용히 틀린다 — 여섯 중 가장 직접적으로 화면을 지키는 제약이다.
ALTER TABLE "card_transactions" VALIDATE CONSTRAINT "card_transactions_v2_approval_sum_check";--> statement-breakpoint

-- v2-6. 취소 행의 순액은 0.
ALTER TABLE "card_transactions" VALIDATE CONSTRAINT "card_transactions_v2_cancellation_net_zero_check";
