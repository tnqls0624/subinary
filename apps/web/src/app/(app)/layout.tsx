"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 인증 앱 셸 (Phase 5 §6.1)
 *
 * - 인증 가드: bootstrap 대기(loading) → 실패 시 /login 리다이렉트.
 * - 사이드바 네비: 대시보드/거래/예산/장치/가족.
 * - 상단바: 가족 선택(멤버십 2개↑일 때 드롭다운) + 사용자/로그아웃.
 * ------------------------------------------------------------------------- */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { Select } from "@/components";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";

interface NavItem {
  href: string;
  label: string;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: "/dashboard", label: "대시보드" },
  { href: "/transactions", label: "거래" },
  { href: "/budgets", label: "예산" },
  { href: "/devices", label: "장치" },
  { href: "/household", label: "가족" },
];

export default function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, user, logout } = useAuth();
  const { householdId, setHouseholdId, memberships } = useHousehold();

  // 인증 가드: unauthenticated로 확정되면 로그인으로.
  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <main className="centered-screen">
        <div className="loader" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>불러오는 중…</span>
        </div>
      </main>
    );
  }

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  const householdOptions = memberships.map((m) => ({
    value: m.householdId,
    label: m.name,
  }));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">Family Memory</div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${active ? " nav-link-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            {memberships.length > 1 ? (
              <Select
                aria-label="가족 선택"
                value={householdId ?? ""}
                options={householdOptions}
                onChange={(e) => setHouseholdId(e.target.value)}
              />
            ) : (
              <span className="topbar-household">
                {memberships[0]?.name ?? "가족 없음"}
              </span>
            )}
          </div>
          <div className="topbar-right">
            <span className="topbar-user">{user?.name ?? ""}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
              로그아웃
            </button>
          </div>
        </header>

        <main className="app-content">
          {memberships.length === 0 ? (
            <div className="empty-state">
              <p>아직 소속된 가족이 없습니다.</p>
              <p className="empty-state-sub">
                가족을 만들거나 초대를 수락하면 대시보드를 이용할 수 있어요.
              </p>
              <Link href="/household" className="btn btn-primary btn-md">
                가족 관리로 이동
              </Link>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
