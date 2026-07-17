"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 네이티브(Capacitor) 부트스트랩
 *
 * initNative는 웹에서 즉시 반환하므로(no-op) 이 컴포넌트는 웹/네이티브 공용으로 안전하다.
 * 네이티브에서만: 스플래시 제거·상태바·딥링크(초대 링크)·Android 뒤로가기를 초기화한다.
 * 딥링크는 클라이언트 라우팅으로 넘겨 앱 내 화면 전환으로 처리한다.
 * ------------------------------------------------------------------------- */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { initNative } from "@/lib/native";

export function NativeBootstrap() {
  const router = useRouter();
  useEffect(() => {
    void initNative({
      onDeepLink: (path) => router.push(path),
      canGoBack: () => window.history.length > 1,
    });
  }, [router]);
  return null;
}
