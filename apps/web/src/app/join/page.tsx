"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 초대 수락 (/join?token=..., 오늘의집 톤)
 *
 * (app) 그룹 밖 최상위 라우트 → 인증은 필요하되 가족 소속은 불필요(신규 가입자도 수락).
 * - loading: 스피너 / unauthenticated: 로그인·가입 안내 / token 없음: 유효하지 않은 초대.
 * - offline: 세션 확인 실패 → 수락 화면을 그리면 authedFetch가 확실히 실패하므로
 *   연결 안내 + 재시도로 막는다.
 * - authenticated: 동의 체크 후 수락 → POST /household-invitations/:token/accept
 *   → refreshMemberships + 활성 가족 전환 → 대시보드.
 * consent는 계약상 z.literal(true) 필수 → 체크 안 하면 수락 버튼 비활성.
 *
 * **어느 가족이 초대했는지 먼저 보여준 뒤 동의를 받는다**(C-1). 이전에는 가족명도
 * 초대자도 없이 "가족 데이터 공유에 동의해요"만 물었다 — 무엇에 동의하는지 모르는
 * 동의였다. 정보는 비인증 미리보기(GET /v1/household-invitations/:token)로 받는다.
 * 로그인 전에도 보이므로 로그인 화면으로 갈 때 `returnTo`를 실어 여정이 끊기지 않게 한다.
 *
 * 토큰은 쿼리 파라미터(?token=)에서 읽는다. 동적 세그먼트(/join/[token])는 정적
 * export(mobile 타깃)에서 generateStaticParams가 필요해 클라이언트 라우트로 부적합.
 * useSearchParams는 export에서 <Suspense> 경계를 요구하므로 default export에서 감싼다.
 * ------------------------------------------------------------------------- */
import { CheckCircle2, Clock, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  currentHouseholdConsentDocument,
  type HouseholdRole,
  type InvitationPreview,
} from "@family/contracts";

import { ConnectionError } from "@/components/connection-error";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHouseholdStore } from "@/lib/store";

/** 수락 시 부여될 역할의 한국어 설명(무엇에 동의하는지가 이 한 줄에 걸린다). */
const ROLE_LABEL: Record<HouseholdRole, string> = {
  owner: "소유자 — 가족의 모든 설정을 관리해요",
  admin: "관리자 — 예산과 구성원을 관리할 수 있어요",
  member: "구성원 — 지출을 함께 기록하고 볼 수 있어요",
  viewer: "보기 전용 — 기록을 볼 수만 있어요",
};

/** 더 이상 쓸 수 없는 초대의 상태별 안내(서버가 가족 정보를 주지 않는 상태들). */
const DEAD_INVITE_COPY: Record<
  Exclude<InvitationPreview["status"], "pending">,
  string
> = {
  accepted: "이미 수락된 초대예요. 초대한 가족에게 다시 물어봐 주세요.",
  revoked: "취소된 초대예요. 초대한 가족에게 링크를 다시 받아 주세요.",
  expired: "만료된 초대예요. 초대한 가족에게 링크를 다시 받아 주세요.",
};

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-background flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

/** 만료까지 남은 시간을 해요체 한 줄로. 이미 지났으면 만료 문구. */
function expiryLine(expiresAt: string): string {
  const remainMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(remainMs) || remainMs <= 0) return "이미 만료됐어요";
  const hours = Math.floor(remainMs / (60 * 60 * 1000));
  if (hours < 1) return "1시간 안에 만료돼요";
  if (hours < 24) return `약 ${hours}시간 뒤 만료돼요`;
  return `약 ${Math.floor(hours / 24)}일 뒤 만료돼요`;
}

