"use client";

/**
 * 주택 상세 시트 — 저장된 주택을 누르면 편집 권한이 있어도 이것이 먼저 열린다(2026-11-08 PO 재설계 '보기 먼저').
 * 예전에는 권한이 있으면 바로 긴 입력 폼이 열려 보기와 고치기가 섞였다(사용자: 'UI/UX가 너무 복잡해 보여').
 * 위에서부터: 이름·부제 → 남은 금액 요약(다음 납부) → 수자인 줄(가져오기·결과) → 납부 일정(분양대금/옵션) → 수정하기.
 * 일정 줄마다 붙던 출처·기준 시각·'낸 금액 출처'는 지웠다 — 수자인 줄 하나가 대신 말한다.
 * 창 모양 표의 '시트'(RecordSheet = BottomSheet). 수정하기는 이 시트를 닫고 입력 폼을 연다(창을 겹치지 않는다).
 * 목록에 더 새 version 이 보이면 스스로 다시 읽는다 — 예전 폼의 '현재 기록 확인'이 하던 일이다.
 */

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ManualHousingPlanResponse } from "@family/contracts";
import { Button } from "@/components/ui/button";
import { FieldList, FieldRow } from "@/components/widgets/field-row";
import { StatusChip } from "@/components/widgets/status-chip";
import { useAuth } from "@/lib/auth-context";
import {
  manualFinanceApi,
  useManualFinanceRefresh,
} from "@/lib/manual-finance-client";
import { useHouseholdMembers } from "@/lib/queries";
import { HousingBrandPanel } from "./housing-brand-panel";
import { displayManualKrw } from "./model";
import { planRowSubtitle } from "./plan-rows";
import {
  groupPlanPayments,
  mergePlanRead,
  nextPaymentLine,
  paymentRowView,
  planMoneySummary,
  planNextPayment,
  planSummaryLines,
  type PlanPaymentRow,
} from "./plan-summary";
import { RecordSheet } from "./shared";

type Payment = ManualHousingPlanResponse["payments"][number];

