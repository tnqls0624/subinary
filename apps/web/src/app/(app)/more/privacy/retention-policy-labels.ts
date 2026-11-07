import type { RetentionPolicy } from "@family/contracts";

/** 화면 라벨 — 계약 값 `none`은 제품 말 "계속"으로만 보여 준다. */
export const RETENTION_POLICY_OPTIONS: ReadonlyArray<{
  value: RetentionPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "none",
    label: "계속",
    description: "자동으로 원문을 지우지 않아요.",
  },
  {
    value: "days_30",
    label: "30일",
    description: "받은 지 30일이 지난 문자 원문을 지워요. 기준은 수신 시각이에요.",
  },
  {
    value: "after_parse",
    label: "파싱 후 삭제",
    description: "파싱에 성공한 문자의 원문을 지워요. 거래·금액은 남아요.",
  },
  {
    value: "failures_only",
    label: "실패만",
    description:
      "실패한 문자와 아직 처리 중인 문자의 원문만 남기고, 성공·비거래로 끝난 원문은 지워요.",
  },
];

export function retentionPolicyLabel(policy: RetentionPolicy): string {
  return (
    RETENTION_POLICY_OPTIONS.find((option) => option.value === policy)?.label ??
    policy
  );
}
