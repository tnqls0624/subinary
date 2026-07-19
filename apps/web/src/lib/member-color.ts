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
