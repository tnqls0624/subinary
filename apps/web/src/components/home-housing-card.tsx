import type { ManualHousingSummary } from "@family/contracts";
import { ArrowRight, House } from "lucide-react";
import Link from "next/link";
import React from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { manualDateText, manualKrwText } from "@/lib/home-finance-summary";

const PAYMENT_LABEL = { contract: "계약금", interim: "중도금", balance: "잔금", option: "옵션" } as const;

export function HomeHousingCard({ summary, loading, error, scope }: {
  summary?: ManualHousingSummary;
  loading: boolean;
  error: boolean;
  scope: "household" | "private";
}) {
  const next = !loading && !error ? summary?.nextPayment : null;
  if (!next) {
    const incomplete = !loading && !error && summary?.hasIncompletePayments;
    return (
      <section className="bg-card rounded-2xl border px-5 py-3" aria-label="주택 납부 일정">
        <Link href={`/plan?scope=${scope}`} className="flex min-h-11 items-center gap-3 py-2">
          <House className="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">주택 납부 일정</span>
            <span className={`mt-1 block text-xs leading-relaxed ${error ? "text-destructive" : "text-muted-foreground"}`} role={error ? "alert" : loading ? "status" : undefined}>
              {loading ? "납부 일정을 불러오는 중이에요." : error ? "납부 일정을 불러오지 못했어요." : incomplete ? "금액·날짜·납부 내역이 비어 있는 항목이 있어요." : "예정된 납부 일정이 없어요."}
            </span>
          </span>
          <ArrowRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        </Link>
      </section>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><House className="size-4" aria-hidden="true" />다음 주택 납부</CardTitle>
        <CardDescription>{scope === "household" ? "가족과 공유한 일정" : "나만 보는 일정"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="break-words text-2xl font-bold tracking-tight tabular-nums">{manualKrwText(next.remainingAmountKrw)}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">주택</dt><dd className="break-words">{next.label}</dd>
          <dt className="text-muted-foreground">항목</dt><dd>{PAYMENT_LABEL[next.kind]}{next.installment !== null ? ` ${next.installment}회차` : ""}</dd>
          <dt className="text-muted-foreground">납부일</dt><dd>{manualDateText(next.dueDate)}</dd>
        </dl>
        {!loading && !error && summary?.hasIncompletePayments ? <p className="text-muted-foreground text-xs leading-relaxed">금액·날짜·납부 내역이 비어 있는 항목이 있어요.</p> : null}
        <Link href={`/plan?scope=${scope}`} className="text-primary inline-flex min-h-11 items-center gap-1 text-sm font-medium">납부 일정 보기 <ArrowRight className="size-4" aria-hidden="true" /></Link>
      </CardContent>
    </Card>
  );
}
