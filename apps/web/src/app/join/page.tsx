"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 초대 수락 (/join?token=..., 오늘의집 톤)
 *
 * (app) 그룹 밖 최상위 라우트 → 인증은 필요하되 가족 소속은 불필요(신규 가입자도 수락).
 * - loading: 스피너 / unauthenticated: 로그인 안내 / token 없음: 유효하지 않은 초대.
 * - authenticated: 동의 체크 후 수락 → POST /household-invitations/:token/accept
 *   → refreshMemberships + 활성 가족 전환 → 대시보드.
 * consent는 계약상 z.literal(true) 필수 → 체크 안 하면 수락 버튼 비활성.
 *
 * 토큰은 쿼리 파라미터(?token=)에서 읽는다. 동적 세그먼트(/join/[token])는 정적
 * export(mobile 타깃)에서 generateStaticParams가 필요해 클라이언트 라우트로 부적합.
 * useSearchParams는 export에서 <Suspense> 경계를 요구하므로 default export에서 감싼다.
 * ------------------------------------------------------------------------- */
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHouseholdStore } from "@/lib/store";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-background flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

function JoinInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { status, authedFetch, refreshMemberships, user } = useAuth();
  const setSelectedId = useHouseholdStore((s) => s.setSelectedId);

  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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

  // 토큰 없이 진입(직접 URL/딥링크 파싱 실패) → 수락할 대상이 없다.
  if (!token) {
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

  if (status === "unauthenticated") {
    return (
      <Centered>
        <div className="flex flex-col gap-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="bg-accent text-accent-foreground flex size-14 items-center justify-center rounded-full">
              <Sparkles className="size-6" />
            </span>
            <h1 className="text-xl font-bold tracking-tight">
              먼저 로그인해 주세요
            </h1>
            <p className="text-muted-foreground text-sm">
              가족 초대를 수락하려면 로그인이 필요해요. 로그인한 뒤 이 링크를
              다시 열어 주세요.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button asChild size="lg" className="h-12 w-full">
              <Link href="/login">로그인하기</Link>
            </Button>
            <Button asChild variant="ghost" size="lg" className="w-full">
              <Link href="/register">회원가입하기</Link>
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

        <label className="bg-muted flex cursor-pointer items-start gap-3 rounded-xl p-4 text-sm">
          <input
            type="checkbox"
            className="border-input text-primary focus-visible:ring-ring/50 mt-0.5 size-4 rounded-sm border focus-visible:ring-[3px]"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">가족 데이터 공유에 동의해요</span>
            <span className="text-muted-foreground text-[13px]">
              공동 지출과 예산을 가족끼리 서로 열람할 수 있어요.
            </span>
          </span>
        </label>

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
