"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 루트 진입 (Phase 5 §6.1)
 * 인증 상태에 따라 /dashboard 또는 /login으로 리다이렉트한다.
 * (Phase 0 health 대시보드는 GET /api/health route.ts 로 대체 유지.)
 * ------------------------------------------------------------------------- */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/lib/auth-context";

export default function RootPage() {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/dashboard");
    } else if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  return (
    <main className="centered-screen">
      <div className="loader" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>불러오는 중…</span>
      </div>
    </main>
  );
}
