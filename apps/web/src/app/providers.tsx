"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { AuthProvider } from "@/lib/auth-context";
import { HouseholdProvider } from "@/lib/household-context";

/**
 * 앱 전역 Provider (Phase 5 §6.1).
 *
 * QueryClientProvider → AuthProvider → HouseholdProvider 순으로 감싼다.
 * HouseholdProvider는 useAuth().memberships에 의존하므로 AuthProvider 안쪽에 둔다.
 * QueryClient는 리렌더 간 재생성을 막기 위해 lazy state로 1회만 생성한다.
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
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <HouseholdProvider>{children}</HouseholdProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
