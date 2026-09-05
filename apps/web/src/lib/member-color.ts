/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 구성원 색상
 *
 * 구성원별로 안정적인 색을 배정해, 거래·카드 등 아이콘 배경색만으로 "누구의
 * 내역인지" 한눈에 구별하게 한다. 기본은 memberId 해시로 고정 팔레트에서 고르고,
 * 구성원이 직접 고른 색(`MemberSummary.color` 팔레트 키)이 있으면 그 색이 우선한다.
 *
 * 팔레트는 라이트/다크 모두에서 읽히도록 반투명 배경 + 채도 있는 아이콘 색 쌍으로
 * 구성한다. Tailwind는 소스에 등장한 리터럴 클래스만 포함하므로, 동적 조합
 * (`bg-${c}-500`)이 아니라 완성된 문자열 맵으로 둔다(purge 안전).
 * ------------------------------------------------------------------------- */
import type { MemberColor } from "@family/contracts";

/** 팔레트 키 → 아이콘 배경/전경 클래스(8색, 시각적으로 구분되는 hue). */
const MEMBER_ICON_CLASSES: Record<MemberColor, string> = {
  rose: "bg-rose-500/15 text-rose-600 dark:bg-rose-500/25 dark:text-rose-300",
  orange:
    "bg-orange-500/15 text-orange-600 dark:bg-orange-500/25 dark:text-orange-300",
  amber:
    "bg-amber-500/15 text-amber-600 dark:bg-amber-500/25 dark:text-amber-300",
  emerald:
    "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/25 dark:text-emerald-300",
  teal: "bg-teal-500/15 text-teal-600 dark:bg-teal-500/25 dark:text-teal-300",
  sky: "bg-sky-500/15 text-sky-600 dark:bg-sky-500/25 dark:text-sky-300",
  violet:
    "bg-violet-500/15 text-violet-600 dark:bg-violet-500/25 dark:text-violet-300",
  fuchsia:
    "bg-fuchsia-500/15 text-fuchsia-600 dark:bg-fuchsia-500/25 dark:text-fuchsia-300",
};

/** 색상 선택 UI의 견본(swatch) 원 배경색. */
export const MEMBER_COLOR_SWATCH_CLASSES: Record<MemberColor, string> = {
  rose: "bg-rose-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  fuchsia: "bg-fuchsia-500",
};

/** 접근성 라벨용 한국어 색 이름(팔레트 키는 내부용이라 그대로 노출하지 않는다). */
export const MEMBER_COLOR_LABELS: Record<MemberColor, string> = {
  rose: "로즈",
  orange: "주황",
  amber: "호박",
  emerald: "에메랄드",
  teal: "청록",
  sky: "하늘",
  violet: "보라",
  fuchsia: "자홍",
};

/** 해시 → 색 매핑 순서. 기존 배열 순서를 유지해 저장 색 없는 구성원의 색이 바뀌지 않게 한다. */
const HASH_PALETTE: readonly MemberColor[] = [
  "rose",
  "orange",
  "amber",
  "emerald",
  "teal",
  "sky",
  "violet",
  "fuchsia",
];

/** 선택 UI 노출 순서. */
export const MEMBER_COLOR_KEYS = HASH_PALETTE;

/** 구성원 없음/미상일 때의 기본(중립) 색. */
const NEUTRAL = "bg-muted text-muted-foreground";

/**
 * memberId → 아이콘 배경/전경 Tailwind 클래스. 저장된 팔레트 키(`color`)가 있으면
 * 그 색을, 없으면 결정적 해시(djb2 계열)로 팔레트에서 고른 색을 반환한다.
 * memberId가 없으면 중립색.
 */
export function memberColorClass(
  memberId: string | null | undefined,
  color?: MemberColor | null,
): string {
  if (color) return MEMBER_ICON_CLASSES[color];
  if (!memberId) return NEUTRAL;
  let hash = 0;
  for (let i = 0; i < memberId.length; i += 1) {
    hash = (hash * 31 + memberId.charCodeAt(i)) >>> 0;
  }
  return MEMBER_ICON_CLASSES[HASH_PALETTE[hash % HASH_PALETTE.length]];
}

/**
 * 공용(공동사용 카드) 버킷의 아이콘 색.
 *
 * 종전에는 언제나 중립 회색이었다. 그 선택에는 이유가 있었다 — "색이 곧 '누구'를
 * 뜻하므로, 귀속을 보류한 거래에 특정 색을 주면 화면이 이름(공용)과 다른 답을
 * 말한다". 그 우려는 **공용이 사람 팔레트에서 자동 배정될 때** 성립한다: 그러면
 * 색을 보고 사람을 떠올린 사용자가 이름에서 '공용'을 읽고 어긋난다.
 *
 * 사용자가 직접 하나를 고르면 그 색은 "공용"이라는 **하나의 값**을 가리키므로 화면이
 * 두 답을 말하지 않는다. 그래서 색을 여는 대신 **자동 배정을 열지 않는다** — 고르지
 * 않았으면(`null`) 종전 회색 그대로다.
 */
export function sharedColorClass(color?: MemberColor | null): string {
  return color ? MEMBER_ICON_CLASSES[color] : NEUTRAL;
}
