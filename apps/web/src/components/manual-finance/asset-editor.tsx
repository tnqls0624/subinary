"use client";

import { useId } from "react";
import type {
  ManualAsset,
  ManualAssetKind,
  ManualAssetResponse,
} from "@family/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import {
  manualFinanceApi,
  useManualFinanceRefresh,
} from "@/lib/manual-finance-client";
import {
  ASSET_LABELS,
  ASSET_VALUE_LABELS,
  assetDraft,
  assetRequest,
  displayManualKrw,
} from "./model";
import { ConfirmAction, RecordDialog, VisibilityField } from "./shared";
import { useRecordEditor } from "./use-record-editor";

export function AssetEditor({
  householdId,
  item,
  observedVersion,
  onChanged,
  onClose,
}: {
  householdId: string;
  item?: ManualAsset;
  observedVersion?: number;
  onChanged: (item: ManualAsset) => void;
  onClose: () => void;
}) {
  const { authedFetch } = useAuth();
  const refresh = useManualFinanceRefresh();
  const formId = useId();
  const editor = useRecordEditor({
    initial: item ? { item } : null,
    observedVersion,
    emptyDraft: () => assetDraft(),
    toDraft: (read: ManualAssetResponse) => assetDraft(read.item),
    validate: (draft, id) => assetRequest(draft, id, householdId),
    save: (body, current) =>
      authedFetch((token) => {
        if (!current) return manualFinanceApi.createAsset(token, body);
        const { id: _id, householdId: _householdId, ...fields } = body;
        return manualFinanceApi.updateAsset(
          token,
          householdId,
          current.item.id,
          { ...fields, expectedVersion: current.item.version }
        );
      }),
    read: (id) =>
      authedFetch((token) => manualFinanceApi.asset(token, householdId, id)),
    remove: (current) =>
      authedFetch((token) =>
        manualFinanceApi.removeAsset(
          token,
          householdId,
          current.item.id,
          current.item.version
        )
      ),
    onChanged: (read) => onChanged(read.item),
    onClose,
    changed: (clear) => {
      void refresh(clear);
    },
  });
  const disabled = editor.busy || editor.readRequired || !editor.canEdit;
  const set = <K extends keyof typeof editor.draft>(
    key: K,
    value: (typeof editor.draft)[K]
  ) => editor.setDraft((old) => ({ ...old, [key]: value }));
  return (
    <RecordDialog
      title={
        editor.current
          ? editor.canEdit
            ? "자산 수정"
            : editor.current.item.visibility === "private"
              ? "비공개 자산"
              : "공유 자산"
          : "자산 추가"
      }
      description="잔액과 금액을 확인한 날짜를 입력해 주세요."
      dirty={editor.dirty}
      busy={editor.busy}
      pending={editor.pending}
      readRequired={editor.readRequired}
      invalidate={editor.invalidate}
      onClose={onClose}
      footer={
        editor.canEdit ? (
          <>
            <Button
              form={formId}
              type="submit"
              className="min-h-11 w-full"
              disabled={disabled}
            >
              {editor.phase === "saving" ? "저장 중…" : "저장"}
            </Button>
            {editor.current ? (
              <ConfirmAction
                label="자산 삭제"
                title="이 자산을 삭제할까요?"
                description="목록과 합계에서 제외돼요. 실제 계좌와 잔액은 그대로예요. 개인정보 전체 삭제와는 달라요."
                destructive
                disabled={disabled}
                onConfirm={() => void editor.remove()}
              />
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            추가한 사람만 수정할 수 있어요.
          </p>
        )
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void editor.save(event)}
        noValidate
        className="grid min-w-0 gap-4"
        aria-busy={editor.busy}
      >
        <label className="grid gap-2 text-sm font-medium">
          종류
          <select
            aria-label="자산 종류"
            disabled={disabled}
            className="bg-background h-11 rounded-md border px-3 font-normal"
            value={editor.draft.kind}
            onChange={(e) => set("kind", e.target.value as ManualAssetKind)}
          >
            {Object.entries(ASSET_LABELS).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-medium">
          이름
          <Input
            className="h-11"
            value={editor.draft.label}
            disabled={disabled}
            maxLength={100}
            autoComplete="off"
            placeholder="예: 생활비 통장"
            onChange={(e) => set("label", e.target.value)}
          />
        </label>
        <label className="grid gap-2 text-sm font-medium">
          {ASSET_VALUE_LABELS[editor.draft.kind]} · 원
          <Input
            className="h-11 tabular-nums"
            value={editor.draft.amount}
            disabled={disabled}
            maxLength={26}
            inputMode="numeric"
            autoComplete="off"
            placeholder="모르면 비워두세요"
            onChange={(e) => set("amount", e.target.value)}
          />
          <span className="text-muted-foreground text-xs font-normal">
            현재 금액을 원 단위로 입력해 주세요. 모르면 비워두세요.
          </span>
        </label>
        <label className="grid gap-2 text-sm font-medium">
          금액 기준일
          <Input
            type="date"
            className="h-11 min-w-0"
            value={editor.draft.asOfDate}
            disabled={disabled}
            onChange={(e) => set("asOfDate", e.target.value)}
          />
          <span className="text-muted-foreground text-xs font-normal">
            금액을 확인한 날짜예요. 금액을 입력하면 꼭 적어주세요.
          </span>
        </label>
        <p className="bg-muted rounded-lg p-3 text-xs">
          출처: {editor.draft.amount.trim() ? "직접 입력" : "금액 미입력"}
        </p>
        <label className="grid gap-2 text-sm font-medium">
          명의자 메모 · 선택
          <Input
            className="h-11"
            value={editor.draft.legalOwnerLabel}
            disabled={disabled}
            maxLength={100}
            autoComplete="off"
            placeholder="미확정이면 비워두세요"
            onChange={(e) => set("legalOwnerLabel", e.target.value)}
          />
          <span className="text-muted-foreground text-xs font-normal">
            참고용 메모예요. 소유권이나 공동 지분을 확인하지는 않아요.
          </span>
        </label>
        <VisibilityField
          value={editor.draft.visibility}
          creating={!editor.current}
        />
        <label className="grid gap-2 text-sm font-medium">
          메모 · 선택
          <textarea
            rows={3}
            maxLength={1000}
            className="bg-background min-h-22 min-w-0 rounded-md border p-3 font-normal"
            value={editor.draft.note}
            disabled={disabled}
            placeholder="전체 계좌번호·카드번호·인증정보는 적지 마세요"
            onChange={(e) => set("note", e.target.value)}
          />
        </label>
        <details className="text-muted-foreground text-xs leading-relaxed">
          <summary className="min-h-11 cursor-pointer py-3">금액 입력 기준</summary>
          <p className="pb-3">통장·현금은 잔액, 적금은 현재 적립액, 주식은 현재 평가액, 대출은 남은 원금을 적어주세요. 만기 예상액이나 대출 한도는 제외해요.</p>
          <p className="pb-3">금액과 날짜는 직접 확인한 원화 기준이에요. 계좌 자동 조회나 외화 환산 없이 입력한 값을 사용해요. 모르는 금액은 비워두고, 실제로 0원일 때만 0을 입력해 주세요.</p>
        </details>
      </form>
      {editor.error ? (
        <p role="alert" className="text-destructive text-sm break-words">
          {editor.error}
        </p>
      ) : null}
      {editor.notice ? (
        <p role="status" className="text-muted-foreground text-sm break-words">
          {editor.notice}
        </p>
      ) : null}
      {editor.busy ? (
        <p role="status" className="text-muted-foreground text-sm">
          {editor.phase === "reading"
            ? "현재 기록을 확인하고 있어요."
            : editor.phase === "removing"
            ? "삭제 결과를 확인하고 있어요."
            : "자산을 저장하고 있어요."}
        </p>
      ) : null}
      {editor.readRequired ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 h-auto whitespace-normal"
          disabled={editor.busy}
          onClick={() => void editor.read()}
        >
          저장 상태 확인
        </Button>
      ) : null}
      {editor.latest ? (
        <section className="bg-muted grid gap-2 rounded-lg p-3 text-sm">
          <h3 className="font-semibold">현재 저장된 기록</h3>
          <p className="break-words">
            {editor.latest.item.label} · {ASSET_LABELS[editor.latest.item.kind]}
          </p>
          <p className="break-all tabular-nums">
            {displayManualKrw(editor.latest.item.amount)} · 기준일{" "}
            {editor.latest.item.asOfDate ?? "미입력"}
          </p>
          <ConfirmAction
            label="저장된 내용 불러오기"
            title="저장된 내용으로 바꿀까요?"
            description="지금 입력한 내용은 사라지고, 최신 저장 내용으로 바뀌어요."
            disabled={editor.busy}
            onConfirm={editor.resetLatest}
          />
        </section>
      ) : null}
    </RecordDialog>
  );
}
