"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 인증 앱 셸 (오늘의집 벤치마킹)
 *
 * - 주 네비게이션 = **하단 탭바(글로벌)**: 모든 뷰포트에서 고정 하단 5탭.
 *   사이드바 없음. 활성 탭은 진한 텍스트(오늘의집 방식), 비활성은 회색.
 * - 상단 헤더: 브랜드 + 가족 스위처(좌) / 테마 토글 + 사용자 메뉴(우).
 * - 인증 가드: bootstrap 대기(loading) → 실패 시 /login 리다이렉트.
 * - 멤버십 0개: 탭바 없이 <Onboarding/>(가족 생성/초대 수락)만 노출.
 * ------------------------------------------------------------------------- */
import {
  CreditCard,
  Home,
  Loader2,
  Receipt,
  Smartphone,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { Onboarding } from "@/components/onboarding";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: "/dashboard", label: "홈", icon: Home },
  { href: "/transactions", label: "거래", icon: Receipt },
  { href: "/budgets", label: "예산", icon: Wallet },
  { href: "/devices", label: "장치", icon: Smartphone },
  { href: "/household", label: "가족", icon: Users },
];

function BrandMark() {
  return (
    <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
      <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
        <CreditCard className="size-4" />
      </span>
      <span className="hidden text-sm font-bold tracking-tight sm:inline">
        Family Memory
      </span>
    </Link>
  );
}

/** 글로벌 하단 탭바 — 모든 뷰포트 공통 주 네비게이션. */
function BottomNav({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="주 메뉴"
      className="bg-background/95 fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="mx-auto grid w-full max-w-lg grid-cols-5">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-1 pt-2.5 pb-2 text-[11px] transition-colors active:scale-95",
                active
                  ? "text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon
                className="size-5"
                strokeWidth={active ? 2.4 : 1.8}
                aria-hidden="true"
              />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, memberships } = useAuth();
  const { householdId } = useHousehold();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <div
          className="text-muted-foreground flex items-center gap-2 text-sm"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin" />
          불러오는 중…
        </div>
      </main>
    );
  }

  // 멤버십 0개 → 온보딩(탭바 없이).
  if (memberships.length === 0) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="bg-background/90 sticky top-0 z-30 flex h-14 items-center justify-between border-b px-4 backdrop-blur">
          <BrandMark />
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-4">
          <Onboarding />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-background/90 sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b px-4 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark />
          <HouseholdSwitcher />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      {/* 하단 탭바 높이만큼 pb 확보 */}
      <main className="flex-1 px-4 pt-6 pb-28">
        {householdId ? children : <Onboarding />}
      </main>

      <BottomNav pathname={pathname} />
    </div>
  );
}
