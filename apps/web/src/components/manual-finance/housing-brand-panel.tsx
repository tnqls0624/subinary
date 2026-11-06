"use client";

/**
 * `/plan` 주택 납부 일정 안의 수자인 연결·확인. 새 화면이 아니다.
 * 연결에 쓰는 아이디·비밀번호 칸으로만 조회한다(별도 조회 로그인 폼 없음).
 * 확인/새로고침을 눌렀을 때만 분양대금·옵션을 함께 읽어 확인 목록을 연다.
 */

import { useId, useRef, useState } from "react";
import {
  HOUSING_BRAND_STATUS_LABEL,
  type HousingBrandConnection,
  type HousingBrandFetchedItem,
  type HousingBrandSyncPreview,
  type ManualHousingPlanResponse,
} from "@family/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineNotice } from "@/components/widgets/inline-notice";
import { useAuth } from "@/lib/auth-context";
import { housingBrandApi } from "@/lib/housing-brand-client";
import { displayManualKrw, PAYMENT_LABELS } from "./model";

type Props = {
  householdId: string;
  planId: string | null;
  planVersion: number | null;
  connection: HousingBrandConnection | null | undefined;
  canEdit: boolean;
  /** 주택을 아직 저장하지 않았으면 연결·조회를 막아 안내한다. */
  requiresSavedPlan?: boolean;
  onConnectionChange: (connection: HousingBrandConnection) => void;
  onApplied: (plan: ManualHousingPlanResponse) => void;
};

function itemTitle(item: HousingBrandFetchedItem): string {
  const base = PAYMENT_LABELS[item.kind];
  if (item.kind === "interim" && item.installment) return `${base} ${item.installment}회차`;
  if (item.kind === "option" && item.label) return `${base} · ${item.label}`;
  return base;
}

