import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** 상태값 → 색조 매핑(거래/카드/장치/초대/멤버 상태 공용). */
const STATUS_TONES: Record<string, BadgeTone> = {
  // 거래 상태
  approved: "success",
  partially_cancelled: "warning",
  cancelled: "neutral",
  pending_review: "warning",
  duplicate_suspected: "danger",
  // 카드/장치 상태
  active: "success",
  inactive: "neutral",
  revoked: "danger",
  // 멤버/초대 상태
  removed: "neutral",
  pending: "info",
  accepted: "success",
  expired: "neutral",
};

/** 상태값 → 한국어 라벨. */
const STATUS_LABELS: Record<string, string> = {
  approved: "승인",
  partially_cancelled: "부분취소",
  cancelled: "취소",
  pending_review: "확인필요",
  duplicate_suspected: "중복의심",
  active: "활성",
  inactive: "비활성",
  revoked: "폐기",
  removed: "제거됨",
  pending: "대기",
  accepted: "수락됨",
  expired: "만료",
};

interface StatusBadgeProps {
  status: string;
  /** 라벨 오버라이드(미지정 시 매핑/원문). */
  label?: ReactNode;
  /** 색조 오버라이드(미지정 시 매핑/neutral). */
  tone?: BadgeTone;
}

/** 상태 배지. 알려진 상태는 라벨/색조를 자동 매핑한다. */
export function StatusBadge({ status, label, tone }: StatusBadgeProps) {
  const resolvedTone = tone ?? STATUS_TONES[status] ?? "neutral";
  const resolvedLabel = label ?? STATUS_LABELS[status] ?? status;
  return (
    <span className={`status-badge tone-${resolvedTone}`}>{resolvedLabel}</span>
  );
}
