"use client";

/**
 * 주택 상세 시트 안의 주택 브랜드(지금은 수자인) 줄 — 2026-11-08 PO 재설계.
 * 예전에는 입력 폼 안에서 연결 뒤에도 브랜드 줄·아이디·비밀번호·저장 버튼·상태 줄·설명 두 줄을 늘 펼쳤고,
 * 확인 목록은 영문 칸 이름과 ISO 날짜를 그대로 보이며 모두 해제된 채 시작했다(사용자: 'UI/UX가 너무 복잡해 보여').
 * 이제 한 줄('수자인 · 11월 8일 오후 11:27 기준' + 새로 가져오기)이고, 연결 폼은 누를 때만 그 자리에서 펼친다
 * (창 위에 창을 겹치지 않는다). 가져온 결과도 같은 시트 안에서 사람 말로 보이고 처음부터 모두 골라져 있다.
 * 결과(주 버튼 'N건 반영하기')와 연결 폼(주 버튼 '연결하고 가져오기')은 함께 펼치지 않는다 — 화면당 주 버튼 하나.
 * 서버의 '확인 필요' 문구는 그리지 않는다(brandConnectionState 주석). 연결·가져오기·반영 순서는 housing-brand-actions.
 * 브랜드 이름은 HOUSING_BRAND_INFO 에서 가져온다. 브랜드 고르기는 브랜드가 2개 이상일 때 만든다.
 */

import { useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  DEFAULT_HOUSING_BRAND,
  HOUSING_BRAND_INFO,
  type HousingBrandConnection,
  type HousingBrandSyncPreview,
  type ManualHousingPlanResponse,
} from "@family/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineNotice } from "@/components/widgets/inline-notice";
import { useAuth } from "@/lib/auth-context";
import { housingBrandApi } from "@/lib/housing-brand-client";
import { cn } from "@/lib/utils";
import {
  applyBrandChanges,
  BRAND_RELOAD_FAILED_MESSAGE,
  brandSelections,
  connectAndSync,
  syncBrand,
  type BrandSyncOutcome,
  type HousingBrandActionsApi,
} from "./housing-brand-actions";
import {
  housingBrandLocalErrorNotice,
  housingBrandSyncErrorMessage,
} from "./housing-brand-sync-error";
import {
  BRAND_PENDING_LINE,
  brandConnectionState,
  brandSourceLine,
  previewChanges,
  previewUnreadLine,
  type PreviewChange,
} from "./plan-summary";

type Props = {
  householdId: string;
  /** 지금 시트에 보이는 주택(일정의 '전' 값과 반영할 때의 version 을 여기서 읽는다). */
  plan: ManualHousingPlanResponse;
  /** 이 주택을 고칠 수 있나. 없으면 수자인 줄은 글자만 보인다. */
  canEdit: boolean;
  /** 상세 시트가 주택을 다시 읽는 중 — 그동안 가져오기·반영을 막는다(낡은 version 으로 보내지 않게). */
  reloading?: boolean;
  onConnectionChange: (connection: HousingBrandConnection) => void;
  onApplied: (plan: ManualHousingPlanResponse) => void;
  /** 주택을 서버에서 다시 읽는다(409, 또는 실패가 기록됐는지 모를 때). 읽었으면 true. */
  onReload: () => Promise<boolean>;
};

