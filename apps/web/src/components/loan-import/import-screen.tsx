"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ImportedLoanRecord, LoanImportPreviewResponse } from "@family/contracts";
import { Button } from "@/components/ui/button";
import { FinanceLoadError, FinanceLoading } from "@/components/manual-finance/shared";
import { displayManualKrw, visibilityLabel } from "@/components/manual-finance/model";
import { useAuth } from "@/lib/auth-context";
import { loanImportApi, useOwnedLoanImports } from "@/lib/loan-import-client";
import { createLoanTaskSession, displayLoanCapturedAt, loanFailureStatus, readLoanCaptureFile } from "./model";
import { loanInclusionLabel } from "./loan-rows";
import { LoanRecordEditor } from "./record-editor";
import { LoanCaptureReview } from "./review-dialog";

export function LoanImportScreen({ householdId, userId, canCreate }: { householdId: string; userId: string; canCreate: boolean }) {
  const { authedFetch } = useAuth();
  const records = useOwnedLoanImports();
  const [preview, setPreview] = useState<LoanImportPreviewResponse | null>(null);
  const [editing, setEditing] = useState<ImportedLoanRecord | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const session = useRef(createLoanTaskSession());
  useEffect(() => () => { session.current.invalidate(); if (fileInput.current) fileInput.current.value = ""; }, []);
  const unavailable = Boolean(editing && (
    loanFailureStatus(records.error) === 403 || loanFailureStatus(records.error) === 404 ||
    (records.isSuccess && !records.isFetching && !records.data.items.some((item) => item.id === editing.id && item.canEdit))
  ));
  useEffect(() => { if (unavailable) { setEditing(null); setNotice("기록이나 권한이 바뀌었어요. 목록을 다시 확인해 주세요."); } }, [unavailable]);

  const importFile = async (file: File) => {
    if (!canCreate || session.current.pending || preview || editing) return;
    setReading(true); setError(null); setNotice(null);
    let localRead = true;
    await session.current.run(
      async (signal) => {
        const capture = await readLoanCaptureFile(file, signal);
        localRead = false;
        return authedFetch((token) => loanImportApi.preview(token, { householdId, capture }, userId, signal));
      },
      (result) => { setReading(false); setPreview(result); },
      (failure) => {
        setReading(false);
        setError(localRead && failure instanceof Error ? failure.message : "대출 내용을 확인하지 못했어요. 연결 상태와 선택한 가족을 확인한 뒤 파일을 다시 선택해 주세요.");
      }
    );
  };
  return (
    <div className="min-w-0 space-y-5">
      <Link href="/assets" className="text-muted-foreground inline-flex min-h-11 items-center text-sm">← 자산으로</Link>
      <header><h1 className="text-2xl font-bold tracking-tight">신한 대출 가져오기</h1><p className="text-muted-foreground mt-2 text-sm">전세·중도금 대출의 남은 원금과 만기일을 저장해요.</p></header>
      <section className="bg-card grid min-w-0 grid-cols-1 gap-4 rounded-2xl border p-4 sm:p-5">
        <div>
          <h2 className="font-semibold">대출 내역 파일</h2>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">파일 선택 → 내용 확인 → 저장</p>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">파일을 선택하면 미리보기를 위해 내용이 앱 서버로 전송돼요. 확인 후 저장을 눌러야 기록이 추가돼요.</p>
        <label className="grid min-w-0 grid-cols-1 gap-2 text-sm font-medium">
          신한 대출 확인 파일 · 최대 64KB
          <input ref={fileInput} type="file" accept=".json,application/json" disabled={!canCreate || reading || Boolean(preview || editing)}
            className="bg-background min-h-11 w-full min-w-0 max-w-full rounded-md border p-2 text-sm file:mr-3 file:rounded file:border-0 file:px-3 file:py-2 disabled:opacity-60"
            onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importFile(file); }} />
        </label>
        <p className="text-muted-foreground text-xs leading-relaxed">은행 자동 연결이 아닌 파일 가져오기예요. 잔액을 갱신하려면 새 파일이 필요해요.</p>
        <details className="min-w-0 border-t">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">가져오는 방법</summary>
          <ol className="text-muted-foreground list-inside list-decimal space-y-2 pb-3 text-sm leading-relaxed">
            <li>PC에서 신한 인터넷뱅킹에 직접 로그인하고 대출계좌조회를 열어요.</li>
            <li>로컬 수집 도구에서 계좌 한 개를 선택해 JSON 파일을 만들어요.</li>
            <li>여기에서 파일을 고른 뒤 계좌·금액·가족 공유 여부를 확인해요.</li>
          </ol>
          <p className="text-muted-foreground pb-2 text-xs leading-relaxed">수집 도구가 만든 JSON 파일만 지원해요. 이 앱에 비밀번호·인증서·로그인 정보를 입력하지 않아요.</p>
        </details>
        {!canCreate ? <p role="status" className="text-sm">현재 가족 권한으로는 가져온 대출을 추가하거나 수정할 수 없어요.</p> : null}
        {reading ? <div className="flex flex-wrap items-center gap-3"><p role="status" className="text-sm">확인 파일을 읽고 있어요.</p><Button variant="outline" onClick={() => { session.current.invalidate(); setReading(false); setError(null); }}>불러오기 취소</Button></div> : null}
      </section>
      {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      <details className="min-w-0 rounded-xl border p-4">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">가져온 기록</summary>
        <p className="text-muted-foreground mb-4 text-xs">이 가족에 내가 저장한 대출이에요. 공유하지 않은 기록도 볼 수 있어요.</p>
        {records.isPending ? <FinanceLoading /> : records.isError ? <FinanceLoadError retry={() => void records.refetch()} /> : records.data?.items.length ? (
          <div className="divide-y">
            {records.data.items.map((item) => (
              <article key={item.id} className="grid min-w-0 grid-cols-1 gap-2 py-4">
                <h3 className="break-words text-sm font-semibold">{item.label}</h3>
                <p className="text-muted-foreground text-xs">{visibilityLabel(item.visibility)} · {item.loanType === "interim" ? "중도금" : "전세"} 대출 · 끝 {item.accountLast4}</p>
                <p className="break-all font-semibold tabular-nums">{displayManualKrw(item.outstandingPrincipalKrw)}</p>
                <p className="text-muted-foreground text-xs">만기 {item.maturityDate ?? "미확인"} · 은행 잔액 기준일 미확인</p>
                <details className="min-w-0 text-xs">
                  <summary className="text-muted-foreground min-h-11 cursor-pointer py-3">출처·확인 시각</summary>
                  <p className="text-muted-foreground pb-2">신한은행 대출계좌조회 화면에서 가져옴</p>
                  <p className="text-muted-foreground pb-2">화면 확인 {displayLoanCapturedAt(item.capturedAt)} (한국 시간)</p>
                </details>
                <p className="text-xs">{loanInclusionLabel(item)}</p>
                {item.canEdit && canCreate ? <Button variant="outline" className="h-auto min-h-11 w-full min-w-0 whitespace-normal" disabled={reading || Boolean(preview || editing)} onClick={() => setEditing(item)}>기록 수정</Button> : null}
              </article>
            ))}
          </div>
        ) : <p className="text-muted-foreground text-sm">아직 가져온 대출이 없어요.</p>}
      </details>
      {preview && canCreate ? <LoanCaptureReview preview={preview} householdId={householdId} userId={userId} onClose={() => setPreview(null)} onSaved={() => { setPreview(null); setNotice("대출을 저장했어요. 가져온 기록에서 확인할 수 있어요."); }} /> : null}
      {editing && !unavailable && canCreate ? <LoanRecordEditor key={editing.id} item={editing} observedVersion={records.data?.items.find((item) => item.id === editing.id)?.version} householdId={householdId} userId={userId} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
