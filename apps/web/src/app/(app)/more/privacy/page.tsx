"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 개인정보 (/more/privacy)
 *
 * 1. 내 데이터가 어디서 들어오나 (문자 보내는 기기 수 → `/devices`)
 * 2. 지금 무엇이 얼마나 보관돼 있나 (카드 문자 건수 · 시작한 달)
 * 3. 원문을 얼마나 남길지 (보존 정책 선택 · 미리보기 · 적용) — SOO-34
 *
 * 새 최상위 화면·탭을 만들지 않는다. 가족 가입 동의 UI는 2026-11-05에 없앴다.
 * ------------------------------------------------------------------------- */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  MessageSquareText,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import type {
  PrivacyOverview,
  PrivacyRetentionPreviewResponse,
  RetentionPolicy,
} from "@family/contracts";
import { DEFAULT_TIMEZONE } from "@family/shared";

import { Button } from "@/components/ui/button";
import {
  BottomSheet,
  ErrorState,
  ListLoading,
  PageBackHeader,
} from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import {
  fetchPrivacyOverview,
  previewRetentionPolicy,
  privacyQueryKey,
  updateRetentionPolicy,
} from "./privacy-api";
import { RetentionGuide } from "./retention-guide";
import {
  RETENTION_POLICY_OPTIONS,
  retentionPolicyLabel,
} from "./retention-policy-labels";

const yearMonthFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "numeric",
});

/** 보관을 시작한 달 — 올해면 `8월부터`, 아니면 `2025년 8월부터`(서울 기준). */
function sinceMonthLabel(iso: string, now: Date = new Date()): string {
  const part = (date: Date, type: "year" | "month") =>
    Number(
      yearMonthFormatter.formatToParts(date).find((p) => p.type === type)?.value
    );
  const then = new Date(iso);
  const month = part(then, "month");
  return part(then, "year") === part(now, "year")
    ? `${month}월부터`
    : `${part(then, "year")}년 ${month}월부터`;
}

