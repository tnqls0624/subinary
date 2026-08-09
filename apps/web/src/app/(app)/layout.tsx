"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 인증 앱 셸 (오늘의집 벤치마킹)
 *
 * - 주 네비게이션 = **하단 탭바(글로벌)**: 매일 오는 목적지(홈/거래/예산/할 일)를
 *   탭으로, 차별점인 AI를 중앙 강조 원형 버튼으로 승격한다. 저빈도 관리(가족/카드/
 *   기기/카테고리)는 `/more`로 모으고 **헤더 아바타가 그 1탭 진입점**이다.
 *   활성 탭은 진한 텍스트, 비활성은 회색. 관리 영역은 아바타 링으로 표시한다.
 * - 상단 헤더: 브랜드 + 가족 스위처(좌) / 알림·테마·아바타(우). 모든 화면에서
 *   sticky라 관리 화면이 갇히지 않는다(탭에서 내렸을 때의 유일한 위험이었다).
 * - 인증 가드: bootstrap 대기(loading) → 실패 시 /login 리다이렉트.
 * - 멤버십 0개: 탭바 없이 <Onboarding/>(가족 생성/초대 수락)만 노출.
 * ------------------------------------------------------------------------- */
import {
  Bell,
  CreditCard,
  Home,
  ListChecks,
  Loader2,
  Receipt,
  Sparkles,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { AccountLink } from "@/components/account-link";
import {
  ActivityProvider,
  useActivityStore,
} from "@/components/activity-provider";
import { ConnectionError } from "@/components/connection-error";
import { Onboarding } from "@/components/onboarding";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { useTodoCounts } from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { noteInAppNavigation } from "@/lib/nav-history";
import { activeTabFor, type TabKey } from "@/lib/nav-tabs";
import { useUnreadCount } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * 하단 탭: 좌 2개(홈·거래) + [중앙 AI 강조] + 우 2개(예산·할 일).
 * AI는 별도의 중앙 원형 버튼으로 렌더하므로 이 배열에서 제외한다.
 *
 * ── 왜 '더보기' 탭이 없는가 (다음 사람이 가장 먼저 묻는 것) ──────────────────
 * 슬롯 5칸이 꽉 찬 상태에서 '할 일'을 넣어야 했다. 검토한 안과 결론:
 *  (a) 6칸으로 확장 — 작은 기기에서 라벨이 깨지고, 중앙 AI 버튼의 시각적 중심이
 *      무너진다(홀수 칸이라야 가운데가 가운데다).
 *  (b) '예산'을 /more로 — 예산은 데일리 목적지이고 월 원장(C-4)까지 붙었다. 탈락.
 *  (c) **'더보기'를 헤더 아바타로 올리고 그 슬롯에 '할 일'** ← 채택.
 *      관리 화면(가족·카드·기기·카테고리)은 매일 가는 곳이 아니고, 매일 생기는
 *      처리 작업은 '할 일'이다. 탭은 **빈도**로 정한다.
 *
 * 지킨 제약: `/more`는 여전히 **1탭**이다 — 헤더 아바타가 드롭다운이 아니라 링크다
 * (components/account-link.tsx). 활성 표시도 사라지지 않았다 — 예전 `MORE_PATHS`는
 * `ACCOUNT_PATHS`로 그대로 옮겨 가 아바타의 링으로 나타난다(lib/nav-tabs.ts).
 * 헤더는 이 레이아웃의 모든 화면에서 sticky로 항상 보이므로 관리 화면이 갇히지
 * 않는다(멤버십 0개 온보딩 화면은 예전 드롭다운 UserMenu를 그대로 쓴다 — 거기서는
 * /more가 열리지 않으므로 로그아웃이 드롭다운에만 있다).
 * ─────────────────────────────────────────────────────────────────────────
 */
const LEFT_ITEMS: ReadonlyArray<NavItem> = [
  { href: "/dashboard", label: "홈", icon: Home },
  { href: "/transactions", label: "거래", icon: Receipt },
];
const RIGHT_ITEMS: ReadonlyArray<NavItem> = [
  { href: "/budgets", label: "예산", icon: Wallet },
  { href: "/todo", label: "할 일", icon: ListChecks },
];

/** 탭 경로 → 활성 판정 키(lib/nav-tabs.ts의 `TabKey`). */
const TAB_OF: Readonly<Record<string, TabKey>> = {
  "/dashboard": "home",
  "/transactions": "transactions",
  "/budgets": "budgets",
  "/todo": "todo",
};

function BrandMark() {
  return (
    <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
      <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
        <CreditCard className="size-4" />
      </span>
      <span className="hidden text-sm font-bold tracking-tight sm:inline">
        모아
      </span>
    </Link>
  );
}

/** 헤더 알림 벨 + 안읽음 뱃지. 탭 → /notifications. */
function NotificationBell() {
  const { data } = useUnreadCount();
  const count = data?.count ?? 0;
  return (
    <Link
      href="/notifications"
      aria-label={count > 0 ? `알림 ${count}건` : "알림"}
      // size-11 = 44px 터치 타깃(헤더 아이콘 3개를 같은 크기로 맞춘다).
      className="hover:bg-muted relative flex size-11 items-center justify-center rounded-full transition-colors"
    >
      <Bell className="size-5" aria-hidden="true" />
      {count > 0 ? (
        <span className="bg-destructive text-destructive-foreground absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold">
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * 일반 하단 탭 1개(홈/거래/예산/할 일).
 *
 * 배지가 **두 종류**인 이유: 두 탭이 동시에 빨간 숫자를 달면 어느 쪽이 급한지
 * 알 수 없다. 성격이 다르므로 모양을 다르게 한다.
 *  - `count`(할 일) = **처리해야 하는 것**. 숫자를 보여 준다 — 몇 건 남았는지가
 *    행동의 크기이고, 처리해야만 사라진다.
 *  - `dot`(거래)   = **새로 들어온 것**. 숫자를 뗐다 — 탭을 열어보면 해제되는
 *    알림성 신호라 건수가 행동을 바꾸지 않는다. 점 하나면 "볼 게 있다"로 충분하다.
 */
function BottomTab({
  item,
  active,
  count = 0,
  dot = false,
  countLabel,
}: {
  item: NavItem;
  active: boolean;
  /** 숫자 배지로 표시할 처리 대기 건수(0이면 배지 없음). */
  count?: number;
  /** 숫자 없는 점 배지(새 항목 알림). */
  dot?: boolean;
  /** 숫자 배지의 스크린리더 문구. */
  countLabel?: (n: number) => string;
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
        {count > 0 ? (
          <span
            aria-label={countLabel?.(count)}
            className="bg-destructive text-destructive-foreground absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
          >
            {count > 9 ? "9+" : count}
          </span>
        ) : dot ? (
          <span
            aria-label="새 항목이 있어요"
            className="bg-accent-foreground ring-background absolute -top-0.5 -right-1 size-2 rounded-full ring-2"
          />
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
  // 활성 판정은 lib/nav-tabs.ts가 소유한다(테스트 있음) — 인라인 배열로 두면
  // 경로가 늘 때마다 조용히 깨진다.
  const activeTab = activeTabFor(pathname);
  const aiActive = activeTab === "ai";
  // 미확인 새 거래(ActivityProvider가 갱신, 거래 탭 방문 시 해제) — 점 배지.
  const unseenCount = useActivityStore((s) => s.unseenCount);
  // 할 일 배지 = C-8이 분리해 둔 훅의 합계를 **그대로** 쓴다. 세는 규칙을 여기서
  // 다시 구현하면 화면마다 숫자가 갈린다(이 저장소가 반복해서 앓은 병이다).
  const todoTotal = useTodoCounts().total;

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
            active={activeTab === TAB_OF[item.href]}
            dot={item.href === "/transactions" && unseenCount > 0}
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

        {RIGHT_ITEMS.map((item) => (
          <BottomTab
            key={item.href}
            item={item}
            active={activeTab === TAB_OF[item.href]}
            count={item.href === "/todo" ? todoTotal : 0}
            countLabel={(n) => `처리할 일 ${n}건`}
          />
        ))}
      </div>
    </nav>
  );
}

export default function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, memberships, retryBootstrap } = useAuth();
  const { householdId } = useHousehold();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  // 앱 안에서 화면이 바뀔 때마다 1회 — `PageBackHeader`의 뒤로가기가 "사용자가 온
  // 길"과 "딥링크로 방금 연 화면"을 구분하는 데 쓴다(lib/nav-history.ts).
  useEffect(() => {
    noteInAppNavigation();
  }, [pathname]);

  // 통신 실패로 세션을 확인하지 못한 상태 — 리다이렉트하지 않고 재시도만 제안한다.
  if (status === "offline") {
    return <ConnectionError onRetry={retryBootstrap} />;
  }

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
          {/* 아바타 = 관리 화면(/more) 1탭 진입점. '더보기' 탭이 여기로 올라왔다. */}
          <div className="flex shrink-0 items-center gap-1">
            <NotificationBell />
            <ThemeToggle />
            <AccountLink />
          </div>
        </div>
      </header>

      {/* 하단 탭바 높이(safe-area 포함)만큼 pb 확보 + 여유 1.5rem.
          고정값(pb-28=112px)은 iPhone(inset 34px)에서 탭바 총높이(114px)보다 작아
          마지막 콘텐츠가 탭바 밑에 깔렸다 — 변수 참조로 기기별 편차를 흡수한다. */}
      {/* 당겨서 새로고침 — 화면의 활성 쿼리만 다시 가져온다(전역 1회 배선). */}
      <main className="flex-1 px-4 pt-6 pb-[calc(var(--app-tabbar-h)+1.5rem)]">
        <PullToRefresh>{householdId ? children : <Onboarding />}</PullToRefresh>
      </main>

      {/* 전역 결제 활동 레이어 — SSE/폴링으로 새 거래를 감지해 무효화+토스트+배지. */}
      <ActivityProvider />
      <BottomNav pathname={pathname} />
    </div>
  );
}
