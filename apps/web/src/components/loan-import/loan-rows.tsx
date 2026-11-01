import Link from "next/link";
import type { ImportedLoanRecord } from "@family/contracts";
import { displayManualKrw, visibilityLabel } from "@/components/manual-finance/model";

export function loanInclusionLabel(item: ImportedLoanRecord): string {
  if (item.includedInTotals) {
    return item.totalMode === "replacement"
      ? "기존 기록 대신 계산"
      : "별도 대출로 합계 반영";
  }
  const reasons: Record<NonNullable<ImportedLoanRecord["exclusionReason"]>, string> = {
    reference: "기록만 보관 · 합계 제외",
    replacement_changed: "기존 대출 변경 · 연결 확인 필요 · 합계 제외",
    duplicate_visible_loan: "중복 확인 필요 · 합계 제외",
    sharing_expired: "공유 상태 변경 · 가족 공유 확인 필요 · 합계 제외",
  };
  return item.exclusionReason
    ? reasons[item.exclusionReason]
    : "합계 제외 · 반영 설정 확인 필요";
}

export function LoanOverviewRow({ item }: { item: ImportedLoanRecord }) {
  const checkedAt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(item.capturedAt));
  return (
    <article className="min-h-20 min-w-0 border-b p-4 last:border-0" aria-label={`${item.label} 가져온 대출`}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-28">
          <h3 className="break-words text-sm font-semibold">{item.label}</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {item.loanType === "jeonse" ? "전세 대출" : "중도금 대출"} · {visibilityLabel(item.visibility)}
          </p>
        </div>
        <div className="min-w-0 text-right">
          <strong className="block break-all text-base tabular-nums">{displayManualKrw(item.outstandingPrincipalKrw)}</strong>
          <small className="text-muted-foreground text-xs">남은 원금</small>
        </div>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">은행 잔액 기준일 미확인</p>
      <p className="mt-2 text-xs">{loanInclusionLabel(item)}</p>
      <details className="min-w-0 text-xs">
        <summary className="text-muted-foreground min-h-11 cursor-pointer py-3">대출 정보</summary>
        <dl className="text-muted-foreground grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
          <dt>계좌</dt><dd className="min-w-0">끝 4자리 {item.accountLast4}</dd>
          <dt>만기일</dt><dd className="min-w-0">{item.maturityDate ?? "미확인"}</dd>
          <dt>출처</dt><dd className="min-w-0 break-words">신한은행 대출계좌조회 화면</dd>
          <dt>화면 확인</dt><dd className="min-w-0 break-words"><time dateTime={item.capturedAt}>{checkedAt}</time> (한국 시간)</dd>
        </dl>
        {item.canEdit ? (
          <Link href="/assets/loan-import" className="text-primary mt-2 inline-flex min-h-11 items-center text-xs font-medium">가져온 기록 수정 →</Link>
        ) : null}
      </details>
    </article>
  );
}
