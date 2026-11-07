/* ---------------------------------------------------------------------------
 * 개인정보 › '자세히' 시트의 보관 안내.
 *
 * 수집을 멈추는 방법은 실제 버튼 이름과 위치로 쓴다. 보존 정책은 이 화면에서
 * 고르며, 철회(연결 해제)가 곧 전체 원문 삭제가 되지 않는다고 분명히 적는다.
 * ------------------------------------------------------------------------- */
import { ChevronRight } from "lucide-react";
import Link from "next/link";

import type { RetentionPolicy } from "@family/contracts";

import { retentionPolicyLabel } from "./retention-policy-labels";

export function RetentionGuide({
  policy,
  onNavigate,
}: Readonly<{
  policy: RetentionPolicy;
  /** 문자 연동으로 넘어가기 전에 시트를 닫는다. */
  onNavigate?: () => void;
}>) {
  const policyName = retentionPolicyLabel(policy);
  return (
    <div className="text-body text-muted-foreground flex max-h-[60dvh] flex-col gap-3 overflow-y-auto pb-2">
      <p>
        새 문자를 그만 받으려면{" "}
        <strong className="text-foreground font-medium">
          문자 연동 › 기기 ⋯ › 연결 해제
        </strong>
        를 눌러 주세요. 연결을 해제해도 이미 보관된 원문이 한꺼번에 지워지지는
        않아요.
      </p>
      <p>
        지금 보존 정책은{" "}
        <strong className="text-foreground font-medium">{policyName}</strong>
        이에요. 이 화면에서 정책을 바꾸면, 미리보기로 지금 지워질 건수를 확인한
        뒤에만 적용돼요. 거래·금액·분류 결과는 지우지 않고 문자 원문 사본만
        지워요.
      </p>
      <Link
        href="/devices"
        onClick={onNavigate}
        className="text-primary -mx-1 inline-flex min-h-11 items-center gap-0.5 self-start px-1 font-semibold active:opacity-60"
      >
        문자 연동 열기
        <ChevronRight className="size-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