export function HousingBrandPanel({
  householdId,
  plan,
  canEdit,
  reloading = false,
  onConnectionChange,
  onApplied,
  onReload,
}: Props) {
  const { authedFetch } = useAuth();
  const connection: HousingBrandConnection | null = plan.brandConnection ?? null;
  // 연결이 있으면 그 브랜드, 없으면 기본 브랜드. 다시 연결해도 브랜드가 바뀌지 않는다.
  const brand = connection?.brand ?? DEFAULT_HOUSING_BRAND;
  const brandLabel = HOUSING_BRAND_INFO[brand].label;
  // 연결은 연결한 본인에게만 붙는다(canManage). 고칠 권한이 없으면 버튼 없이 글자만.
  const manage = canEdit && (connection?.canManage ?? true);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<"connect" | "sync" | "apply" | null>(null);
  // React가 버튼을 끄기 전의 두 번 누름을 막는다.
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<HousingBrandSyncPreview | null>(null);
  // 처음부터 모두 고른 상태라 뺀 것만 기억한다.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // '바뀐 내용이 없어요'를 보여 준 연결 version. 서버는 이때도 '반영 전'으로 남기지만, 결과를 닫은 뒤
  // '아직 반영하지 않았어요'라고 하면 방금 본 말과 어긋난다.
  const [quietVersion, setQuietVersion] = useState<number | null>(null);

  if (!connection && !manage) return null;

  const planId = plan.item.id;
  const api: HousingBrandActionsApi = {
    connect: (body) =>
      authedFetch((token) => housingBrandApi.connect(token, planId, body)),
    sync: (body) =>
      authedFetch((token) => housingBrandApi.sync(token, planId, body)),
    apply: (body) =>
      authedFetch((token) => housingBrandApi.apply(token, planId, body)),
  };

  const claim = (kind: "connect" | "sync" | "apply") => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(kind);
    return true;
  };
  const release = () => {
    lock.current = false;
    setBusy(null);
  };

  async function settleSync(outcome: BrandSyncOutcome) {
    if (outcome.ok) {
      onConnectionChange(outcome.preview.connection);
      setUnchecked(new Set());
      setQuietVersion(
        previewChanges(outcome.preview.items, plan.payments).length === 0
          ? outcome.preview.connection.version
          : null
      );
      setPreview(outcome.preview);
      return;
    }
    if (outcome.connection) {
      // 실패도 서버가 연결에 남기며 version 을 올린다 — 그 연결로 바꿔 '다시 가져오기'가 바로 된다.
      onConnectionChange(outcome.connection);
      setError(outcome.message);
      return;
    }
    // 409 이거나 실패가 기록됐는지 모른다 — version 을 지어내지 않고 주택(연결 포함)을 다시 읽는다.
    const reloaded = await onReload();
    setError(
      reloaded || !outcome.stale ? outcome.message : BRAND_RELOAD_FAILED_MESSAGE
    );
  }

  async function sync() {
    if (!connection || !manage || reloading || !claim("sync")) return;
    setError(null);
    setPreview(null);
    // 결과와 연결 폼을 함께 펼치지 않는다(주 버튼 하나).
    setFormOpen(false);
    setFormError(null);
    try {
      await settleSync(await syncBrand(api, { householdId, connection }));
    } finally {
      release();
    }
  }

  /** '연결하고 가져오기' — 연결을 저장한 뒤 바로 가져온다. */
  async function connect(loginId: string, password: string) {
    if (!manage || reloading) return;
    if (!loginId || !password) {
      setFormError("아이디와 비밀번호를 입력해 주세요.");
      return;
    }
    if (!claim("connect")) return;
    setError(null);
    setPreview(null);
    try {
      const outcome = await connectAndSync(
        api,
        {
          householdId,
          brand,
          planVersion: plan.item.version,
          loginId,
          password,
        },
        (connected) => {
          onConnectionChange(connected);
          setFormError(null);
          setFormOpen(false);
          setBusy("sync");
        }
      );
      if (outcome.step === "connect") {
        // 폼은 열어 둔다 — 적은 아이디가 남아 있어 다시 누르기만 하면 된다.
        const reloaded = outcome.stale ? await onReload() : true;
        setFormError(reloaded ? outcome.message : BRAND_RELOAD_FAILED_MESSAGE);
        return;
      }
      await settleSync(outcome.sync);
    } finally {
      release();
    }
  }

  const changes = preview ? previewChanges(preview.items, plan.payments) : [];
  const selections = brandSelections(changes, unchecked);

  async function apply() {
    if (!connection || !preview || !manage || reloading) return;
    if (selections.length === 0 || !claim("apply")) return;
    setError(null);
    try {
      const outcome = await applyBrandChanges(api, {
        householdId,
        planVersion: plan.item.version,
        connection,
        selections,
      });
      if (outcome.ok) {
        // 토스트는 띄우지 않는다 — 결과가 닫히고 같은 시트의 요약·일정이 바로 새 값으로 바뀌는 것이 확인이다
        // (§8 하위 화면: 토스트는 결과가 화면에 안 보일 때만).
        setPreview(null);
        onApplied(outcome.plan);
        return;
      }
      if (outcome.stale) {
        // 고를 목록은 낡은 일정에 맞춘 것이라 닫는다. 다시 읽은 일정으로 새로 가져와 반영한다.
        setPreview(null);
        const reloaded = await onReload();
        setError(reloaded ? outcome.message : BRAND_RELOAD_FAILED_MESSAGE);
        return;
      }
      setError(outcome.message);
    } finally {
      release();
    }
  }

  const state = connection ? brandConnectionState(connection) : null;
  const failed = state === "failed";
  const pendingLine =
    state === "pending" &&
    manage &&
    !preview &&
    quietVersion !== connection?.version
      ? BRAND_PENDING_LINE
      : null;
  const blocked = busy !== null || reloading;
  const localError = housingBrandLocalErrorNotice(
    error,
    failed ? connection?.statusMessage : null
  );
  return (
    <section
      aria-label={`${brandLabel}에서 가져오기`}
      className="border-border/60 grid min-w-0 gap-2 border-y py-1"
    >
      {connection ? (
        <div className="flex min-h-12 min-w-0 items-center justify-between gap-3">
          <div className="grid min-w-0 gap-0.5 py-1">
            <p className="text-body min-w-0 break-words">
              {brandSourceLine(brandLabel, connection.lastSuccessAt)}
            </p>
            {pendingLine ? (
              <p className="text-caption text-muted-foreground break-words">
                {pendingLine}
              </p>
            ) : null}
          </div>
          {manage && !failed ? (
            <Button
              type="button"
              variant="weak"
              size="sm"
              disabled={blocked}
              onClick={() => void sync()}
            >
              {busy === "sync" ? "가져오는 중…" : "새로 가져오기"}
            </Button>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={formOpen}
          className="text-body flex min-h-12 w-full min-w-0 items-center justify-between gap-3 py-2 text-left transition-colors active:bg-muted/60"
          onClick={() => {
            setFormOpen((open) => !open);
            setFormError(null);
          }}
        >
          {`${brandLabel}에서 일정 가져오기`}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "text-muted-foreground/70 -mr-1 size-5 shrink-0 transition-transform",
              formOpen && "rotate-90"
            )}
          />
        </button>
      )}
      {failed ? (
        <>
          <InlineNotice tone="error">
            {connection?.statusMessage ?? housingBrandSyncErrorMessage(null, brand)}
          </InlineNotice>
          {manage ? (
            <Button
              type="button"
              variant="weak"
              className="min-h-11 w-full"
              disabled={blocked}
              onClick={() => void sync()}
            >
              {busy === "sync" ? "가져오는 중…" : "다시 가져오기"}
            </Button>
          ) : null}
        </>
      ) : null}
      {localError ? <InlineNotice tone="error">{localError}</InlineNotice> : null}
      {preview ? (
        <BrandSyncResults
          changes={changes}
          unreadLine={previewUnreadLine(preview)}
          unchecked={unchecked}
          busy={busy === "apply"}
          canApply={manage && !blocked}
          onToggle={(key, checked) =>
            setUnchecked((old) => {
              const next = new Set(old);
              if (checked) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onApply={() => void apply()}
          onClose={() => setPreview(null)}
        />
      ) : null}
      {/* 결과가 열려 있으면 숨긴다 — 결과가 수자인 줄 바로 아래에 오고, 주 버튼이 둘이 되지 않게. */}
      {connection && manage && !formOpen && !preview ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="text-muted-foreground self-start px-0"
          disabled={blocked}
          onClick={() => {
            setFormOpen(true);
            setFormError(null);
          }}
        >
          연결 정보 바꾸기
        </Button>
      ) : null}
      {formOpen && manage ? (
        <BrandConnectForm
          brandLabel={brandLabel}
          busy={busy === "connect"}
          disabled={blocked}
          error={formError}
          onSubmit={(loginId, password) => void connect(loginId, password)}
          onClose={() => {
            setFormOpen(false);
            setFormError(null);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * 그 자리에서 펼치는 연결 폼. 상세 시트에는 다른 <form>이 없어 진짜 <form>으로 둔다 — Enter·비밀번호 관리자가 그대로 된다.
 * 칸 이름(sujain-login/sujain-password)은 브라우저에 저장된 자격 증명 연결을 지키려고 예전 그대로다.
 */
export function BrandConnectForm({
  brandLabel,
  busy,
  disabled = false,
  error,
  onSubmit,
  onClose,
}: {
  brandLabel: string;
  /** 연결하는 중 — 칸·버튼을 막고 '연결하는 중…'. */
  busy: boolean;
  /** 다른 일(가져오기·다시 읽기)을 하는 중 — 글자는 그대로 두고 막기만 한다. */
  disabled?: boolean;
  error: string | null;
  onSubmit: (loginId: string, password: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const off = busy || disabled;
  return (
    <form
      noValidate
      aria-label={`${brandLabel} 연결`}
      className="grid min-w-0 gap-3 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (off) return;
        const data = new FormData(event.currentTarget);
        onSubmit(
          String(data.get("sujain-login") ?? "").trim(),
          String(data.get("sujain-password") ?? "")
        );
      }}
    >
      <p className="text-caption text-muted-foreground">
        {`${brandLabel} 사이트 아이디로 이 주택의 분양대금과 옵션을 가져와요. 비밀번호는 다시 보여 주지 않아요.`}
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-login`}>{`${brandLabel} 아이디`}</Label>
        <Input
          id={`${id}-login`}
          name="sujain-login"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          disabled={off}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-password`}>{`${brandLabel} 비밀번호`}</Label>
        <Input
          id={`${id}-password`}
          name="sujain-password"
          type="password"
          autoComplete="new-password"
          maxLength={64}
          disabled={off}
        />
      </div>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <div className="flex min-w-0 gap-2">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 flex-1"
          disabled={off}
          onClick={onClose}
        >
          닫기
        </Button>
        <Button
          type="submit"
          className="min-h-11 h-auto flex-[2] whitespace-normal"
          disabled={off}
        >
          {busy ? "연결하는 중…" : "연결하고 가져오기"}
        </Button>
      </div>
    </form>
  );
}

/** 가져온 결과 — 달라진 내용만, 처음부터 모두 골라 둔다. 바뀐 게 없으면 한 줄. */
export function BrandSyncResults({
  changes,
  unreadLine,
  unchecked,
  busy,
  canApply,
  onToggle,
  onApply,
  onClose,
}: {
  changes: readonly PreviewChange[];
  unreadLine: string | null;
  unchecked: ReadonlySet<string>;
  /** 반영하는 중. */
  busy: boolean;
  /** 다른 일(가져오기 등)을 하는 중이면 반영을 막는다. */
  canApply: boolean;
  onToggle: (key: string, checked: boolean) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const chosen = changes.filter((change) => !unchecked.has(change.key)).length;
  if (changes.length === 0)
    return (
      <div role="status" className="grid min-w-0 gap-1 pb-2">
        <p className="text-body text-muted-foreground">바뀐 내용이 없어요</p>
        {unreadLine ? (
          <p className="text-caption text-muted-foreground break-words">
            {unreadLine}
          </p>
        ) : null}
      </div>
    );
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-2 pb-2">
      <h3 id={headingId} className="text-body font-semibold">
        {`달라진 내용 ${changes.length}건`}
      </h3>
      <ul className="border-border/60 divide-border/60 grid min-w-0 divide-y border-y">
        {changes.map((change) => (
          <li key={change.key} className="min-w-0">
            <label className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 py-2.5 transition-colors active:bg-muted/60">
              <Checkbox
                className="mt-1"
                checked={!unchecked.has(change.key)}
                disabled={busy}
                onChange={(event) => onToggle(change.key, event.target.checked)}
              />
              <span className="text-body min-w-0 flex-1 break-words">
                {change.title}
                <span className="text-muted-foreground">{` · ${change.detail}`}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {unreadLine ? (
        <p className="text-caption text-muted-foreground break-words">
          {unreadLine}
        </p>
      ) : null}
      <div className="flex min-w-0 gap-2">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 flex-1"
          disabled={busy}
          onClick={onClose}
        >
          닫기
        </Button>
        <Button
          type="button"
          className="min-h-11 h-auto flex-[2] whitespace-normal"
          disabled={busy || !canApply || chosen === 0}
          onClick={onApply}
        >
          {busy ? "반영하는 중…" : `${chosen}건 반영하기`}
        </Button>
      </div>
    </section>
  );
}
