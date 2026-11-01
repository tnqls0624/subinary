import * as React from "react";
import type { ManualAssetSummary, ManualFinanceScope } from "@family/contracts";
import { displayManualKrw } from "./model";

export function ManualAssetsSummary({
  summary,
  scope = "household",
  sourceLabel = "직접 입력",
  hasImportedBalance = false,
}: {
  summary: ManualAssetSummary;
  scope?: ManualFinanceScope;
  sourceLabel?: string;
  hasImportedBalance?: boolean;
}) {
  if (summary.completeness === "empty") {
    return (
      <section className="bg-card rounded-2xl border p-5 sm:p-6" aria-label="등록한 자산 요약">
        <p className="text-muted-foreground text-xs">{scope === "household" ? "가족과 공유한 자산" : "나만 보는 자산"}</p>
        <h2 className="mt-2 text-lg font-semibold">등록된 자산이 없어요</h2>
        <p className="text-muted-foreground mt-2 text-sm">통장·적금·주식·대출을 추가해 보세요.</p>
      </section>
    );
  }
  const range = hasImportedBalance
    ? "은행 잔액 기준일 미확인"
    : summary.mixedAsOfDates
    ? `항목별 기준일 ${summary.oldestAsOfDate ?? "미입력"} ~ ${
        summary.newestAsOfDate ?? "미입력"
      }`
    : `기준일 ${summary.asOfDate ?? "미입력"}`;
  const netKnown = summary.completeness === "complete" && summary.netAssets !== null;
  return (
    <section
      className="bg-card text-card-foreground min-w-0 rounded-2xl border p-5 sm:p-6"
      aria-label="등록한 자산 요약"
    >
      <p className="text-muted-foreground text-sm">
        {scope === "household" ? "가족과 공유한 자산" : "나만 보는 자산"}
      </p>
      {netKnown ? (
        <>
          <h2 className="mt-3 text-sm font-medium">순자산</h2>
          <p className="mt-2 break-all text-3xl font-bold tracking-tight tabular-nums sm:text-4xl">
            {displayManualKrw(summary.netAssets)}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">등록한 자산에서 남은 대출을 뺀 금액</p>
        </>
      ) : <h2 className="sr-only">입력한 자산과 대출</h2>}
      <dl className={`mt-5 grid min-w-0 grid-cols-2 gap-4 text-sm ${netKnown ? "border-t pt-4" : ""}`}>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">
            {summary.assetsCompleteness === "partial"
              ? "자산 (일부 입력)"
              : "등록한 자산"}
          </dt>
          <dd className={`mt-2 break-all font-semibold tabular-nums ${summary.grossAssets === null ? "text-muted-foreground text-sm" : netKnown ? "text-base" : "text-xl sm:text-2xl"}`}>
            {summary.grossAssets === null ? "미입력" : displayManualKrw(summary.grossAssets)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">
            {summary.debtCompleteness === "partial"
              ? "대출 (일부 입력)"
              : "남은 대출"}
          </dt>
          <dd className={`mt-2 break-all font-semibold tabular-nums ${summary.debt === null ? "text-muted-foreground text-sm" : netKnown ? "text-base" : "text-xl sm:text-2xl"}`}>
            {summary.debt === null ? "미입력" : displayManualKrw(summary.debt)}
          </dd>
        </div>
      </dl>
      {!netKnown ? <p className="text-muted-foreground mt-4 text-xs leading-relaxed">미입력 금액이 있어 순자산은 아직 계산하지 않았어요.</p> : null}
      <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
        {range} · {sourceLabel}
      </p>
    </section>
  );
}
