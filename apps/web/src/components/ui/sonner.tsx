"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** 앱 전역 토스트. 테마(next-themes)에 맞춰 라이트/다크 자동 전환. */
function Toaster({ ...props }: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // 상단(top-center)은 sticky 헤더와 겹쳐 가림 → 하단 탭바 바로 위로.
      // --app-tabbar-h는 safe-area 포함, 키보드 표시 시 0이라 그때는 화면 하단에 붙는다.
      position="bottom-center"
      offset={{ bottom: "calc(var(--app-tabbar-h) + 0.75rem)" }}
      mobileOffset={{ bottom: "calc(var(--app-tabbar-h) + 0.75rem)" }}
      richColors
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
