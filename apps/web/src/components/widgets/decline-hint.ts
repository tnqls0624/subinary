/* ---------------------------------------------------------------------------
 * 결제 실패 사유 → 사용자가 할 일 (C-8)
 *
 * 사유 코드는 사용자에게 아무 의미가 없고, "거절됨"만으로는 카드사 앱을 따로 열어야
 * 한다. 그래서 **조치 문구로 번역**해서 보여준다. 미등록 사유는 문구를 만들지 않는다
 * (추측 안내 금지 — 틀린 조치를 시키는 것이 아무 말도 안 하는 것보다 나쁘다).
 *
 * 홈 '할 일' 카드가 결제 실패 배너를 흡수하면서(C-8) 이 표가 배너 밖에서도 필요해졌다.
 * `/declines`도 이제 여기를 쓴다(사본 제거).
 * ------------------------------------------------------------------------- */
import type {
  CardSmsDeclineGroup,
  CardSmsDeclineReason,
} from "@family/contracts";

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

/**
 * 실패 묶음의 안정적인 식별자(React key).
 *
 * 서버가 `(가맹점, 금액)`으로 묶으므로 그 쌍이 곧 신원이다. 다만 `` `${m}-${a}` ``
 * 처럼 이어 붙이면 구분자가 값 안에 섞여 서로 다른 묶음이 같은 문자열이 될 수 있다
 * (가맹점 이름이 `null`인 묶음과 이름이 `"null"`인 가맹점). key가 겹치면 React가
 * 행을 잘못 재사용해 **엉뚱한 거절 건이 표시되고, '확인했어요'가 다른 건에 걸린다.**
 * JSON 배열로 인코딩하면 문자열과 null·숫자가 섞이지 않는다.
 */
export function declineGroupKey(
  group: Pick<CardSmsDeclineGroup, "merchant" | "amount">,
): string {
  return JSON.stringify([group.merchant, group.amount]);
}
