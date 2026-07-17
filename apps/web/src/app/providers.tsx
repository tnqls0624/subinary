"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";

import { QueryClient } from "@tanstack/react-query";

import { AuthProvider } from "@/lib/auth-context";
import { Toaster } from "@/components/ui/sonner";

/**
 * 앱 전역 Provider.
 *
 * ThemeProvider(next-themes) → QueryClientProvider → AuthProvider 순.
 * - 활성 household 상태는 Zustand(useHouseholdStore)로 이동 → Provider 불필요.
 * - defaultTheme="system": 전 페이지가 디자인 토큰 기반이라 다크 완전 지원.
 * - QueryClient는 리렌더 간 재생성을 막기 위해 lazy state로 1회만 생성한다.
 */
export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 30_000,
          },
        },
      }),
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