/** 설정 목록 한 줄 — 전체 탭과 같은 모양(배경 없는 아이콘 24 · 제목 · 화살표). */
function SettingRow({
  icon: Icon,
  title,
  href,
}: Readonly<{
  icon: LucideIcon;
  title: ReactNode;
  href?: string;
}>) {
  const body = (
    <>
      <Icon
        className="text-muted-foreground size-6 shrink-0"
        strokeWidth={1.7}
        aria-hidden="true"
      />
      <span className="text-body min-w-0 flex-1">{title}</span>
      {href !== undefined ? (
        <ChevronRight
          className="text-muted-foreground/70 size-5 shrink-0"
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  const className =
    "flex min-h-14 w-full items-center gap-4 px-5 py-3 text-left";
  return href !== undefined ? (
    <Link
      href={href}
      className={`${className} hover:bg-muted/60 active:bg-muted focus-visible:ring-ring transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset`}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

function policyCaption(policy: RetentionPolicy): string {
  if (policy === "none") {
    return "받은 문자는 자동으로 지워지지 않아요";
  }
  return `보존 정책 · ${retentionPolicyLabel(policy)}`;
}

export default function PrivacyPage() {
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();
  const queryClient = useQueryClient();
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [policySheetOpen, setPolicySheetOpen] = useState(false);
  const [pendingPolicy, setPendingPolicy] = useState<RetentionPolicy | null>(
    null
  );
  const [preview, setPreview] =
    useState<PrivacyRetentionPreviewResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const overviewQuery = useQuery<PrivacyOverview>({
    queryKey: privacyQueryKey(householdId),
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) =>
        fetchPrivacyOverview(token, householdId as string)
      ),
  });

  const previewMutation = useMutation({
    mutationFn: (policy: RetentionPolicy) =>
      authedFetch((token) =>
        previewRetentionPolicy(token, householdId as string, policy)
      ),
    onSuccess: (data) => {
      setPreview(data);
      setActionError(null);
    },
    onError: () => {
      setActionError("영향 미리보기를 불러오지 못했어요");
      setPreview(null);
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      if (!pendingPolicy || !preview) {
        throw new Error("preview missing");
      }
      return authedFetch((token) =>
        updateRetentionPolicy(token, householdId as string, {
          policy: pendingPolicy,
          expectedEventCount: preview.matchingEventCount,
          expectedSuppressionCount: preview.matchingSuppressionCount,
        })
      );
    },
    onSuccess: async () => {
      setPolicySheetOpen(false);
      setPendingPolicy(null);
      setPreview(null);
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: privacyQueryKey(householdId),
      });
    },
    onError: () => {
      setActionError(
        "정책을 바꾸지 못했어요. 보관 현황이 바뀌었을 수 있으니 다시 미리보기 해 주세요."
      );
    },
  });

  if (overviewQuery.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <PageBackHeader title="개인정보" />
        <ListLoading rows={3} label="개인정보 설정을 불러오는 중이에요." />
      </div>
    );
  }

  const overview = overviewQuery.data;
  if (!overview) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <PageBackHeader title="개인정보" />
        <ErrorState
          align="start"
          message="개인정보 설정을 불러오지 못했어요"
          retrying={overviewQuery.isFetching}
          onRetry={() => void overviewQuery.refetch()}
        />
      </div>
    );
  }

  const { smsEventCount, oldestReceivedAt, policy, recentPurges } =
    overview.retention;
  const lastCompletedPurge = recentPurges.find(
    (row) => row.status === "completed"
  );
  const deviceCount = overview.myActiveDeviceCount;

  function openPolicySheet() {
    setPendingPolicy(policy);
    setPreview(null);
    setActionError(null);
    setPolicySheetOpen(true);
    void previewMutation.mutateAsync(policy);
  }

  function selectPolicy(next: RetentionPolicy) {
    setPendingPolicy(next);
    setPreview(null);
    setActionError(null);
    void previewMutation.mutateAsync(next);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <PageBackHeader title="개인정보" />

      <section className="finance-panel panel-flush-top overflow-hidden py-1">
        <SettingRow
          icon={Smartphone}
          title={`문자 보내는 기기 ${deviceCount.toLocaleString("ko-KR")}대`}
          href="/devices"
        />
        <SettingRow
          icon={MessageSquareText}
          title={
            smsEventCount > 0 && oldestReceivedAt
              ? `카드 문자 ${smsEventCount.toLocaleString(
                  "ko-KR"
                )}건 보관 중 · ${sinceMonthLabel(oldestReceivedAt)}`
              : "보관 중인 카드 문자가 없어요"
          }
        />
        <p className="text-caption text-muted-foreground px-5 pb-2">
          {policyCaption(policy)}{" "}
          <button
            type="button"
            onClick={() => setRetentionOpen(true)}
            className="text-foreground -my-3 inline-flex min-h-11 items-center px-1 font-medium underline-offset-4 hover:underline"
          >
            자세히
          </button>
        </p>
        <div className="px-5 pb-4">
          <Button
            type="button"
            variant="weak"
            className="w-full"
            onClick={openPolicySheet}
          >
            원문 보존 정책 바꾸기
          </Button>
        </div>
        {lastCompletedPurge ? (
          <p className="text-caption text-muted-foreground px-5 pb-4">
            최근 삭제{" "}
            {lastCompletedPurge.purgedEventCount.toLocaleString("ko-KR")}건 ·{" "}
            {retentionPolicyLabel(lastCompletedPurge.policy)}
          </p>
        ) : null}
      </section>

      <BottomSheet
        open={retentionOpen}
        onOpenChange={setRetentionOpen}
        title="보관 안내"
      >
        <RetentionGuide
          policy={policy}
          onNavigate={() => setRetentionOpen(false)}
        />
      </BottomSheet>

      <BottomSheet
        open={policySheetOpen}
        onOpenChange={setPolicySheetOpen}
        title="원문 보존 정책"
      >
        <div className="flex flex-col gap-3 pb-2">
          <p className="text-body text-muted-foreground">
            고른 정책에 맞는 문자 원문 사본만 지워요. 거래와 금액은 남아요.
          </p>
          <div role="radiogroup" aria-label="원문 보존 정책" className="flex flex-col gap-1">
            {RETENTION_POLICY_OPTIONS.map((option) => {
              const selected = pendingPolicy === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => selectPolicy(option.value)}
                  className={`rounded-control flex min-h-14 flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors ${
                    selected
                      ? "bg-primary/10 text-foreground"
                      : "hover:bg-muted/60 active:bg-muted text-foreground"
                  }`}
                >
                  <span className="text-body font-semibold">{option.label}</span>
                  <span className="text-caption text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          {previewMutation.isPending ? (
            <p className="text-caption text-muted-foreground">
              지금 지워질 건수를 세고 있어요…
            </p>
          ) : null}
          {preview && pendingPolicy ? (
            <p className="text-body">
              {pendingPolicy === "none" ? (
                <>자동 삭제를 끄면 지금 원문을 지우지 않아요.</>
              ) : (
                <>
                  지금{" "}
                  <strong className="font-semibold">
                    문자 {preview.matchingEventCount.toLocaleString("ko-KR")}건
                  </strong>
                  {preview.matchingSuppressionCount > 0
                    ? ` · 중복 보관 ${preview.matchingSuppressionCount.toLocaleString("ko-KR")}건`
                    : null}
                  이 지워져요. {preview.effectSummary}
                </>
              )}
            </p>
          ) : null}
          {actionError ? (
            <p role="alert" className="text-caption text-destructive">
              {actionError}
            </p>
          ) : null}

          <Button
            type="button"
            className="w-full"
            disabled={
              !pendingPolicy ||
              !preview ||
              previewMutation.isPending ||
              applyMutation.isPending ||
              pendingPolicy === policy
            }
            onClick={() => void applyMutation.mutateAsync()}
          >
            {applyMutation.isPending ? "적용하는 중…" : "이 정책으로 적용"}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