export function PlanDetailSheet({
  householdId,
  plan,
  observedVersion,
  onPlanChange,
  onEdit,
  onClose,
}: {
  householdId: string;
  plan: ManualHousingPlanResponse;
  /** 목록이 본 이 주택의 version. 시트의 것보다 크면 다시 읽는다. */
  observedVersion?: number;
  onPlanChange: Dispatch<SetStateAction<ManualHousingPlanResponse>>;
  /** 편집 권한이 있을 때만 쓰인다. */
  onEdit: () => void;
  onClose: () => void;
}) {
  const { user, authedFetch } = useAuth();
  const members = useHouseholdMembers();
  const refresh = useManualFinanceRefresh();
  const { item, payments } = plan;
  const [reloading, setReloading] = useState(false);

  async function reload(): Promise<boolean> {
    setReloading(true);
    try {
      const read = await authedFetch((token) =>
        manualFinanceApi.plan(token, householdId, item.id)
      );
      onPlanChange((old) => mergePlanRead(old, read));
      return true;
    } catch {
      return false;
    } finally {
      setReloading(false);
    }
  }
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // 다른 기기에서 고쳤거나 반영 응답만 잃었으면 목록 version 이 더 크다. 낡은 version 으로는 반영이 409 를
  // 되풀이하고(새로 가져오기는 연결 version 만 맞춘다) 낡은 금액이 경고 없이 남으므로, 한 version 에 한 번 다시 읽는다.
  const triedVersion = useRef<number | null>(null);
  useEffect(() => {
    if (
      observedVersion === undefined ||
      observedVersion <= item.version ||
      triedVersion.current === observedVersion
    )
      return;
    triedVersion.current = observedVersion;
    void reloadRef.current();
  }, [observedVersion, item.version]);

  const summary = planMoneySummary(payments);
  const { headline, paidLine, caveat } = planSummaryLines(summary, {
    canEdit: item.canEdit,
  });
  const next = planNextPayment(item, payments);
  const groups = groupPlanPayments(payments);
  const owner = members.data?.find(
    (member) => member.userId === item.ownerUserId
  )?.name;
  return (
    <RecordSheet title={item.label} onClose={onClose}>
      <p className="text-caption text-muted-foreground break-words">
        {planRowSubtitle(item)}
      </p>
      {payments.length ? (
        <section aria-label="남은 금액" className="grid min-w-0 gap-1">
          <h3 className="text-caption text-muted-foreground">남은 금액</h3>
          {summary.remaining !== null ? (
            <p className="text-title font-bold tabular-nums [overflow-wrap:anywhere]">
              {displayManualKrw(summary.remaining)}
            </p>
          ) : headline ? (
            <p className="text-body text-muted-foreground break-words">
              {headline}
            </p>
          ) : null}
          {paidLine ? (
            <p className="text-body tabular-nums break-words">{paidLine}</p>
          ) : null}
          {next ? (
            <p className="text-body tabular-nums break-words">
              {nextPaymentLine(next)}
            </p>
          ) : null}
          {caveat ? (
            <p className="text-caption text-muted-foreground break-words">
              {caveat}
            </p>
          ) : null}
        </section>
      ) : null}
      <HousingBrandPanel
        householdId={householdId}
        plan={plan}
        canEdit={item.canEdit}
        reloading={reloading}
        onConnectionChange={(connection) =>
          onPlanChange((old) => ({ ...old, brandConnection: connection }))
        }
        onApplied={(applied) => {
          onPlanChange((old) => mergePlanRead(old, applied));
          void refresh(false);
        }}
        onReload={reload}
      />
      <section aria-label="납부 일정" className="grid min-w-0 gap-4">
        {payments.length === 0 ? (
          <p className="text-body text-muted-foreground">
            적어 둔 납부 일정이 없어요.
          </p>
        ) : null}
        {groups.apartment.length ? (
          <div className="grid min-w-0 gap-1">
            <h3 className="text-caption text-muted-foreground">
              아파트 분양대금
            </h3>
            <PaymentRows rows={groups.apartment} />
          </div>
        ) : null}
        {groups.options.length ? (
          <div className="grid min-w-0 gap-1">
            <h3 className="text-caption text-muted-foreground">옵션</h3>
            {groups.options.map((group, index) => (
              <div
                key={group.title ?? `loose-${index}`}
                className="grid min-w-0 gap-1"
              >
                {group.title ? (
                  <h4 className="text-body pt-2 font-semibold break-words">
                    {group.title}
                  </h4>
                ) : null}
                <PaymentRows rows={group.rows} />
              </div>
            ))}
          </div>
        ) : null}
      </section>
      {item.fundingNote ? (
        <section aria-label="자금 마련 메모" className="grid gap-1">
          <h3 className="text-caption text-muted-foreground">자금 마련 메모</h3>
          <p className="text-body break-words whitespace-pre-wrap">
            {item.fundingNote}
          </p>
        </section>
      ) : null}
      {item.canEdit ? (
        <Button
          type="button"
          variant="weak"
          className="min-h-11 w-full"
          onClick={onEdit}
        >
          수정하기
        </Button>
      ) : (
        <p className="text-caption text-muted-foreground">
          {item.ownerUserId === user?.id
            ? "지금 가족 권한으로는 고칠 수 없어요."
            : owner
            ? `${owner}님이 등록했어요. 등록한 사람만 고칠 수 있어요.`
            : "등록한 사람만 고칠 수 있어요."}
        </p>
      )}
    </RecordSheet>
  );
}

/** 읽기 전용 일정 줄: 이름 · 금액, 아래에 '11월 20일 예정'과 상태 칩(기본 상태 '예정'은 칩 없음). */
function PaymentRows({ rows }: { rows: readonly PlanPaymentRow<Payment>[] }) {
  return (
    <FieldList>
      {rows.map(({ payment, name }) => {
        const { caption, chip } = paymentRowView(payment);
        return (
          <FieldRow
            key={payment.id}
            label={name}
            value={
              payment.amount === null ? (
                "금액 미입력"
              ) : (
                <span className="tabular-nums">
                  {displayManualKrw(payment.amount)}
                </span>
              )
            }
            muted={payment.amount === null}
          >
            {caption || chip ? (
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 break-words">{caption}</span>
                {chip ? (
                  <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
                ) : null}
              </span>
            ) : null}
          </FieldRow>
        );
      })}
    </FieldList>
  );
}
