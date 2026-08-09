"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 개인정보 (/more/privacy) — C-3 **1단계**
 *
 * 이 화면이 답하는 질문은 셋이다.
 *   1. 나는 무엇에, 언제 동의했나 (버전 + 문구 원문 + 이력)
 *   2. 내 데이터가 어디서 들어오나 (수집 중인 기기)
 *   3. 지금 무엇이 얼마나 보관돼 있나 (읽기 전용 현황)
 * 그리고 하나를 실행한다 — **철회**(기기 즉시 해제). 되돌릴 수 있다(재동의).
 *
 * ⚠️ 이 화면은 **삭제를 약속하지 않는다.** 원문 purge 잡·보존기간 선택은 아직 없다
 * (로드맵 5-1 보류). "N일 뒤 삭제" 같은 문장을 여기 쓰는 순간 서비스가 지키지 못할
 * 약속을 하게 되고, 그건 개인정보 화면이 할 수 있는 최악의 거짓말이다. 보관은
 * **지금 상태를 그대로 보여주기만** 한다.
 *
 * `/devices`와 기기 목록이 겹치지만 관점이 다르다 — 저기는 "기기를 관리한다", 여기는
 * "내 데이터가 어디서 들어오는가". 목록은 기존 `useDevices()` 훅을 그대로 읽는다.
 * ------------------------------------------------------------------------- */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Database,
  HardDrive,
  Loader2,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import {
  CURRENT_HOUSEHOLD_CONSENT_VERSION,
  householdConsentDocuments,
  type HouseholdConsentRecord,
  type PrivacyOverview,
} from "@family/contracts";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageBackHeader } from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { useDevices } from "@/lib/queries";
import {
  fetchPrivacyOverview,
  grantPrivacyConsent,
  privacyQueryKey,
  revokePrivacyConsent,
} from "./privacy-api";

