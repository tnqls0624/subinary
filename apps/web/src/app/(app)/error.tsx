"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 앱 셸 에러 바운더리 ((app) 하위 전 화면)
 *
 * App Router는 세그먼트에 error.tsx가 없으면 렌더 예외를 위로 올려 **앱 전체**를
 * 빈 화면으로 만든다. 실제로 알림 한 건(`decline`)의 메타 조회 실패가 알림함이 아니라
 * 앱 전체를 죽였다. 화면 하나의 버그가 앱을 못 쓰게 만들지 않도록 여기서 잡고,
 * 재시도(reset)와 탈출 경로(홈)를 준다.
 *
 * 주의: error.tsx는 **같은 세그먼트의 layout.tsx** 예외는 잡지 못한다(상위 바운더리
 * 몫). (app)/layout.tsx가 터지는 경우는 여전히 빈 화면이다.
 * ------------------------------------------------------------------------- */
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function AppError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  // 프로덕션 빌드는 메시지를 지우고 digest만 남기므로, 최소한 콘솔·Dozzle에는 남긴다.
  useEffect(() => {
    console.error("[app] render error", error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 py-10">
      <Card className="flex flex-col items-center gap-5 p-8 text-center">
        <span className="bg-destructive/10 text-destructive flex size-14 items-center justify-center rounded-full">
          <CircleAlert className="size-6" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-bold tracking-tight">
            화면을 표시하지 못했어요
          </h1>
          <p className="text-muted-foreground text-sm">
            일시적인 문제일 수 있어요. 다시 시도해도 같으면 홈으로 돌아가 주세요.
            저장된 데이터는 그대로 있어요.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <Button size="lg" className="h-12 w-full" onClick={() => reset()}>
            다시 시도
          </Button>
          <Button asChild variant="ghost" size="lg" className="w-full">
            <Link href="/dashboard">홈으로</Link>
          </Button>
        </div>
        {/* digest는 서버 로그와 화면을 맞춰보는 유일한 단서다(운영자 = 사용자). */}
        {error.digest ? (
          <p className="text-muted-foreground font-mono text-[11px]">
            {error.digest}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
