"use client";

import type { ManualAsset } from "@family/contracts";
import { Input } from "@/components/ui/input";
import { displayManualKrw } from "@/components/manual-finance/model";
import { LOAN_TOTAL_LABELS, matchingReplacementOptions, type LoanReviewDraft } from "./model";

export function LoanReviewFields({ draft, onChange, options, userId, householdId, disabled = false }: {
  draft: LoanReviewDraft;
  onChange: (draft: LoanReviewDraft) => void;
  options: ManualAsset[];
  userId: string;
  householdId: string;
  disabled?: boolean;
}) {
  const choices = matchingReplacementOptions(options, userId, householdId, draft.visibility);
  return (
    <fieldset disabled={disabled} className="grid w-full min-w-0 grid-cols-1 gap-4 disabled:opacity-60">
      <label className="grid min-w-0 grid-cols-1 gap-2 text-sm font-medium">
        대출 이름
        <Input className="h-11" value={draft.label} maxLength={100} autoComplete="off"
          onChange={(event) => onChange({ ...draft, label: event.target.value })} />
      </label>
      <label className="grid min-w-0 grid-cols-1 gap-2 text-sm font-medium">
        가족 공유
        <select className="bg-background min-h-11 w-full min-w-0 max-w-full rounded-md border px-3 font-normal" value={draft.visibility}
          onChange={(event) => onChange({ ...draft, visibility: event.target.value as LoanReviewDraft["visibility"], confirmedSharing: false, replacesManualAssetId: "" })}>
          <option value="private">가족에게 공유하지 않음</option>
          <option value="household">가족과 공유</option>
        </select>
      </label>
      {draft.visibility === "household" ? (
        <label className="flex min-h-11 min-w-0 items-start gap-3 rounded-lg border p-3 text-sm">
          <input type="checkbox" className="mt-1 size-4 shrink-0" checked={draft.confirmedSharing}
            onChange={(event) => onChange({ ...draft, confirmedSharing: event.target.checked })} />
          <span className="min-w-0 flex-1 break-words">선택한 가족의 모든 구성원에게 대출 이름, 계좌 끝 4자리, 남은 원금, 만기일과 확인 시각을 공유하는 데 동의해요.</span>
        </label>
      ) : <p className="text-muted-foreground text-xs">이 기록은 가족에게 공유되지 않고, 가족 자산 합계에 들어가지 않아요.</p>}
      <label className="grid min-w-0 grid-cols-1 gap-2 text-sm font-medium">
        합계에 반영하는 방법
        <select className="bg-background min-h-11 w-full min-w-0 max-w-full rounded-md border px-3 font-normal" value={draft.totalMode}
          onChange={(event) => onChange({ ...draft, totalMode: event.target.value as LoanReviewDraft["totalMode"], replacesManualAssetId: "" })}>
          {Object.entries(LOAN_TOTAL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {draft.totalMode === "reference" ? <p className="text-muted-foreground text-xs">기록만 보관하고 자산 합계에는 넣지 않아요. 나중에 바꿀 수 있어요.</p> : null}
      {draft.totalMode === "distinct" ? <p className="text-muted-foreground text-xs">같은 대출을 직접 입력해 뒀다면 중복으로 계산될 수 있어요. 그때는 ‘기존 수동 대출 대신 합산’을 선택해 주세요.</p> : null}
      {draft.totalMode === "replacement" ? (
        <label className="grid min-w-0 grid-cols-1 gap-2 text-sm font-medium">
          연결할 기존 대출
          <select className="bg-background min-h-11 w-full min-w-0 max-w-full rounded-md border px-3 font-normal" value={draft.replacesManualAssetId}
            onChange={(event) => onChange({ ...draft, replacesManualAssetId: event.target.value })}>
            <option value="">기존 대출 선택</option>
            {choices.map((item) => <option key={item.id} value={item.id}>{item.label} · {displayManualKrw(item.amount)}</option>)}
          </select>
          <span className="text-muted-foreground text-xs font-normal">내가 직접 입력했고 가족 공유 설정이 같은 대출만 선택할 수 있어요. 기존 기록은 남기고, 가져온 원금만 합계에 넣어요.</span>
          {choices.length === 0 ? <span className="text-muted-foreground text-xs font-normal">연결할 대출이 없어요. 참고용으로 저장하거나 가족 공유 설정을 확인해 주세요.</span> : null}
        </label>
      ) : null}
    </fieldset>
  );
}