export function HousingBrandPanel({
  householdId,
  planId,
  planVersion,
  connection,
  canEdit,
  requiresSavedPlan,
  onConnectionChange,
  onApplied,
}: Props) {
  const formId = useId();
  const { authedFetch } = useAuth();
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"connect" | "sync" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<HousingBrandSyncPreview | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const statusLabel = connection
    ? HOUSING_BRAND_STATUS_LABEL[connection.status]
    : "연결 전";

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (!planId || planVersion == null || !canEdit || busy) return;
    const loginId = loginRef.current?.value ?? "";
    const password = passwordRef.current?.value ?? "";
    setBusy("connect");
    setError(null);
    try {
      const result = await authedFetch((token) =>
        housingBrandApi.connect(token, planId, {
          householdId,
          brand: "sujain",
          loginId,
          password,
          expectedPlanVersion: planVersion,
        })
      );
      if (passwordRef.current) passwordRef.current.value = "";
      if (loginRef.current) loginRef.current.value = "";
      onConnectionChange(result.connection);
    } catch {
      setError("수자인 연결을 저장하지 못했어요. 입력값을 확인해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    if (!planId || !connection || !canEdit || busy) return;
    setBusy("sync");
    setError(null);
    setPreview(null);
    try {
      const result = await authedFetch((token) =>
        housingBrandApi.sync(token, planId, {
          householdId,
          expectedConnectionVersion: connection.version,
        })
      );
      onConnectionChange(result.connection);
      setPreview(result);
      const initial: Record<string, boolean> = {};
      for (const item of result.items) initial[item.key] = false;
      setSelected(initial);
    } catch {
      setError("수자인 조회를 끝내지 못했어요. 공식 페이지에서 추가 인증이 있는지도 확인해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  async function applySelected() {
    if (!planId || !connection || !preview || !canEdit || busy || planVersion == null) return;
    const selections = preview.items
      .filter((item) => selected[item.key])
      .map((item) => ({ key: item.key }));
    if (selections.length === 0) {
      setError("반영할 항목을 골라 주세요.");
      return;
    }
    setBusy("apply");
    setError(null);
    try {
      const result = await authedFetch((token) =>
        housingBrandApi.apply(token, planId, {
          householdId,
          expectedPlanVersion: planVersion,
          expectedConnectionVersion: connection.version,
          selections,
        })
      );
      setPreview(null);
      if (result.brandConnection) onConnectionChange(result.brandConnection);
      onApplied(result);
    } catch {
      setError("고른 항목을 일정에 반영하지 못했어요. 다시 확인해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="grid min-w-0 gap-3" aria-label="수자인 신축 조회">
      <div>
        <h3 className="text-body font-semibold">수자인 신축 조회</h3>
        <p className="text-caption text-muted-foreground mt-1">
          공식 수자인 아이디·비밀번호로 이 주택만 연결해요. 확인·새로고침을 눌렀을 때만
          분양대금과 옵션을 함께 읽어요.
        </p>
      </div>
      <p className="text-body" role="status">
        연동 상태 · {statusLabel}
      </p>
      {connection?.statusMessage ? (
        <InlineNotice tone={connection.status === "failed" ? "error" : "info"}>
          {connection.statusMessage}
        </InlineNotice>
      ) : null}
      {requiresSavedPlan ? (
        <p className="text-caption text-muted-foreground">
          주택을 먼저 저장한 뒤 수자인을 연결할 수 있어요.
        </p>
      ) : null}
      {canEdit && !requiresSavedPlan ? (
        <form
          id={formId}
          className="grid min-w-0 gap-3"
          autoComplete="off"
          onSubmit={(event) => void connect(event)}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-brand`}>브랜드</Label>
            <select
              id={`${formId}-brand`}
              className="border-input bg-background h-11 w-full rounded-control border px-3 text-body"
              value="sujain"
              disabled
              aria-readonly="true"
            >
              <option value="sujain">수자인</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-login`}>수자인 아이디</Label>
            <Input
              id={`${formId}-login`}
              ref={loginRef}
              name="sujain-login"
              autoComplete="off"
              disabled={busy !== null}
              maxLength={64}
              placeholder={connection?.credentialsStored ? "저장됨 · 바꾸려면 다시 입력" : "아이디"}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-password`}>수자인 비밀번호</Label>
            <Input
              id={`${formId}-password`}
              ref={passwordRef}
              name="sujain-password"
              type="password"
              autoComplete="new-password"
              disabled={busy !== null}
              maxLength={64}
              placeholder={connection?.credentialsStored ? "저장됨 · 다시 보이지 않아요" : "비밀번호"}
            />
            <p className="text-caption text-muted-foreground">
              저장한 뒤에는 비밀번호를 다시 보여 주지 않아요. 조회도 이 칸으로만 해요.
            </p>
          </div>
          <Button
            type="submit"
            variant="weak"
            className="min-h-11"
            disabled={busy !== null || !planId}
          >
            {busy === "connect" ? "연결 저장 중…" : connection ? "연결 정보 다시 저장" : "수자인 연결 저장"}
          </Button>
        </form>
      ) : null}
      {canEdit && connection?.credentialsStored && !requiresSavedPlan ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            className="min-h-11 flex-1"
            disabled={busy !== null}
            onClick={() => void sync()}
          >
            {busy === "sync" ? "조회 중…" : preview ? "새로고침" : "확인"}
          </Button>
        </div>
      ) : null}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {preview ? (
        <div className="rounded-card grid min-w-0 gap-3 border p-3" aria-label="신축 조회 확인 목록">
          <div>
            <h4 className="text-body font-semibold">확인 목록</h4>
            <p className="text-caption text-muted-foreground mt-1">
              {preview.fetchedAtSeoul} 기준 · 신축 조회. 달라진 값만 보여요. 고른 항목만 일정에 반영해요.
            </p>
          </div>
          {preview.unreadCount > 0 ? (
            <InlineNotice>
              못 읽은 칸 {preview.unreadCount}개. {preview.unreadReasons[0] ?? "이유를 확인하지 못했어요."}
            </InlineNotice>
          ) : null}
          {preview.items.length === 0 ? (
            <p className="text-body text-muted-foreground">바꿀 항목이 없어요.</p>
          ) : (
            <ul className="grid gap-2">
              {preview.items.map((item) => (
                <li key={item.key} className="border-border/60 min-w-0 border-b pb-2">
                  <label className="flex min-h-11 cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-3 size-4"
                      checked={Boolean(selected[item.key])}
                      onChange={(event) =>
                        setSelected((old) => ({ ...old, [item.key]: event.target.checked }))
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-body block font-semibold">{itemTitle(item)}</span>
                      <span className="text-caption text-muted-foreground mt-1 block">
                        예정 {item.scheduledAmount ? displayManualKrw(item.scheduledAmount) : "미확인"}
                        {" · "}
                        예정일 {item.dueDate ?? "미확인"}
                        {" · "}
                        낸 금액 {item.paidAmount ? displayManualKrw(item.paidAmount) : "미확인"}
                        {item.actualPaidDate ? ` · 납부일 ${item.actualPaidDate}` : ""}
                      </span>
                      <span className="text-caption text-muted-foreground mt-1 block">
                        {item.matchedPaymentId
                          ? `기존 일정과 다른 칸: ${item.changedFields.join(", ") || "없음"}`
                          : "새 일정 후보"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            className="min-h-11"
            disabled={busy !== null || preview.items.length === 0}
            onClick={() => void applySelected()}
          >
            {busy === "apply" ? "반영 중…" : "고른 항목만 일정에 반영"}
          </Button>
          <p className="text-caption text-muted-foreground">
            실제 납부 실행 버튼은 없어요. 가계부·정기지출·캘린더에는 넣지 않아요.
          </p>
        </div>
      ) : null}
    </section>
  );
}
