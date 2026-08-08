"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 연결 실패 안내 (세션 복원 재시도)
 *
 * status === "offline"에서 쓴다. 세션이 살아 있는데 통신만 안 된 상황이므로
 * /login으로 보내지 않고 재시도만 제안한다. 다만 정말 로그아웃 상태인지 판별할 수
 * 없는 상태이기도 하므로 로그인 화면으로 나갈 길도 함께 둔다(오프라인 + 미로그인
 * 사용자가 이 화면에 갇히지 않게).
 * ------------------------------------------------------------------------- */
import { WifiOff } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export function ConnectionError({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div
        className="flex w-full max-w-sm flex-col items-center gap-6 text-center"
        role="alert"
      >
        <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
          <WifiOff className="size-6" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-bold tracking-tight">
            연결에 문제가 있어요
          </h1>
          <p className="text-muted-foreground text-sm">
            네트워크나 서버가 잠시 불안정한 것 같아요. 로그인은 그대로 유지되니
            연결이 돌아오면 다시 시도해 주세요.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <Button size="lg" className="h-12 w-full" onClick={onRetry}>
            다시 시도
          </Button>
          <Button asChild variant="ghost" size="lg" className="w-full">
            <Link href="/login">로그인 화면으로</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