/** 바이트를 사람이 읽는 단위로. 보관량은 대략만 알면 되므로 소수 첫째 자리까지. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** 현재 문구 전문. 사용자가 무엇에 동의하는지 접지 않고 그대로 보여준다. */
function ConsentDocument({ version }: { version: string }) {
  const document = householdConsentDocuments[version];
  if (!document) {
    // 코드에 원문이 없는 버전 — 지어내지 않고 사실대로 말한다.
    return (
      <p className="text-muted-foreground text-[13px]">
        이 버전({version})의 동의 문구를 찾을 수 없어요. 고객센터에 알려 주세요.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {document.clauses.map((clause) => (
        <div key={clause.title} className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">{clause.title}</span>
          <span className="text-muted-foreground text-[13px] leading-relaxed">
            {clause.body}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 동의 이력 한 줄. 철회도 지워지지 않고 여기 남는다. */
function HistoryRow({ record }: { record: HouseholdConsentRecord }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-[13px]">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">
          {record.status === "granted" ? "동의" : "철회"} · {record.version}
        </span>
        <span className="text-muted-foreground">
          {record.status === "granted"
            ? formatDateTime(record.consentedAt)
            : `${formatDateTime(record.consentedAt)} 동의 → ${
                record.revokedAt ? formatDateTime(record.revokedAt) : "-"
              } 철회`}
        </span>
      </span>
      {record.status === "revoked" && record.revokedReason === "member_removed" ? (
        <span className="text-muted-foreground shrink-0">가족에서 나감</span>
      ) : null}
    </div>
  );
}

export default function PrivacyPage() {
  const { householdId } = useHousehold();
  const { authedFetch } = useAuth();
  const queryClient = useQueryClient();
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const overviewQuery = useQuery<PrivacyOverview>({
    queryKey: privacyQueryKey(householdId),
    enabled: householdId != null,
    queryFn: () =>
      authedFetch((token) =>
        fetchPrivacyOverview(token, householdId as string),
      ),
  });
  const devicesQuery = useDevices();

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: privacyQueryKey(householdId),
    });
    // 철회는 기기를 폐기한다 — 기기 목록 캐시도 함께 무효화해야 화면이 어긋나지 않는다.
    await queryClient.invalidateQueries({ queryKey: ["devices", householdId] });
  };

  const grant = useMutation({
    mutationFn: () =>
      authedFetch((token) =>
        grantPrivacyConsent(
          token,
          householdId as string,
          // 화면이 방금 보여준 문구의 버전을 그대로 보낸다. 서버가 현재 버전과 대조해
          // 캐시된 옛 화면의 동의를 409로 거절한다.
          CURRENT_HOUSEHOLD_CONSENT_VERSION,
        ),
      ),
    onSuccess: async () => {
      await invalidate();
      toast.success("동의를 기록했어요.");
    },
    onError: () =>
      toast.error("동의를 기록하지 못했어요. 잠시 후 다시 시도해 주세요."),
  });

  const revoke = useMutation({
    mutationFn: () =>
      authedFetch((token) =>
        revokePrivacyConsent(token, householdId as string),
      ),
    onSuccess: async (result) => {
      await invalidate();
      setConfirmingRevoke(false);
      toast.success(
        result.revokedDeviceCount > 0
          ? `동의를 철회하고 기기 ${result.revokedDeviceCount}대의 연결을 해제했어요.`
          : "동의를 철회했어요.",
      );
    },
    onError: () => {
      setConfirmingRevoke(false);
      toast.error("철회하지 못했어요. 잠시 후 다시 시도해 주세요.");
    },
  });

  if (overviewQuery.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <PageBackHeader title="개인정보" />
        <p className="text-muted-foreground text-sm">불러오는 중…</p>
      </div>
    );
  }

  const overview = overviewQuery.data;
  if (!overview) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <PageBackHeader title="개인정보" />
        <p className="text-destructive text-sm">
          개인정보 설정을 불러오지 못했어요. 새로고침해 주세요.
        </p>
      </div>
    );
  }

  const active = overview.activeConsent;
  const myDevices = (devicesQuery.data ?? []).filter(
    (device) => device.memberId === overview.myMemberId,
  );
  const busy = grant.isPending || revoke.isPending;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageBackHeader
        title="개인정보"
        subtitle="무엇에 동의했고, 무엇이 수집·보관되는지 확인해요"
      />

      {/* ---- 1. 동의 상태 ---- */}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
                active
                  ? "bg-accent text-accent-foreground"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {active ? (
                <ShieldCheck className="size-5" />
              ) : (
                <AlertTriangle className="size-5" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-medium">
                {active ? "동의 중이에요" : "동의하지 않은 상태예요"}
              </span>
              <span className="text-muted-foreground text-[13px]">
                {active
                  ? `${formatDate(active.consentedAt)} · 문구 ${active.version}`
                  : "카드 문자 수집이 멈춰 있어요. 다시 동의하면 기기를 등록할 수 있어요."}
              </span>
            </div>
          </div>

          {overview.needsRenewal ? (
            <div className="bg-muted flex flex-col gap-2 rounded-xl p-4">
              <span className="text-[14px] font-medium">
                동의 문구가 개정됐어요
              </span>
              <span className="text-muted-foreground text-[13px] leading-relaxed">
                이전에 동의한 문구({active?.version})와 현재 문구(
                {overview.currentVersion})가 달라요. 아래 내용을 확인하고 다시
                동의해 주세요. 확인 전에도 수집은 계속돼요.
              </span>
            </div>
          ) : null}

          <div className="bg-muted flex flex-col gap-3 rounded-xl p-4">
            <span className="text-[13px] font-semibold">
              현재 문구 ({overview.currentVersion})
            </span>
            <ConsentDocument version={overview.currentVersion} />
          </div>

          <div className="flex flex-col gap-2">
            {!active || overview.needsRenewal ? (
              <Button
                size="lg"
                className="h-12 w-full"
                disabled={busy}
                onClick={() => grant.mutate()}
              >
                {grant.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> 기록하고 있어요…
                  </>
                ) : (
                  <>
                    <Check className="size-4" />
                    {active ? "새 문구에 동의하기" : "동의하기"}
                  </>
                )}
              </Button>
            ) : null}
            {active ? (
              <Button
                variant="ghost"
                size="lg"
                className="text-destructive hover:text-destructive w-full"
                disabled={busy}
                onClick={() => setConfirmingRevoke(true)}
              >
                동의 철회하기
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ---- 2. 내 데이터가 어디서 들어오는가 ---- */}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-medium">
              지금 수집 중인 내 기기
            </span>
            <span className="text-muted-foreground text-[13px]">
              여기 있는 기기가 보낸 카드사 문자만 수집돼요
            </span>
          </div>

          {devicesQuery.isLoading ? (
            <p className="text-muted-foreground text-[13px]">불러오는 중…</p>
          ) : myDevices.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">
              등록된 기기가 없어요. 지금은 문자가 자동으로 수집되지 않아요.
            </p>
          ) : (
            <div className="flex flex-col divide-y">
              {myDevices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <span className="bg-accent text-accent-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
                    <Smartphone className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[14px] font-medium">
                      {device.name}
                    </span>
                    <span className="text-muted-foreground text-[13px]">
                      {device.lastEventAt
                        ? `마지막 문자 ${formatDateTime(device.lastEventAt)}`
                        : "아직 받은 문자가 없어요"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          <Button asChild variant="ghost" className="w-full">
            <Link href="/devices">기기 관리로 가기</Link>
          </Button>
        </CardContent>
      </Card>

      {/* ---- 3. 지금 무엇이 보관되는가 (읽기 전용) ---- */}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-medium">지금 보관 중인 것</span>
            <span className="text-muted-foreground text-[13px]">
              우리 가족이 수집한 문자 원문이 남아 있는 곳이에요
            </span>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
                <Database className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-medium">
                  데이터베이스 · 문자 {overview.retention.smsEventCount}건
                </span>
                <span className="text-muted-foreground text-[13px]">
                  {overview.retention.oldestReceivedAt
                    ? `${formatDate(overview.retention.oldestReceivedAt)}부터 지금까지의 문자 원문이 그대로 저장돼 있어요`
                    : "아직 수집된 문자가 없어요"}
                </span>
              </span>
            </div>

            <div className="flex items-start gap-3">
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
                <HardDrive className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-medium">
                  파일 저장소 · {formatBytes(overview.retention.storedBytes)}
                </span>
                <span className="text-muted-foreground text-[13px] break-all">
                  {overview.retention.objectKeyPrefix} 경로에 문자 원문 파일이
                  보관돼요
                </span>
              </span>
            </div>
          </div>

          {/*
           * 지키지 못할 약속을 하지 않기 위한 문단이다. 자동 삭제·보존기간 선택은
           * 아직 구현돼 있지 않다 — 없다는 사실을 정확히 알리는 편이, 있는 척하는
           * 것보다 언제나 낫다.
           */}
          <p className="text-muted-foreground bg-muted rounded-xl p-4 text-[13px] leading-relaxed">
            지금은 보관 기간 제한이나 자동 삭제가 없어요. 동의를 철회하면 새
            문자 수집은 즉시 멈추지만,{" "}
            <strong className="font-medium">
              이미 보관된 문자 원문은 이 화면에서 지워지지 않아요.
            </strong>{" "}
            보관된 데이터 삭제는 준비 중이에요.
          </p>
        </CardContent>
      </Card>

      {/* ---- 4. 동의 이력 (append-only) ---- */}
      {overview.history.length > 0 ? (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[15px] font-medium">동의 이력</span>
              <span className="text-muted-foreground text-[13px]">
                동의와 철회 기록은 지워지지 않고 그대로 남아요
              </span>
            </div>
            <div className="flex flex-col divide-y">
              {overview.history.map((record) => (
                <HistoryRow key={record.id} record={record} />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <AlertDialog
        open={confirmingRevoke}
        onOpenChange={(open) => {
          if (!revoke.isPending) setConfirmingRevoke(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>동의를 철회할까요?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-left">
                <span>
                  등록한 기기{" "}
                  {overview.myActiveDeviceCount > 0
                    ? `${overview.myActiveDeviceCount}대의 `
                    : ""}
                  연결이 즉시 해제되고 새 카드 문자 수집이 멈춰요.
                </span>
                <span>
                  이미 보관된 문자 원문은 삭제되지 않아요. 다시 동의하면 기기를
                  새로 등록해 수집을 재개할 수 있어요.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              취소
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(event) => {
                // 다이얼로그가 스스로 닫히면 진행 표시를 보여줄 자리가 없다.
                event.preventDefault();
                revoke.mutate();
              }}
            >
              {revoke.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> 철회하고 있어요…
                </>
              ) : (
                "철회하기"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