/** 초대장 본문 — 가족·초대자·역할·만료. 동의 위에 항상 이게 먼저 온다. */
function InvitationCard({ preview }: { preview: InvitationPreview }) {
  return (
    <div className="bg-muted flex flex-col gap-3 rounded-xl p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground text-[13px]">초대한 가족</span>
        <span className="text-[15px] font-semibold">
          {preview.householdName}
        </span>
      </div>
      {preview.inviterName ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-[13px]">초대한 사람</span>
          <span className="text-[15px] font-medium">
            {preview.inviterName}님
          </span>
        </div>
      ) : null}
      {preview.role ? (
        <div className="text-muted-foreground flex items-start gap-2 text-[13px]">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{ROLE_LABEL[preview.role]}</span>
        </div>
      ) : null}
      <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        <span>{expiryLine(preview.expiresAt)}</span>
      </div>
      {preview.emailRestricted ? (
        <p className="text-muted-foreground text-[13px]">
          이 초대는 특정 이메일 앞으로 보냈어요. 초대받은 계정으로 로그인해야
          수락할 수 있어요.
        </p>
      ) : null}
    </div>
  );
}

function JoinInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { status, authedFetch, refreshMemberships, user, retryBootstrap } =
    useAuth();
  const setSelectedId = useHouseholdStore((s) => s.setSelectedId);

  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 미리보기는 비인증 경로라 세션 상태와 무관하게 곧바로 부른다 — 로그인 화면으로
  // 보내기 **전에** "어느 가족인지"를 보여줘야 사용자가 로그인할 이유를 안다.
  const previewQuery = useQuery({
    queryKey: ["invitation-preview", token],
    enabled: token !== "",
    retry: false,
    // 초대장 내용은 거의 바뀌지 않는다. 로그인 왕복 후 돌아와도 다시 안 부르게 둔다.
    staleTime: 5 * 60_000,
    queryFn: () => api.households.previewInvite(token),
  });
  const preview = previewQuery.data;

  async function onAccept() {
    setSubmitting(true);
    try {
      const household = await authedFetch((t) =>
        api.households.acceptInvite(t, token, { consent: true }),
      );
      await refreshMemberships();
      setSelectedId(household.id);
      toast.success(`'${household.name}' 가족에 참여했어요.`);
      router.replace("/dashboard");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.status === 404
            ? "유효하지 않은 초대예요."
            : err.status === 409
              ? "이미 처리됐거나 만료된 초대예요."
              : err.message
          : "초대를 수락하지 못했어요. 잠시 후 다시 시도해 주세요.";
      toast.error(message);
      setSubmitting(false);
    }
  }

  if (status === "loading") {
    return (
      <Centered>
        <div className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> 불러오고 있어요…
        </div>
      </Centered>
    );
  }

  if (status === "offline") {
    return <ConnectionError onRetry={retryBootstrap} />;
  }

  // 토큰 없이 진입(직접 URL/딥링크 파싱 실패) → 수락할 대상이 없다.
  // 서버가 404를 준 경우(존재하지 않는 토큰)도 사용자 입장에서는 같은 상황이다.
  const unknownInvite =
    token === "" ||
    (previewQuery.isError &&
      previewQuery.error instanceof ApiError &&
      previewQuery.error.status === 404);
  if (unknownInvite) {
    return (
      <Centered>
        <div className="flex flex-col gap-6 text-center">
          <h1 className="text-xl font-bold tracking-tight">
            유효하지 않은 초대예요
          </h1>
          <p className="text-muted-foreground text-sm">
            초대 링크가 올바르지 않아요. 초대한 가족에게 링크를 다시 받아 주세요.
          </p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href="/dashboard">홈으로</Link>
          </Button>
        </div>
      </Centered>
    );
  }

  // 수락·취소·만료된 초대 — 서버가 가족 정보를 주지 않는다. 사유만 정확히 알린다.
  if (preview && preview.status !== "pending") {
    return (
      <Centered>
        <div className="flex flex-col gap-6 text-center">
          <h1 className="text-xl font-bold tracking-tight">
            지금은 쓸 수 없는 초대예요
          </h1>
          <p className="text-muted-foreground text-sm">
            {DEAD_INVITE_COPY[preview.status]}
          </p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href="/dashboard">홈으로</Link>
          </Button>
        </div>
      </Centered>
    );
  }

  if (previewQuery.isLoading) {
    return (
      <Centered>
        <div className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> 초대를 확인하고 있어요…
        </div>
      </Centered>
    );
  }

  const invitationCard = preview ? <InvitationCard preview={preview} /> : null;

  if (status === "unauthenticated") {
    // 로그인 뒤 이 화면으로 정확히 되돌아오게 한다. 이전에는 로그인이 무조건
    // /dashboard로 가서, 기존 계정 사용자는 초대 링크를 다시 찾아 열어야 했다.
    const returnTo = `/join?token=${encodeURIComponent(token)}`;
    return (
      <Centered>
        <div className="flex flex-col gap-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="bg-accent text-accent-foreground flex size-14 items-center justify-center rounded-full">
              <Sparkles className="size-6" />
            </span>
            <h1 className="text-xl font-bold tracking-tight">
              {preview?.householdName
                ? `'${preview.householdName}' 가족이 초대했어요`
                : "가족 초대가 도착했어요"}
            </h1>
            <p className="text-muted-foreground text-sm">
              계속하려면 로그인이 필요해요. 로그인하면 이 화면으로 다시 돌아와요.
            </p>
          </div>

          {invitationCard}

          <div className="flex flex-col gap-2">
            <Button asChild size="lg" className="h-12 w-full">
              <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>
                로그인하고 계속하기
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg" className="w-full">
              <Link href={`/register?invite=${encodeURIComponent(token)}`}>
                회원가입하기
              </Link>
            </Button>
          </div>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="bg-accent text-accent-foreground flex size-14 items-center justify-center rounded-full">
            <Sparkles className="size-6" />
          </span>
          <h1 className="text-xl font-bold tracking-tight">
            {user?.name
              ? `${user.name}님, 가족 초대가 도착했어요`
              : "가족 초대가 도착했어요"}
          </h1>
          <p className="text-muted-foreground text-sm">
            초대를 수락하면 가족의 카드 지출과 예산을 함께 볼 수 있어요.
          </p>
        </div>

        {invitationCard}

        {/*
         * 동의 문구는 **코드가 단일 출처**다(@family/contracts). 여기에 문장을 직접
         * 적으면 서버가 기록하는 버전과 사용자가 실제로 읽은 문구가 갈라진다 —
         * 그러면 "누가 어느 문구에 동의했는가"를 나중에 답할 수 없다(C-3).
         * 문구를 고치려면 contracts에서 새 버전을 만들고 상수를 올린다.
         */}
        <div className="bg-muted flex flex-col gap-3 rounded-xl p-4 text-sm">
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span className="font-medium">
              {currentHouseholdConsentDocument.headline}
            </span>
          </label>
          <div className="flex flex-col gap-2 pl-7">
            {currentHouseholdConsentDocument.clauses.map((clause) => (
              <span key={clause.title} className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium">{clause.title}</span>
                <span className="text-muted-foreground text-[13px] leading-relaxed">
                  {clause.body}
                </span>
              </span>
            ))}
          </div>
          <p className="text-muted-foreground pl-7 text-[12px]">
            동의한 문구와 시각은 더보기 › 개인정보에서 언제든 다시 볼 수 있어요.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="h-12 w-full"
            onClick={onAccept}
            disabled={!consent || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 참여하고 있어요…
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4" /> 초대 수락하기
              </>
            )}
          </Button>
          <Button
            asChild
            variant="ghost"
            size="lg"
            className="w-full"
            disabled={submitting}
          >
            <Link href="/dashboard">나중에 할게요</Link>
          </Button>
        </div>
      </div>
    </Centered>
  );
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <Centered>
          <div className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> 불러오고 있어요…
          </div>
        </Centered>
      }
    >
      <JoinInner />
    </Suspense>
  );
}
