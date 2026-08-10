"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 네이티브(Capacitor) 부트스트랩
 *
 * initNative는 웹에서 즉시 반환하므로(no-op) 이 컴포넌트는 웹/네이티브 공용으로 안전하다.
 * 네이티브에서만: 스플래시 제거·상태바·딥링크(초대 링크)·Android 뒤로가기를 초기화한다.
 * 딥링크는 클라이언트 라우팅으로 넘겨 앱 내 화면 전환으로 처리한다.
 *
 * 뒤로가기 판정이 여기 있는 이유: 무엇을 할지는 **지금 어느 화면인가**에 달렸는데,
 * 그 값(pathname·라우터)은 React 쪽에만 있다. 규칙 자체는 순수 모듈에 있다
 * (lib/back-button.ts + lib/nav-tabs.ts의 isTabRoot).
 * ------------------------------------------------------------------------- */
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { decideBackAction } from "@/lib/back-button";
import { canGoBackInApp } from "@/lib/nav-history";
import { isTabRoot, normalizePath } from "@/lib/nav-tabs";
import {
  applyStatusBarStyle,
  exitApp,
  initKeyboardUx,
  initNative,
} from "@/lib/native";

export function NativeBootstrap() {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();

  // initNative는 마운트당 1회만 부를 수 있다(리스너 중복 등록 방지). 콜백이 최신
  // 경로를 읽어야 하므로 ref로 미러링한다 — effect 의존성에 넣으면 재등록된다.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  /** 마지막 "한 번 더 누르면 닫혀요" 안내 시각(ms). */
  const exitPromptAt = useRef<number | null>(null);

  useEffect(() => {
    void initNative({
      onDeepLink: (path) => router.push(path),
      onBackButton: () => {
        const path = pathnameRef.current;
        const action = decideBackAction({
          // 로그인 화면도 루트로 친다 — 인증 전에는 그 뒤에 앱 화면이 없어서
          // 뒤로가기가 갈 곳이 없다(콜드 스타트 → 로그인 → 뒤로 = 앱 닫기).
          atTabRoot: isTabRoot(path) || normalizePath(path) === "/login",
          canGoBackInApp: canGoBackInApp(),
          lastExitPromptAt: exitPromptAt.current,
          now: Date.now(),
        });
        switch (action) {
          case "back":
            router.back();
            break;
          case "home":
            // 딥링크로 연 하위 화면 — 돌아갈 앱 화면이 없다. replace: 뒤로가기가
            // 방금 떠난 화면으로 되돌아오는 고리를 만들지 않는다.
            router.replace("/dashboard");
            break;
          case "confirm-exit":
            exitPromptAt.current = Date.now();
            toast("한 번 더 누르면 앱을 닫아요");
            break;
          case "exit":
            exitPromptAt.current = null;
            void exitApp();
            break;
        }
      },
      // 포그라운드 복귀 시 전체 쿼리를 stale 처리 → 보이는 화면부터 refetch.
      // 웹뷰는 복귀해도 리로드되지 않고 refetchOnWindowFocus도 꺼져 있어,
      // 이 훅이 없으면 다른 가족의 거래/수정이 영영 반영되지 않는다.
      onAppActive: () => void queryClient.invalidateQueries(),
    });
    // 키보드 UX(탭바 접기·iOS 사파리 웹 inset 폴백)는 웹/네이티브 공용.
    void initKeyboardUx();
  }, [router, queryClient]);

  // 화면이 바뀌면 종료 안내를 무효화한다 — 탭 A에서 한 번 누르고 탭 B로 옮긴 뒤
  // 누른 것이 "두 번째 누름"으로 세어져 앱이 닫히면 안 된다.
  useEffect(() => {
    exitPromptAt.current = null;
  }, [pathname]);

  // 상태바 아이콘 색을 앱 테마에 동기화(라이트=어두운 아이콘, 다크=흰 아이콘).
  useEffect(() => {
    if (!resolvedTheme) return;
    void applyStatusBarStyle(resolvedTheme === "dark");
  }, [resolvedTheme]);

  return null;
}
