/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 카테고리 아이콘
 *
 * 카테고리를 아이콘 "모양"으로 구별한다(구성원은 아이콘 배경 "색"으로 — member-color).
 * 거래 목록과 홈 최근거래가 같은 거래를 동일 아이콘으로 그리도록 공유한다.
 * 이름 부분일치 규칙 → 시스템/커스텀 카테고리 모두 이름에 키워드가 있으면 매칭,
 * 미지정/미매칭은 CreditCard로 폴백(가맹점을 지어내지 않는 원칙과 동일 톤).
 * ------------------------------------------------------------------------- */
import {
  Bus,
  Clapperboard,
  Coffee,
  CreditCard,
  GraduationCap,
  HeartPulse,
  Home,
  Plane,
  Repeat,
  ShoppingBag,
  Utensils,
  type LucideIcon,
} from "lucide-react";

/** 카테고리 이름 키워드 → 아이콘(부분일치, 위에서부터 우선). */
const CATEGORY_ICON_RULES: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["식비", Utensils],
  ["카페", Coffee],
  ["간식", Coffee],
  ["교통", Bus],
  ["쇼핑", ShoppingBag],
  ["생활", Home],
  ["의료", HeartPulse],
  ["건강", HeartPulse],
  ["교육", GraduationCap],
  ["문화", Clapperboard],
  ["여가", Clapperboard],
  ["여행", Plane],
  ["구독", Repeat],
];

/** 카테고리 이름 → lucide 아이콘(이름 부분일치, 미지정/미매칭 → CreditCard). */
export function categoryIcon(name: string | null | undefined): LucideIcon {
  if (!name) return CreditCard;
  for (const [keyword, icon] of CATEGORY_ICON_RULES) {
    if (name.includes(keyword)) return icon;
  }
  return CreditCard;
}
