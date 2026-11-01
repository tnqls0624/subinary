"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Building2, CreditCard, House, Plus } from "lucide-react";
import type {
  ManualAsset,
  ManualAssetKind,
  ManualFinanceScope,
} from "@family/contracts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { manualFinanceApi, useManualAssets } from "@/lib/manual-finance-client";
import { useFinancialOverview } from "@/lib/loan-import-client";
import { LoanOverviewRow } from "@/components/loan-import/loan-rows";
import {
  ASSET_LABELS,
  ASSET_VALUE_LABELS,
  createManualSaveSession,
  displayManualKrw,
  hideManualSharedEditor,
  manualFinanceCanCreate,
  manualFinanceEditorContext,
  manualEditorUnavailable,
  visibilityLabel,
} from "@/components/manual-finance/model";
import {
  FinanceLoading,
  FinanceLoadError,
  LegacyPrivateNotice,
} from "@/components/manual-finance/shared";
import { ManualAssetsSummary } from "@/components/manual-finance/asset-summary";
import { AssetEditor } from "@/components/manual-finance/asset-editor";

function ScopedAssets({
  householdId,
  scope,
  canCreate,
}: {
  householdId: string;
  scope: ManualFinanceScope;
  canCreate: boolean;
}) {
  const records = useManualAssets(scope);
  const overview = useFinancialOverview(scope);
  const { authedFetch, user } = useAuth();
  const [kind, setKind] = useState<ManualAssetKind | "all">("all");
  const [editor, setEditor] = useState<ManualAsset | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const readSession = useRef(createManualSaveSession());
  const abort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abort.current?.abort();
      readSession.current.invalidate();
    },
    []
  );
  const open = async (id: string) => {
    if (readSession.current.pending) return;
    const controller = new AbortController();
    abort.current = controller;
    setOpening(id);
    setNotice(null);
    await readSession.current.run(
      () =>
        authedFetch((token) =>
          manualFinanceApi.asset(token, householdId, id, controller.signal)
        ),
      (read) => {
        setOpening(null);
        if (read.item.visibility !== scope) {
          setNotice(
            "공개 범위가 바뀌었어요. 목록을 다시 확인해 주세요."
          );
          void records.refetch();
          return;
        }
        setEditor(read.item);
      },
      () => {
        setOpening(null);
        setNotice(
          "자산 정보를 열지 못했어요. 목록에서 다시 선택해 주세요."
        );
        void records.refetch();
      }
    );
  };
  const items =
    overview.data?.manualItems.filter(
      (item) => kind === "all" || item.kind === kind
    ) ?? [];
  const importedLoans = kind === "all" || kind === "loan"
    ? overview.data?.loanItems ?? []
    : [];
  const hasRecords = Boolean(overview.data && (overview.data.manualItems.length || overview.data.loanItems.length));
  const replacedManualIds = new Set(
    overview.data?.loanItems
      .filter((item) => item.includedInTotals && item.totalMode === "replacement")
      .map((item) => item.replacesManualAssetId) ?? []
  );
  const sharedCacheCleared = hideManualSharedEditor({
    item: editor && editor !== "new" ? editor : null,
    actorUserId: user?.id ?? null,
    pending: records.isPending,
    hasData: records.data !== undefined,
  });
  const editorIsUnavailable = Boolean(
    editor &&
      manualEditorUnavailable({
        error: records.error,
        id: editor === "new" ? null : editor.id,
        succeeded: records.isSuccess,
        refreshing: records.isFetching,
        visibleIds: records.data?.items.map((item) => item.id) ?? [],
        cacheCleared: sharedCacheCleared,
      })
  );
  useEffect(() => {
    if (editorIsUnavailable) {
      setEditor(null);
      setNotice(
        "자산의 공개 범위나 상태가 바뀌었어요. 목록을 다시 확인해 주세요."
      );
    }
  }, [editorIsUnavailable]);
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">자산</h1>
        </div>
        {canCreate && (hasRecords || overview.isError) ? (
          <Button
            className="min-h-11 shrink-0"
            disabled={opening !== null}
            onClick={() => setEditor("new")}
          >
            <Plus className="size-4" />
            자산 추가
          </Button>
        ) : null}
      </div>
      {scope === "private" ? <LegacyPrivateNotice href="/assets" /> : null}
      {!canCreate && scope === "household" ? (
        <p role="status" className="text-muted-foreground text-sm">
          현재 권한으로는 조회만 가능해요.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-muted-foreground text-sm">
          {notice}
        </p>
      ) : null}
      {overview.isPending ? (
        <FinanceLoading />
      ) : overview.isError ? (
        <FinanceLoadError
          retry={() => {
            void overview.refetch();
          }}
        />
      ) : overview.data ? (
        <>
          {hasRecords ? (
            <ManualAssetsSummary
              summary={overview.data.summary}
              scope={scope}
              hasImportedBalance={overview.data.loanItems.some((item) => item.includedInTotals)}
              sourceLabel={overview.data.loanItems.some((item) => item.includedInTotals) ? "직접 입력·신한 대출 파일" : "직접 입력"}
            />
          ) : null}
          {overview.data.unresolvedLoans > 0 ? (
            <p role="status" className="text-muted-foreground text-sm">확인이 필요한 대출 {overview.data.unresolvedLoans}건은 합계에서 제외했어요. 아래 대출의 반영 상태를 확인해 주세요.</p>
          ) : null}
          {hasRecords ? <div
            role="group"
            aria-label="자산 종류 필터"
            className="flex flex-wrap gap-2"
          >
            {(
              [["all", "전체"], ...Object.entries(ASSET_LABELS)] as Array<
                [ManualAssetKind | "all", string]
              >
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={kind === value ? "default" : "outline"}
                className="min-h-11"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {label}
              </Button>
            ))}
          </div> : null}
          <section
            className="bg-card min-w-0 rounded-2xl border"
            aria-label="자산 목록"
          >
            {items.length || importedLoans.length ? (
              <>
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  disabled={opening !== null}
                  className="hover:bg-muted/50 flex min-h-20 w-full min-w-0 items-start justify-between gap-3 border-b p-4 text-left last:border-0 disabled:opacity-60"
                  onClick={() => void open(item.id)}
                  aria-label={`${item.label} 상세`}
                >
                  <span className="min-w-0 flex-1">
                    <strong className="block break-words text-sm">
                      {item.label}
                    </strong>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {ASSET_LABELS[item.kind]} ·{" "}
                      {visibilityLabel(item.visibility)}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      기준일 {item.asOfDate ?? "미입력"} ·{" "}
                      {item.source === "manual" ? "직접 입력" : "출처 미입력"}
                    </span>
                    {replacedManualIds.has(item.id) ? (
                      <span className="text-muted-foreground mt-2 block text-xs">새로 가져온 대출로 대체 · 합계 제외</span>
                    ) : null}
                  </span>
                  <span className="min-w-0 max-w-[52%] text-right">
                    <strong className={`block break-all text-base tabular-nums ${replacedManualIds.has(item.id) ? "text-muted-foreground font-medium" : ""}`}>
                      {displayManualKrw(item.amount)}
                    </strong>
                    <small className="text-muted-foreground text-xs">
                      {ASSET_VALUE_LABELS[item.kind]}
                      {opening === item.id ? " · 확인 중" : ""}
                    </small>
                  </span>
                </button>
              ))}
              {importedLoans.map((item) => <LoanOverviewRow key={item.id} item={item} />)}
              </>
            ) : (
              <EmptyState
                icon={<Building2 />}
                title={
                  !hasRecords
                    ? "등록된 자산이 없어요"
                    : "이 종류의 자산이 없어요"
                }
                description={
                  canCreate
                    ? hasRecords ? "다른 종류를 선택하거나 자산을 추가해 보세요." : "통장 잔액이나 대출부터 기록해 보세요."
                    : "현재 선택한 목록에 자산이 없어요."
                }
                action={
                  canCreate && !hasRecords ? (
                    <Button
                      className="min-h-11 w-full"
                      disabled={opening !== null}
                      onClick={() => setEditor("new")}
                    >
                      자산 추가
                    </Button>
                  ) : undefined
                }
              />
            )}
          </section>
          {overview.isFetching ? (
            <p role="status" className="text-muted-foreground text-xs">
              자산 정보를 새로 불러오는 중이에요.
            </p>
          ) : null}
        </>
      ) : null}
      {opening ? (
        <p role="status" className="text-muted-foreground text-sm">
          자산 정보를 여는 중이에요.
        </p>
      ) : null}
      <section className="bg-card divide-y rounded-2xl border" aria-label="자산 관리">
      <Link
        href="/assets/loan-import"
        className="hover:bg-muted/50 flex min-h-14 items-center gap-3 p-4 text-sm font-medium"
      >
        <Building2 className="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block">신한 대출 파일 가져오기</span>
          <span className="text-muted-foreground mt-1 block text-xs font-normal">전세·중도금 대출 기록 관리</span>
        </span>
        <span className="text-muted-foreground" aria-hidden="true">→</span>
      </Link>
      <Link
        href="/plan"
        className="hover:bg-muted/50 flex min-h-14 items-center gap-3 p-4 text-sm font-medium"
      >
        <House className="size-5" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block">주택 납부 일정</span>
          <span className="text-muted-foreground mt-1 block text-xs font-normal">계약금·중도금·잔금 일정</span>
        </span>
        <span className="text-muted-foreground" aria-hidden="true">→</span>
      </Link>
      <Link
        href="/cards"
        className="hover:bg-muted/50 flex min-h-14 items-center gap-3 p-4 text-sm font-medium"
      >
        <CreditCard className="size-5" />
        결제 카드 관리
        <span className="text-muted-foreground ml-auto" aria-hidden="true">→</span>
      </Link>
      </section>
      <details className="text-muted-foreground text-xs leading-relaxed">
        <summary className="min-h-11 cursor-pointer py-3">자산 합계 기준</summary>
        <p className="pb-3">직접 입력한 금액과 합계 반영을 선택한 신한 대출을 합산해요. 기존 대출과 연결한 경우 가져온 원금만 반영해요. 참고용·중복·연결 확인이 필요한 대출과 카드 한도·주택 계약금액·적금 만기 예상액은 제외해요.</p>
        <p className="pb-3">가져온 대출은 브라우저에서 확인한 시점의 남은 원금이에요. 은행의 별도 금액 기준일은 제공되지 않아요. 계좌 자동 조회와 외화 환산은 지원하지 않아요.</p>
      </details>
      {editor && !editorIsUnavailable && (editor !== "new" || canCreate) ? (
        <AssetEditor
          householdId={householdId}
          item={editor === "new" ? undefined : editor}
          observedVersion={
            editor !== "new"
              ? records.data?.items.find((item) => item.id === editor.id)
                  ?.version
              : undefined
          }
          onClose={() => setEditor(null)}
          onChanged={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}
function AssetsScreen() {
  const { householdId, activeMembership } = useHousehold();
  const { user } = useAuth();
  const params = useSearchParams();
  const scope: ManualFinanceScope =
    params.get("scope") === "private" ? "private" : "household";
  if (!householdId || !user)
    return (
      <EmptyState
        title="가족을 선택해 주세요"
        description="가족을 선택하면 자산 목록을 볼 수 있어요."
      />
    );
  return (
    <ScopedAssets
      key={manualFinanceEditorContext(
        user.id,
        householdId,
        scope,
        activeMembership?.role
      )}
      householdId={householdId}
      scope={scope}
      canCreate={manualFinanceCanCreate(activeMembership?.role, scope)}
    />
  );
}
export default function AssetsPage() {
  return (
    <Suspense fallback={<FinanceLoading />}>
      <AssetsScreen />
    </Suspense>
  );
}
