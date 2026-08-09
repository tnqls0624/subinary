/* ---------------------------------------------------------------------------
 * 결제 실패 사유 → 사용자가 할 일 (C-8)
 *
 * 사유 코드는 사용자에게 아무 의미가 없고, "거절됨"만으로는 카드사 앱을 따로 열어야
 * 한다. 그래서 **조치 문구로 번역**해서 보여준다. 미등록 사유는 문구를 만들지 않는다
 * (추측 안내 금지 — 틀린 조치를 시키는 것이 아무 말도 안 하는 것보다 나쁘다).
 *
 * 홈 '할 일' 카드가 결제 실패 배너를 흡수하면서(C-8) 이 표가 배너 밖에서도 필요해졌다.
 * `/declines`는 자기 사본을 갖고 있다 — IA 개편 때 그쪽도 여기로 모으면 된다.
 * ------------------------------------------------------------------------- */
import type { CardSmsDeclineReason } from "@family/contracts";

const REASON_HINT: Partial<Record<CardSmsDeclineReason, string>> = {
  lost_or_stolen: "분실 신고된 카드예요 · 결제수단을 바꿔주세요",
  limit_exceeded: "한도를 넘었어요",
  insufficient_balance: "잔액이 부족해요",
  expired_card: "유효기간이 지났어요",
  suspended: "정지된 카드예요",
  invalid_credential: "카드 정보가 맞지 않아요",
};

/** 사유 → 조치 문구. 모르는 사유·사유 없음이면 `undefined`(문구를 지어내지 않는다). */
export function declineReasonHint(
  reason: CardSmsDeclineReason | null | undefined,
): string | undefined {
  return reason ? REASON_HINT[reason] : undefined;
}
