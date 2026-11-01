"use client";

import { useEffect, useId, useRef, useState } from "react";
import { loanImportUpdateRequestSchema, type ImportedLoanRecord, type ManualAsset } from "@family/contracts";
import { Button } from "@/components/ui/button";
import { ConfirmAction, RecordDialog } from "@/components/manual-finance/shared";
import { displayManualKrw } from "@/components/manual-finance/model";
import { useAuth } from "@/lib/auth-context";
import { loanImportApi } from "@/lib/loan-import-client";
import { manualFinanceApi, useManualFinanceRefresh } from "@/lib/manual-finance-client";
import { createLoanTaskSession, displayLoanCapturedAt, loanFailureMessage, loanReviewDraft, loanReviewFields } from "./model";
import { LoanReviewFields } from "./review-fields";

export function LoanRecordEditor({ item, observedVersion, householdId, userId, onClose }: {
  item: ImportedLoanRecord;
  observedVersion?: number;
  householdId: string;
  userId: string;
  onClose: () => void;
}) {
  const { authedFetch } = useAuth();
  const refresh = useManualFinanceRefresh();
  const [current, setCurrent] = useState(item);
  const [draft, setDraft] = useState(() => loanReviewDraft(item));
  const [options, setOptions] = useState<ManualAsset[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState(false);
  const [optionsEpoch, setOptionsEpoch] = useState(0);
  const [phase, setPhase] = useState<"idle" | "saving" | "removing" | "reading">("idle");
  const [readRequired, setReadRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(createLoanTaskSession());
  const completed = useRef(false);
  const optionsSession = useRef(createLoanTaskSession());
  const formId = useId();
  const busy = phase !== "idle";
  const changedElsewhere = observedVersion !== undefined && observedVersion > current.version;
  const disabled = busy || readRequired || changedElsewhere || !current.canEdit;
  const invalidate = () => { session.current.invalidate(); optionsSession.current.invalidate(); };

  useEffect(() => () => { session.current.invalidate(); optionsSession.current.invalidate(); }, []);
  useEffect(() => {
    const reader = optionsSession.current;
    reader.invalidate();
    setOptions([]); setOptionsLoading(true); setOptionsError(false);
    void reader.run(
      (signal) => authedFetch((token) => manualFinanceApi.listAssets(token, householdId, draft.visibility, signal, userId)),
      (result) => { setOptions(result.items); setOptionsLoading(false); },
      () => { setOptionsError(true); setOptionsLoading(false); }
    );
    return () => reader.invalidate();
  }, [authedFetch, householdId, userId, draft.visibility, optionsEpoch]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (completed.current || disabled || session.current.pending || optionsLoading || optionsError) return;
    const parsed = loanImportUpdateRequestSchema.safeParse({ expectedVersion: current.version, ...loanReviewFields(draft, options, userId, householdId) });
    if (!parsed.success) { setError("이름, 가족 공유 동의와 연결할 대출을 확인해 주세요."); return; }
    setPhase("saving"); setError(null);
    await session.current.run(
      (signal) => authedFetch((token) => loanImportApi.update(token, householdId, userId, current.id, parsed.data, signal)),
      () => { completed.current = true; setPhase("idle"); void refresh(true); onClose(); },
      (failure) => { setPhase("idle"); setReadRequired(true); setError(loanFailureMessage(failure)); void refresh(true); }
    );
  };
  const remove = async () => {
    if (completed.current || disabled || session.current.pending) return;
    setPhase("removing"); setError(null);
    await session.current.run(
      async (signal) => {
        const result = await authedFetch((token) => loanImportApi.remove(token, householdId, current.id, current.version, signal));
        if (!result.deleted) throw new Error("delete unconfirmed");
        return result;
      },
      () => { completed.current = true; setPhase("idle"); void refresh(true); onClose(); },
      (failure) => { setPhase("idle"); setReadRequired(true); setError(loanFailureMessage(failure)); void refresh(true); }
    );
  };
  const reread = async () => {
    if (session.current.pending) return;
    setPhase("reading"); setError(null);
    await session.current.run(
      (signal) => authedFetch((token) => loanImportApi.records(token, householdId, userId, signal)),
      (result) => {
        const found = result.items.find((record) => record.id === current.id);
        setPhase("idle"); void refresh(true);
        if (!found || !found.canEdit) { onClose(); return; }
        setCurrent(found); setDraft(loanReviewDraft(found)); setReadRequired(false); setOptionsEpoch((value) => value + 1);
      },
      () => { setPhase("idle"); setReadRequired(true); setError("저장된 내용을 확인하지 못했어요. 잠시 후 다시 불러와 주세요."); }
    );
  };
  return (
    <RecordDialog title="대출 기록 수정" description="이 앱에 저장한 이름·가족 공유·합계 반영 방법을 바꿔요. 원금과 만기일은 새 파일로 갱신할 수 있어요."
      dirty={JSON.stringify(draft) !== JSON.stringify(loanReviewDraft(current))}
      busy={busy} pending={() => session.current.pending} readRequired={readRequired || changedElsewhere}
      invalidate={invalidate} onClose={onClose}
      footer={<>
        <Button form={formId} type="submit" className="min-h-11 w-full" disabled={disabled || optionsLoading || optionsError}> {phase === "saving" ? "저장 중…" : "변경 저장"}</Button>
        <ConfirmAction label="목록에서 제거" title="이 대출을 목록에서 제거할까요?"
          description="목록·공유·합계에서 제외해요. 이전 원금·만기 기록은 서버에 남아요. 직접 입력한 대출과 은행 계좌는 그대로이며, 연결했던 대출은 합계에 다시 반영될 수 있어요."
          destructive disabled={disabled} onConfirm={() => void remove()} />
      </>}>
      <section className="bg-muted/40 grid min-w-0 grid-cols-1 gap-1 rounded-lg p-3 text-sm">
        <p>{current.loanType === "interim" ? "중도금 대출" : "전세 대출"} · 계좌 끝 {current.accountLast4}</p>
        <p className="break-all font-semibold tabular-nums">남은 원금 {displayManualKrw(current.outstandingPrincipalKrw)}</p>
        <p>만기일 {current.maturityDate ?? "확인되지 않음"}</p>
        <p className="text-muted-foreground text-xs">은행 잔액 기준일 미확인</p>
        <details className="min-w-0 text-xs">
          <summary className="text-muted-foreground min-h-11 cursor-pointer py-3">출처·확인 시각</summary>
          <p className="text-muted-foreground pb-2">신한은행 대출계좌조회 화면에서 가져옴</p>
          <p className="text-muted-foreground pb-2">화면 확인 {displayLoanCapturedAt(current.capturedAt)} (한국 시간)</p>
        </details>
      </section>
      <form id={formId} onSubmit={(event) => void save(event)} className="grid min-w-0 grid-cols-1 gap-4" noValidate>
        <LoanReviewFields draft={draft} onChange={setDraft} options={options} userId={userId} householdId={householdId} disabled={disabled} />
      </form>
      {optionsLoading ? <p role="status" className="text-muted-foreground text-xs">연결할 수동 대출을 확인하고 있어요.</p> : null}
      {optionsError ? <div role="alert" className="grid gap-2 text-sm"><p>연결할 수동 대출을 불러오지 못했어요.</p><Button variant="outline" onClick={() => setOptionsEpoch((value) => value + 1)}>다시 불러오기</Button></div> : null}
      {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
      {changedElsewhere ? <p role="status" className="text-sm">다른 곳에서 이 기록이 바뀌었어요. 저장된 내용을 불러와 주세요.</p> : null}
      {readRequired || changedElsewhere ? <ConfirmAction label="저장된 내용 불러오기" title="저장된 내용으로 다시 열까요?" description="지금 수정한 내용은 사라지고 최신 저장 내용으로 바뀌어요." disabled={busy} onConfirm={() => void reread()} /> : null}
      {busy ? <p role="status" className="text-muted-foreground text-sm">{phase === "reading" ? "저장된 내용을 확인하고 있어요." : phase === "removing" ? "제거 결과를 확인하고 있어요." : "변경 내용을 저장하고 있어요."}</p> : null}
    </RecordDialog>
  );
}
