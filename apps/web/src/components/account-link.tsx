"use client";
/* ---------------------------------------------------------------------------
 * 헤더 아바타 = 관리 화면(`/more`) 진입점 (IA 개편)
 *
 * '더보기' 탭 자리를 '할 일'에 내주면서 관리 화면 진입점이 헤더로 올라왔다.
 * **탭 한 번으로 `/more`에 닿아야 한다** — 아바타를 눌러 메뉴가 열리고 거기서 또
 * 눌러야 하면 예전보다 한 번 더 누르는 것이고, 그건 개선이 아니라 후퇴다.
 * 그래서 드롭다운이 아니라 링크다. 로그아웃·계정 정보는 `/more`의 '내 계정' 묶음이
 * 갖는다(가족이 없어 `/more`가 안 열리는 온보딩 화면만 예전 드롭다운을 그대로 쓴다).
 * ------------------------------------------------------------------------- */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/lib/auth-context";
import { activeTabFor } from "@/lib/nav-tabs";
import { cn } from "@/lib/utils";

/** 이름/이메일에서 아바타 이니셜 1글자. */
function initial(name?: string | null, email?: string | null): string {
  const src = (name ?? email ?? "?").trim();
  return src ? src[0]!.toUpperCase() : "?";
}

export function AccountLink() {
  const { user } = useAuth();
  const pathname = usePathname();
  // 관리 화면에 있는 동안 링(ring)으로 표시한다 — 예전 '더보기' 탭의 활성 표시가
  // 사라지면 사용자는 자기가 어느 영역에 있는지 알 수 없다.
  const active = activeTabFor(pathname) === "account";

  return (
    <Link
      href="/more"
      aria-label="내 계정과 관리"
      aria-current={active ? "page" : undefined}
      // size-11 = 44px 터치 타깃.
      className={cn(
        "hover:bg-muted flex size-11 items-center justify-center rounded-full transition-colors",
        active && "bg-muted",
      )}
    >
      <Avatar className={cn("size-8", active && "ring-primary ring-2")}>
        <AvatarFallback className="bg-primary/10 text-primary text-sm">
          {initial(user?.name, user?.email)}
        </AvatarFallback>
      </Avatar>
    </Link>
  );
}
