"use client";
/**
 * 주택 납부 일정(자산 탭 › 주택 납부 일정).
 * 2026-11-05 HIG 검수 4단계: 대표 금액 text-display, 날짜는 'M월 D일', 줄은 ListRow(›),
 * 줄마다 붙던 '가족 공개 · 직접 입력'은 지웠다(§8: 모든 기록은 가족 공개).
 * 여는 중·실패 문구는 화면 맨 아래가 아니라 누른 줄 바로 아래에 붙인다 — 맨 아래에서는 누른 자리에서 보이지 않았다.
 * 여는 중에도 누른 버튼은 그대로 둔다(끄거나 div로 바꾸면 포커스가 body로 떨어지고, 창을 닫을 때 돌아갈 곳이 없다).
 * 겹친 요청은 open()의 pending 검사가 막는다.
 * 2026-11-08: 주택을 누르면 편집 권한이 있어도 상세 시트가 먼저 열린다(PlanEditor — '보기 먼저').
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronRight, House, Plus } from "lucide-react";
import type {
  ManualFinanceScope,
  ManualHousingPlanResponse,
} from "@family/contracts";
import { Button } from "@/components/ui/button";
import { PageBackHeader } from "@/components/widgets/page-back-header";
import { EmptyState } from "@/components/widgets/empty-state";
import { ErrorState } from "@/components/widgets/error-state";
import { InlineNotice } from "@/components/widgets/inline-notice";
import { ListRow } from "@/components/widgets/list-row";
import { useAuth } from "@/lib/auth-context";
import { formatMonthDay } from "@/lib/format";
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
} from "@/components/manual-finance/model";
import {
  FinanceLoading,
  LegacyPrivateNotice,
} from "@/components/manual-finance/shared";
import { PlanEditor } from "@/components/manual-finance/plan-editor";
import { planRowSubtitle } from "@/components/manual-finance/plan-rows";
import { housingPaymentName } from "@/components/manual-finance/plan-summary";

/** 어디서 눌렀나 — 같은 계획이 '다음 납부' 카드와 목록에 함께 있어서, 알림을 누른 쪽에 붙인다. */
type Spot = "next" | "list";

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
  const [opening, setOpening] = useState<{ id: string; spot: Spot } | null>(
    null
  );
  const [openError, setOpenError] = useState<{
    id: string | null;
    spot: Spot;
    message: string;
  } | null>(null);
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
      setOpenError({
        id: null,
        spot: "list",
        message:
          "주택의 공개 범위나 상태가 바뀌었어요. 목록을 다시 확인해 주세요.",
      });
    }
  }, [editorIsUnavailable]);
  const open = async (id: string, spot: Spot) => {
    if (readSession.current.pending) return;
    const controller = new AbortController();
    abort.current = controller;
    setOpening({ id, spot });
    setOpenError(null);
    await readSession.current.run(
      () =>
        authedFetch((token) =>
          manualFinanceApi.plan(token, householdId, id, controller.signal)
        ),
      (read) => {
        setOpening(null);
        if (read.item.visibility !== scope) {
          setOpenError({
            id,
            spot,
            message: "공개 범위가 바뀌었어요. 목록을 다시 불러왔어요.",
          });
          void records.refetch();
          return;
        }
        setEditor(read);
      },
      () => {
        setOpening(null);
        setOpenError({
          id,
          spot,
          message: "납부 일정을 열지 못했어요. 다시 눌러 주세요.",
        });
        void records.refetch();
      }
    );
  };
  const next = records.data?.summary.nextPayment;
  const items = records.data?.items ?? [];
  // 누른 줄이 목록에서 사라졌으면(새로 불러온 뒤) 알림은 목록 맨 위로 옮긴다.
  const placed =
    openError?.id != null &&
    (openError.spot === "next"
      ? next?.planId === openError.id
      : items.some((item) => item.id === openError.id));
  const noticeAt = (id: string, spot: Spot) =>
    openError && placed && openError.id === id && openError.spot === spot ? (
      <InlineNotice tone="error" className="mt-2">
        {openError.message}
      </InlineNotice>
    ) : null;
  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl space-y-5">
      <PageBackHeader
        title="주택 납부 일정"
        backHref={`/assets?scope=${scope}`}
        action={
          canCreate && (Boolean(records.data?.items.length) || records.isError) ? (
            <Button variant="ghost" size="icon" className="-mr-2" aria-label="주택 추가하기" disabled={opening !== null} onClick={() => setEditor("new")}>
              <Plus />
            </Button>
          ) : null
        }
      />
      {/* 여는 중은 누른 줄의 글자로 보이고, 화면 읽기 프로그램에는 이 한 줄로 알린다. */}
      <span role="status" className="sr-only">
        {opening ? "납부 일정을 여는 중이에요." : ""}
      </span>
      {scope === "private" ? <LegacyPrivateNotice href="/plan" /> : null}
      {!canCreate && scope === "household" ? (
        <p className="text-caption text-muted-foreground">
          지금 권한으로는 볼 수만 있어요.
        </p>
      ) : null}
      {records.isPending ? (
        <FinanceLoading />
      ) : records.isError ? (
        <ErrorState
          message="주택 목록을 불러오지 못했어요."
          onRetry={() => {
            void records.refetch();
          }}
          retrying={records.isFetching}
        />
      ) : records.data ? (
        <>
          {next ? (
            <section
              className="finance-panel min-w-0 p-5"
              aria-labelledby="plan-next-heading"
            >
              <h2
                id="plan-next-heading"
                className="text-caption text-muted-foreground font-semibold"
              >
                다음 납부
              </h2>
              <p className="text-display mt-2 tabular-nums [overflow-wrap:anywhere]">
                {displayManualKrw(next.remainingAmountKrw)}
              </p>
              <p className="text-body mt-2 break-words">
                {/* 일정 이름은 상세 시트와 같은 함수 — 금액·날짜는 서버 요약(같은 summarizeManualHousingPlans)이다. */}
                {next.label} ·{" "}
                {housingPaymentName({
                  kind: next.kind,
                  installment: next.installment,
                })}
              </p>
              <p className="text-caption text-muted-foreground mt-1">
                {formatMonthDay(next.dueDate)} 납부 · 이미 낸 금액은 뺐어요
              </p>
              {records.data.summary.hasIncompletePayments ? (
                <p className="text-caption text-muted-foreground mt-3">
                  금액·날짜·납부 내역이 비어 있는 항목이 있어요.
                </p>
              ) : null}
              <button
                type="button"
                className="text-body text-primary mt-4 -mb-2 flex min-h-11 w-full items-center justify-between gap-2 border-t pt-2 text-left font-medium active:opacity-60"
                onClick={() => void open(next.planId, "next")}
              >
                {opening?.id === next.planId && opening.spot === "next"
                  ? "여는 중…"
                  : "이 주택의 납부 일정 보기"}
                <ChevronRight className="size-5 shrink-0" aria-hidden="true" />
              </button>
              {noticeAt(next.planId, "next")}
            </section>
          ) : items.length > 0 ? (
            <p className="text-body text-muted-foreground" role="status">
              {records.data.summary.hasIncompletePayments
                ? "금액·날짜·납부 내역이 비어 있는 항목이 있어요. 주택을 눌러 확인해 주세요."
                : "예정된 납부 일정이 없어요."}
            </p>
          ) : null}
          <section
            className="finance-panel min-w-0 px-4 py-1"
            aria-label="주택 목록"
          >
            {openError && !placed ? (
              <InlineNotice tone="error" className="my-3">
                {openError.message}
              </InlineNotice>
            ) : null}
            {items.length ? (
              <ul className="divide-border/60 divide-y">
                {items.map((item) => (
                  <li key={item.id} className="min-w-0 py-1">
                    <ListRow
                      icon={<House />}
                      title={item.label}
                      subtitle={
                        opening?.id === item.id && opening.spot === "list"
                          ? "여는 중…"
                          : planRowSubtitle(item)
                      }
                      onClick={() => void open(item.id, "list")}
                      chevron
                    />
                    {noticeAt(item.id, "list")}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<House />}
                title="등록한 주택이 없어요"
                description={
                  canCreate
                    ? "계약금·중도금·잔금 일정을 한곳에 적어 둘 수 있어요."
                    : undefined
                }
                action={
                  canCreate ? (
                    <Button
                      className="min-h-11 w-full"
                      onClick={() => setEditor("new")}
                    >
                      주택 추가하기
                    </Button>
                  ) : undefined
                }
              />
            )}
          </section>
        </>
      ) : null}
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
        description="가족을 선택하면 주택 납부 일정을 볼 수 있어요."
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
