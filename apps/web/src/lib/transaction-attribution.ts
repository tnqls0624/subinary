/* ---------------------------------------------------------------------------
 * 거래 한 건을 **누구의 것으로 보여줄지** — 화면 공통 규칙
 *
 * ## 왜 모듈로 뽑았나
 *
 * 이 판단이 화면마다 따로 구현돼 있었고, 결국 갈렸다. 2026-09-05 실측:
 *
 * | 화면 | 쓰던 규칙 | 공룡카드(공용) 거래 표시 |
 * |---|---|---|
 * | 홈 · 최근 거래 | 카드 **소유자** | 김유진 |
 * | 홈 · 누가 어떤 카드로 | `is_shared` → 공용 | 공용 |
 * | 거래 목록 | `is_shared` → 공용, 아니면 `memberId` | 공용 |
 *
 * 같은 거래가 한 화면에서 두 가지로 보였다. 영향 범위는 공용 카드 거래 **88건
 * 1,458,011원**이고, 증상은 "홈 최근 거래에 한 사람 것만 나온다"였다 — 공용 카드
 * 소유자가 한 명이라 그 사람 이름이 목록을 덮었다.
 *
 * 고장이 조용한 종류라는 점이 중요하다. 화면은 멀쩡히 그려지고 숫자도 맞다.
 * 사용자가 "내가 쓴 게 왜 안 보이지"를 눈치채야만 드러난다.
 *
 * ## 규칙
 *
 * 1. 공용으로 표시한 카드의 결제는 **사람 이름을 붙이지 않는다**(`null` = 공용).
 *    카드 문자에는 누가 그었는지가 없고, 공동사용 카드는 문자를 받는 폰 주인에게
 *    지출이 전부 몰린다(실측 76% vs 24%). 그 왜곡을 지분 분할로 덮지 않고 —
 *    50/50은 실측이 아니라 가정이다 — 귀속을 보류한 상태 그대로 보여준다.
 *
 * 2. 그 외에는 **카드 소유자보다 거래의 구성원(`memberId`)을 우선**한다.
 *    서버 집계(`analytics/members`)가 `card_transactions.member_id`를 정본으로 쓰므로,
 *    화면이 카드 소유자를 우선하면 통계와 목록이 서로 다른 사람을 말한다. 지금은 두
 *    값이 같아(비공용 카드에서 소유자 ≠ memberId인 거래 **0건**) 모순이 보이지
 *    않지만, 거래의 구성원을 재지정할 수 있게 되는 순간 "바꿨는데 안 바뀐다"가 된다.
 *
 * 아이콘 **색**도 이 결과를 따른다. 색이 곧 "누구"를 뜻하므로 이름과 색이 다른
 * 규칙을 쓰면 화면이 두 답을 말한다.
 * ------------------------------------------------------------------------- */

/** 이 판단에 필요한 거래의 최소 형태. */
export interface AttributableTransaction {
  cardId: string | null;
  memberId: string;
}

/** 이 판단에 필요한 카드의 최소 형태. */
export interface AttributableCard {
  id: string;
  isShared: boolean;
}

/** 공용으로 표시한 카드 id 집합. 카드 목록에서 한 번 만들어 재사용한다. */
export function sharedCardIdSet(
  cards: readonly AttributableCard[],
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const c of cards) if (c.isShared) set.add(c.id);
  return set;
}

/**
 * 이 거래를 귀속시킬 구성원 id. **`null`이면 '공용'** — 사람이 아니라 귀속을
 * 보류한 묶음이라는 뜻이고, 화면은 이름 대신 '공용'을 쓴다.
 *
 * 카드가 없는 거래(수기 입력 등)는 공용 판정 대상이 아니므로 그대로 `memberId`다.
 */
export function attributedMemberId(
  txn: AttributableTransaction,
  sharedCardIds: ReadonlySet<string>,
): string | null {
  return txn.cardId !== null && sharedCardIds.has(txn.cardId)
    ? null
    : txn.memberId;
}

/** 화면에 쓸 이름. 공용이면 '공용', 이름을 못 찾으면 '구성원'. */
export function attributedMemberName(
  memberId: string | null,
  nameById: ReadonlyMap<string, string>,
): string {
  if (memberId === null) return '공용';
  return nameById.get(memberId) ?? '구성원';
}
