"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 네이티브(Capacitor) 부트스트랩
 *
 * initNative는 웹에서 즉시 반환하므로(no-op) 이 컴포넌트는 웹/네이티브 공용으로 안전하다.
 * 네이티브에서만: 스플래시 제거·상태바·딥링크(초대 링크)·Android 뒤로가기를 초기화한다.
 * 딥링크는 클라이언트 라우팅으로 넘겨 앱 내 화면 전환으로 처리한다.
 * ------------------------------------------------------------------------- */
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { applyStatusBarStyle, initKeyboardUx, initNative } from "@/lib/native";

export function NativeBootstrap() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    void initNative({
      onDeepLink: (path) => router.push(path),
      canGoBack: () => window.history.length > 1,
      // 포그라운드 복귀 시 전체 쿼리를 stale 처리 → 보이는 화면부터 refetch.
      // 웹뷰는 복귀해도 리로드되지 않고 refetchOnWindowFocus도 꺼져 있어,
      // 이 훅이 없으면 다른 가족의 거래/수정이 영영 반영되지 않는다.
      onAppActive: () => void queryClient.invalidateQueries(),
    });
    // 키보드 UX(탭바 접기·iOS 사파리 웹 inset 폴백)는 웹/네이티브 공용.
    void initKeyboardUx();
  }, [router, queryClient]);

  // 상태바 아이콘 색을 앱 테마에 동기화(라이트=어두운 아이콘, 다크=흰 아이콘).
  useEffect(() => {
    if (!resolvedTheme) return;
    void applyStatusBarStyle(resolvedTheme === "dark");
  }, [resolvedTheme]);

  return null;
}
