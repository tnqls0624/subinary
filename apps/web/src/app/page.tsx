"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 루트 진입 (Phase 5 §6.1)
 * 인증 상태에 따라 /dashboard 또는 /login으로 리다이렉트한다.
 * (Phase 0 health 대시보드는 GET /api/health route.ts 로 대체 유지.)
 * ------------------------------------------------------------------------- */
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ConnectionError } from "@/components/connection-error";
import { useAuth } from "@/lib/auth-context";

export default function RootPage() {
  const router = useRouter();
  const { status, retryBootstrap } = useAuth();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/dashboard");
    } else if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  // 세션 상태를 확인하지 못한 상태에서 아무 데로도 보내면 안 된다(로그인 화면으로
  // 보내는 게 정확히 그 버그였다). 여기서 멈추고 재시도만 제안한다.
  if (status === "offline") {
    return <ConnectionError onRetry={retryBootstrap} />;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center">
      <div
        className="text-muted-foreground flex items-center gap-2 text-sm"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span>불러오는 중…</span>
      </div>
    </main>
  );
}
