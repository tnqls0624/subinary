"use client";

import { useEffect, useId, useRef, useState } from "react";
import { loanImportCommitRequestSchema, type LoanImportCommitRequest, type LoanImportPreviewResponse } from "@family/contracts";
import { Button } from "@/components/ui/button";
import { displayManualKrw } from "@/components/manual-finance/model";
import { ConfirmAction, RecordDialog } from "@/components/manual-finance/shared";
import { useAuth } from "@/lib/auth-context";
import { loanImportApi } from "@/lib/loan-import-client";
import { useManualFinanceRefresh } from "@/lib/manual-finance-client";
import { createLoanTaskSession, displayLoanCapturedAt, loanFailureMessage, loanFailureStatus, loanReviewDraft, loanReviewFields, type LoanReviewDraft } from "./model";
import { LoanReviewFields } from "./review-fields";

export function LoanCaptureReview({ preview: initial, householdId, userId, onClose, onSaved }: {
  preview: LoanImportPreviewResponse;
  householdId: string;
  userId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authedFetch } = useAuth();
  const refresh = useManualFinanceRefresh();
  const [preview, setPreview] = useState(initial);
  const [draft, setDraft] = useState(() => loanReviewDraft(initial.existing ?? undefined, initial.capture));
  const [ownAccount, setOwnAccount] = useState(false);
  const [values, setValues] = useState(false);
  const [phase, setPhase] = useState<"idle" | "saving" | "reading">("idle");
  const [recovery, setRecovery] = useState<"retry" | "read" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(createLoanTaskSession());
  const revision = useRef(0);
  const recordId = useRef<string | null>(initial.existing?.id ?? null);
  const attempt = useRef<{ revision: number; body: LoanImportCommitRequest } | null>(null);
  const completed = useRef(false);
  const formId = useId();
  const busy = phase !== "idle";
  const frozen = busy || recovery !== null;
  const changeDraft = (next: LoanReviewDraft) => { ++revision.current; attempt.current = null; setDraft(next); };
  useEffect(() => () => { session.current.invalidate(); attempt.current = null; }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (completed.current || session.current.pending || busy || recovery === "read") return;
    if (!ownAccount || !values) { setError("본인 계좌 여부와 표시된 원금·만기일을 확인해 주세요."); return; }
    if (!attempt.current || attempt.current.revision !== revision.current) {
      recordId.current ??= crypto.randomUUID();
      const result = loanImportCommitRequestSchema.safeParse({
        requestId: crypto.randomUUID(), recordId: recordId.current, householdId,
        expectedVersion: preview.existing?.version ?? null, capture: preview.capture,
        confirmedOwnAccount: true, confirmedValues: true,
        ...loanReviewFields(draft, preview.replacementOptions, userId, householdId),
      });
      if (!result.success) { setError("이름, 가족 공유 동의와 연결할 대출을 확인해 주세요."); return; }
      attempt.current = { revision: revision.current, body: result.data };
    }
    const body = attempt.current.body;
    setPhase("saving"); setError(null);
    await session.current.run(
      (signal) => authedFetch((token) => loanImportApi.commit(token, body, userId, signal)),
      () => { completed.current = true; attempt.current = null; setPhase("idle"); void refresh(true); onSaved(); },
      (failure) => {
        setPhase("idle"); setError(loanFailureMessage(failure));
        const status = loanFailureStatus(failure);
        if (status === 400 || status === 422) { attempt.current = null; setRecovery(null); }
        else setRecovery(status === 409 || status === 403 || status === 404 ? "read" : "retry");
        void refresh(true);
      }
    );
  };
  const reread = async () => {
    if (session.current.pending) return;
    setPhase("reading"); setError(null);
    await session.current.run(
      (signal) => authedFetch((token) => loanImportApi.preview(token, { householdId, capture: preview.capture }, userId, signal)),
      (result) => {
        ++revision.current; attempt.current = null;
        if (result.existing) recordId.current = result.existing.id;
        setPreview(result); setDraft(loanReviewDraft(result.existing ?? undefined, result.capture));
        setOwnAccount(false); setValues(false); setRecovery(null); setPhase("idle");
      },
      () => { setPhase("idle"); setRecovery("read"); setError("저장된 내용을 확인하지 못했어요. 잠시 후 다시 확인해 주세요."); }
    );
  };
  const capture = preview.capture;
  return (
    <RecordDialog title="신한 대출 확인 후 저장" description="저장하기 전에 계좌와 금액을 은행 화면과 비교해 주세요."
      dirty busy={busy} pending={() => session.current.pending} readRequired={recovery !== null}
      invalidate={() => { session.current.invalidate(); attempt.current = null; }} onClose={onClose}
      footer={<Button form={formId} type="submit" className="min-h-11 h-auto w-full whitespace-normal" disabled={busy || recovery === "read" || !ownAccount || !values}>
        {phase === "saving" ? "저장 중…" : recovery === "retry" ? "같은 내용으로 저장 재확인" : preview.existing ? "기존 기록 갱신" : "확인한 대출 저장"}
      </Button>}>
      <section aria-label="가져온 대출 내용" className="bg-muted/40 grid min-w-0 grid-cols-1 gap-2 rounded-xl p-4 text-sm">
        <p className="font-semibold">신한 {capture.loanType === "interim" ? "중도금" : "전세"} 대출 · 끝 {capture.accountLast4}</p>
        <p className="break-all text-lg font-bold tabular-nums">남은 원금 {displayManualKrw(capture.outstandingPrincipalKrw)}</p>
        <p>만기일 {capture.maturityDate ?? "화면에서 확인되지 않음"}</p>
        <p className="text-muted-foreground text-xs">은행 잔액 기준일 미확인</p>
        <details className="min-w-0 text-xs">
          <summary className="text-muted-foreground min-h-11 cursor-pointer py-3">출처·확인 시각</summary>
          <p className="pb-2">신한 인터넷뱅킹 대출계좌조회 화면에서 가져옴</p>
          <p className="pb-2">화면 확인 {displayLoanCapturedAt(capture.capturedAt)} (한국 시간)</p>
          <p className="text-muted-foreground pb-2">화면을 확인한 시각이며, 은행 잔액의 기준시각은 아니에요.</p>
        </details>
        {preview.existing ? <p className="text-xs">같은 계좌의 기존 기록을 갱신해요. 이전 화면 확인: {displayLoanCapturedAt(preview.existing.capturedAt)}</p> : null}
      </section>
      <form id={formId} onSubmit={(event) => void save(event)} noValidate className="grid min-w-0 grid-cols-1 gap-4">
        <fieldset disabled={frozen} className="grid w-full min-w-0 grid-cols-1 gap-2 disabled:opacity-60">
          <label className="flex min-h-11 min-w-0 items-start gap-3 rounded-lg border p-3 text-sm">
            <input type="checkbox" className="mt-1 size-4 shrink-0" checked={ownAccount} onChange={(event) => { ++revision.current; attempt.current = null; setOwnAccount(event.target.checked); }} />
            <span className="min-w-0 flex-1 break-words">내 명의의 대출 계좌이며 계좌 끝 4자리를 확인했어요.</span>
          </label>
          <label className="flex min-h-11 min-w-0 items-start gap-3 rounded-lg border p-3 text-sm">
            <input type="checkbox" className="mt-1 size-4 shrink-0" checked={values} onChange={(event) => { ++revision.current; attempt.current = null; setValues(event.target.checked); }} />
            <span className="min-w-0 flex-1 break-words">은행 화면에서 남은 원금과 만기일을 비교했어요. 만기일이 없으면 확인되지 않은 상태로 저장해요.</span>
          </label>
        </fieldset>
        <p className="text-muted-foreground text-xs">저장한 원금·만기 기록은 서버에 남아요. 나중에 목록에서 제거해도 이전 기록이 지워지지는 않아요.</p>
        <LoanReviewFields draft={draft} onChange={changeDraft} options={preview.replacementOptions} userId={userId} householdId={householdId} disabled={frozen} />
      </form>
      {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
      {recovery ? <ConfirmAction label="저장 상태 확인" title="현재 저장 상태를 다시 확인할까요?" description="합계 반영 방법과 확인 표시를 다시 검토해요. 저장된 요청이 있으면 기존 기록으로 표시돼요." disabled={busy} onConfirm={() => void reread()} /> : null}
      {busy ? <p role="status" className="text-muted-foreground text-sm">{phase === "reading" ? "현재 기록을 다시 확인하고 있어요." : "저장 결과를 확인하고 있어요."}</p> : null}
    </RecordDialog>
  );
}
