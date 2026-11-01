"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { House, Plus } from "lucide-react";
import type {
  ManualFinanceScope,
  ManualHousingPlanResponse,
} from "@family/contracts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import {
  manualFinanceApi,
  useManualHousingPlans,
} from "@/lib/manual-finance-client";
import {
  createManualSaveSession,
  displayManualKrw,
  hideManualSharedEditor,
  manualFinanceCanCreate,
  manualFinanceEditorContext,
  manualEditorUnavailable,
  PAYMENT_LABELS,
  visibilityLabel,
} from "@/components/manual-finance/model";
import {
  FinanceLoading,
  FinanceLoadError,
  LegacyPrivateNotice,
} from "@/components/manual-finance/shared";
import { PlanEditor } from "@/components/manual-finance/plan-editor";

function ScopedPlans({
  householdId,
  scope,
  canCreate,
}: {
  householdId: string;
  scope: ManualFinanceScope;
  canCreate: boolean;
}) {
  const records = useManualHousingPlans(scope);
  const { authedFetch, user } = useAuth();
  const [editor, setEditor] = useState<
    ManualHousingPlanResponse | "new" | null
  >(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const readSession = useRef(createManualSaveSession());
  const abort = useRef<AbortController | null>(null);
  const sharedCacheCleared = hideManualSharedEditor({
    item: editor && editor !== "new" ? editor.item : null,
    actorUserId: user?.id ?? null,
    pending: records.isPending,
    hasData: records.data !== undefined,
  });
  const editorIsUnavailable = Boolean(
    editor &&
      manualEditorUnavailable({
        error: records.error,
        id: editor === "new" ? null : editor.item.id,
        succeeded: records.isSuccess,
        refreshing: records.isFetching,
        visibleIds: records.data?.items.map((item) => item.id) ?? [],
        cacheCleared: sharedCacheCleared,
      })
  );
  useEffect(
    () => () => {
      abort.current?.abort();
      readSession.current.invalidate();
    },
    []
  );
  useEffect(() => {
    if (editorIsUnavailable) {
      setEditor(null);
      setOpenError(
        "계획의 공개 범위나 상태가 바뀌었어요. 목록을 다시 확인해 주세요."
      );
    }
  }, [editorIsUnavailable]);
  const open = async (id: string) => {
    if (readSession.current.pending) return;
    const controller = new AbortController();
    abort.current = controller;
    setOpening(id);
    setOpenError(null);
    await readSession.current.run(
      () =>
        authedFetch((token) =>
          manualFinanceApi.plan(token, householdId, id, controller.signal)
        ),
      (read) => {
        setOpening(null);
        if (read.item.visibility !== scope) {
          setOpenError(
            "공개 범위가 바뀌었어요. 목록을 다시 확인해 주세요."
          );
          void records.refetch();
          return;
        }
        setEditor(read);
      },
      () => {
        setOpening(null);
        setOpenError(
          "계획을 열지 못했어요. 목록에서 다시 선택해 주세요."
        );
        void records.refetch();
      }
    );
  };
  const next = records.data?.summary.nextPayment;
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">주택 납부 일정</h1>
        </div>
        {canCreate && (Boolean(records.data?.items.length) || records.isError) ? (
          <Button
            className="min-h-11 shrink-0"
            disabled={opening !== null}
            onClick={() => setEditor("new")}
          >
            <Plus className="size-4" />
            주택 추가
          </Button>
        ) : null}
      </div>
      {scope === "private" ? <LegacyPrivateNotice href="/plan" /> : null}
      {!canCreate && scope === "household" ? (
        <p role="status" className="text-muted-foreground text-sm">
          현재 권한으로는 조회만 가능해요.
        </p>
      ) : null}
      {records.isPending ? (
        <FinanceLoading />
      ) : records.isError ? (
        <FinanceLoadError
          retry={() => {
            void records.refetch();
          }}
        />
      ) : records.data ? (
        <>
          {next ? <section className="bg-card min-w-0 rounded-2xl border p-5">
            <h2 className="font-semibold">다음 납부</h2>
            <p className="mt-3 break-all text-3xl font-bold tabular-nums">
              {displayManualKrw(next.remainingAmountKrw)}
            </p>
            <p className="mt-2 break-words text-sm">
              {next.label} · {PAYMENT_LABELS[next.kind]}
              {next.installment ? ` ${next.installment}회차` : ""}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              납부일 {next.dueDate} · 이미 낸 금액 제외
            </p>
            {records.data.summary.hasIncompletePayments ? (
              <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                금액·날짜·납부 내역이 비어 있는 항목이 있어요.
              </p>
            ) : null}
          </section> : records.data.items.length > 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              {records.data.summary.hasIncompletePayments ? "금액·날짜·납부 내역이 비어 있는 항목이 있어요. 주택을 선택해 확인해 주세요." : "예정된 납부 일정이 없어요."}
            </p>
          ) : null}
          <section
            className="bg-card min-w-0 rounded-2xl border"
            aria-label="주택 계획 목록"
          >
            {records.data.items.length ? (
              records.data.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={opening !== null}
                  onClick={() => void open(item.id)}
                  className="hover:bg-muted/50 flex min-h-20 w-full min-w-0 items-center gap-3 border-b p-4 text-left last:border-0 disabled:opacity-60"
                  aria-label={`${item.label} 상세`}
                >
                  <House className="text-muted-foreground size-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <strong className="block break-words text-sm">
                      {item.label}
                    </strong>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      입주연도 {item.occupancyYear ?? "미확인"} ·{" "}
                      {item.contractStage || "계약 단계 미입력"}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {visibilityLabel(item.visibility)} · 직접 입력
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-sm">
                    {opening === item.id ? "확인 중…" : "보기 →"}
                  </span>
                </button>
              ))
            ) : (
              <EmptyState
                icon={<House />}
                title="등록한 주택이 없어요"
                description={
                  canCreate
                    ? "계약금·중도금·잔금 일정을 한곳에 기록하세요."
                    : "이 목록에 등록한 주택이 없어요."
                }
                action={
                  canCreate ? (
                    <Button
                      className="min-h-11 w-full"
                      onClick={() => setEditor("new")}
                    >
                      주택 추가
                    </Button>
                  ) : undefined
                }
              />
            )}
          </section>
        </>
      ) : null}
      {opening ? (
        <p role="status" className="text-muted-foreground text-sm">
          납부 일정을 불러오는 중이에요.
        </p>
      ) : null}
      {openError ? (
        <p role="alert" className="text-destructive text-sm">
          {openError}
        </p>
      ) : null}
      <Link
        href={`/assets?scope=${scope}`}
        className="text-primary inline-flex min-h-11 items-center gap-2 text-sm font-medium"
      >
        <span aria-hidden="true">←</span> 자산으로
      </Link>
      <details className="text-muted-foreground text-xs leading-relaxed">
        <summary className="min-h-11 cursor-pointer py-3">납부액 계산 기준</summary>
        <p className="pb-3">입력한 납부 일정에서 이미 낸 금액을 빼서 보여줘요. 통장 잔액과 비교한 부족 금액은 아니에요. 자금 마련 메모는 계산에 반영되지 않으며, 자금 배정이나 현금 흐름 예측은 지원하지 않아요.</p>
        <p className="pb-3">계약금액과 납부액은 자산 합계에 포함하지 않아요. 납부 여부는 입력한 내용에 따른 것이며, 실제 계약이나 이체 내역을 확인한 결과는 아니에요.</p>
      </details>
      {editor && !editorIsUnavailable && (editor !== "new" || canCreate) ? (
        <PlanEditor
          householdId={householdId}
          initial={editor === "new" ? undefined : editor}
          observedVersion={
            editor !== "new"
              ? records.data?.items.find((item) => item.id === editor.item.id)
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
function PlansScreen() {
  const { householdId, activeMembership } = useHousehold();
  const { user } = useAuth();
  const params = useSearchParams();
  const scope: ManualFinanceScope =
    params.get("scope") === "private" ? "private" : "household";
  if (!householdId || !user)
    return (
      <EmptyState
        title="가족을 선택해 주세요"
        description="가족을 선택하면 주택 계획을 볼 수 있어요."
      />
    );
  return (
    <ScopedPlans
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
export default function PlanPage() {
  return (
    <Suspense fallback={<FinanceLoading />}>
      <PlansScreen />
    </Suspense>
  );
}
