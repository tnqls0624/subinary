"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 인증 앱 셸 (오늘의집 벤치마킹)
 *
 * - 주 네비게이션 = **하단 탭바(글로벌)**: 데일리 목적지(홈/거래/예산)를 탭으로,
 *   차별점인 AI를 중앙 강조 원형 버튼으로 승격한다. 저빈도 관리(가족/장치)는
 *   '더보기'로 모은다(1탭 거리 유지). 활성 탭은 진한 텍스트, 비활성은 회색.
 * - 상단 헤더: 브랜드 + 가족 스위처(좌) / 테마 토글 + 사용자 메뉴(우).
 * - 인증 가드: bootstrap 대기(loading) → 실패 시 /login 리다이렉트.
 * - 멤버십 0개: 탭바 없이 <Onboarding/>(가족 생성/초대 수락)만 노출.
 * ------------------------------------------------------------------------- */
import {
  CreditCard,
  Home,
  LayoutGrid,
  Loader2,
  Receipt,
  Sparkles,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import {
  ActivityProvider,
  useActivityStore,
} from "@/components/activity-provider";
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

/**
 * 하단 탭: 좌 2개(홈·거래) + [중앙 AI 강조] + 우 2개(예산·더보기).
 * AI는 별도의 중앙 원형 버튼으로 렌더하므로 이 배열에서 제외한다.
 * '더보기'는 /more 및 그 하위 관리 화면(/household·/devices)에서 활성으로 본다.
 */
const LEFT_ITEMS: ReadonlyArray<NavItem> = [
  { href: "/dashboard", label: "홈", icon: Home },
  { href: "/transactions", label: "거래", icon: Receipt },
];
const RIGHT_ITEMS: ReadonlyArray<NavItem> = [
  { href: "/budgets", label: "예산", icon: Wallet },
  { href: "/more", label: "더보기", icon: LayoutGrid },
];
/** '더보기' 탭이 활성으로 취급하는 관리 경로(하위 목적지 포함). */
const MORE_PATHS = ["/more", "/household", "/cards", "/devices", "/categories"];

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

/** 일반 하단 탭 1개(홈/거래/예산/더보기). badge는 미확인 새 거래 수(거래 탭). */
function BottomTab({
  item,
  active,
  badge = 0,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center gap-1 pt-2.5 pb-2 text-[11px] transition-colors active:scale-95",
        active
          ? "text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="relative">
        <Icon
          className="size-5"
          strokeWidth={active ? 2.4 : 1.8}
          aria-hidden="true"
        />
        {badge > 0 ? (
          <span
            aria-label={`새 거래 ${badge}건`}
            className="bg-destructive text-destructive-foreground absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
          >
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
      </span>
      {item.label}
    </Link>
  );
}

/**
 * 글로벌 하단 탭바 — 데일리 탭(홈·거래 / 예산·더보기) + 중앙 AI 강조 버튼.
 * 중앙 버튼은 원형 primary로 살짝 떠 있어(차별점 강조) 즉시 눈에 띈다.
 */
function BottomNav({ pathname }: { pathname: string }) {
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const moreActive = MORE_PATHS.some((p) => isActive(p));
  const aiActive = isActive("/ai");
  // 미확인 새 거래 배지(ActivityProvider가 갱신, 거래 탭 방문 시 해제).
  const unseenCount = useActivityStore((s) => s.unseenCount);

  return (
    // data-bottom-nav: 키보드 표시 중(html.kb-open) globals.css가 숨긴다.
    // 콘텐츠 높이 h-20은 globals.css의 --app-tabbar-h(5rem)와 단일 출처로 동기 —
    // 자연 높이(중앙 AI 버튼이 지배, ~78.5px)에 의존하면 기기·폰트별로 흔들려
    // iPhone에서 입력바가 탭바 밑에 깔리는 회귀가 재발한다.
    <nav
      aria-label="주 메뉴"
      data-bottom-nav
      className="bg-background/95 fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="mx-auto grid h-20 w-full max-w-lg grid-cols-5 items-center">
        {LEFT_ITEMS.map((item) => (
          <BottomTab
            key={item.href}
            item={item}
            active={isActive(item.href)}
            badge={item.href === "/transactions" ? unseenCount : 0}
          />
        ))}

        {/* 중앙 AI 강조 버튼 */}
        <div className="flex justify-center">
          <Link
            href="/ai"
            aria-label="AI 도우미"
            aria-current={aiActive ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-1 transition-transform active:scale-95",
            )}
          >
            <span
              className={cn(
                "flex size-12 -translate-y-3 items-center justify-center rounded-full shadow-md ring-4 transition-colors",
                "ring-background",
                aiActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              <Sparkles className="size-6" strokeWidth={2.2} aria-hidden="true" />
            </span>
            <span
              className={cn(
                "-mt-2 pb-2 text-[11px]",
                aiActive
                  ? "text-foreground font-semibold"
                  : "text-muted-foreground",
              )}
            >
              AI
            </span>
          </Link>
        </div>

        {RIGHT_ITEMS.map((item) => {
          const active =
            item.href === "/more" ? moreActive : isActive(item.href);
          return <BottomTab key={item.href} item={item} active={active} />;
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
        <header className="bg-background/90 sticky top-0 z-30 border-b pt-[env(safe-area-inset-top)] backdrop-blur">
          <div className="flex h-14 items-center justify-between px-4">
            <BrandMark />
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <UserMenu />
            </div>
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
      {/* pt-[env(safe-area-inset-top)]: 상태바(노치) 영역만큼 헤더를 밀어 겹침 방지 */}
      <header className="bg-background/90 sticky top-0 z-30 border-b pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark />
            <HouseholdSwitcher />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* 하단 탭바 높이(safe-area 포함)만큼 pb 확보 + 여유 1.5rem.
          고정값(pb-28=112px)은 iPhone(inset 34px)에서 탭바 총높이(114px)보다 작아
          마지막 콘텐츠가 탭바 밑에 깔렸다 — 변수 참조로 기기별 편차를 흡수한다. */}
      <main className="flex-1 px-4 pt-6 pb-[calc(var(--app-tabbar-h)+1.5rem)]">
        {householdId ? children : <Onboarding />}
      </main>

      {/* 전역 결제 활동 레이어 — SSE/폴링으로 새 거래를 감지해 무효화+토스트+배지. */}
      <ActivityProvider />
      <BottomNav pathname={pathname} />
    </div>
  );
}
