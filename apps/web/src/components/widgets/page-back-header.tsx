"use client";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { canGoBackInApp } from "@/lib/nav-history";

/**
 * 하위 페이지 공통 헤더 — 좌측 뒤로가기(←) + 제목(+선택 부제/우측 액션).
 *
 * **뒤로가기는 사용자가 온 길로 간다.** 예전에는 `backHref` 기본값이 `/more` 고정이라
 * `/todo`에서 `/declines`로 들어간 사람이 `/more`로 튀었다 — 가본 적 없는 화면이다.
 * 지금은 앱 안에서 이동해 온 경우 브라우저 뒤로가기를 쓰고, 딥링크·새로고침으로 이
 * 화면을 처음 연 경우에만 `backHref`(기본 `/more`)로 밀어 준다(lib/nav-history.ts).
 *
 * 진입 경로가 **하나뿐인 화면**은 `backHref`를 명시해도 좋다 — 그때는 항상 그 경로다.
 *
 * 뒤로가기 버튼은 44×44 — 터치 타깃 최소치다(그 아래로 줄이면 모바일에서 헛손질이
 * 늘고, 이 버튼은 화면당 유일한 탈출구다).
 */
export function PageBackHeader({
  title,
  subtitle,
  action,
  backHref = "/more",
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  /** 앱 안 이동 기록이 없을 때(딥링크·새로고침) 돌아갈 경로. */
  backHref?: string;
}) {
  const router = useRouter();

  return (
    <div className="flex items-start gap-2">
      {/* 링크가 아니라 버튼인 이유: 목적지가 렌더 시점이 아니라 **누른 시점의 이동
          기록**에 따라 정해진다. 접근성용 이름은 아래 aria-label이 준다. */}
      <button
        type="button"
        aria-label="뒤로"
        onClick={() => {
          if (canGoBackInApp()) router.back();
          else router.push(backHref);
        }}
        className="hover:bg-muted -ml-2.5 flex size-11 shrink-0 items-center justify-center rounded-full transition-colors"
      >
        <ArrowLeft className="size-5" />
      </button>
      <div className="min-w-0 flex-1 pt-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
