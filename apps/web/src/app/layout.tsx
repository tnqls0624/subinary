import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Family Memory AI",
  description: "가족 금융 웹앱 — 대시보드 · 거래 · 예산 · 장치 · 가족 관리",
  applicationName: "Family Memory",
  // iOS 홈화면/네이티브 셸: 상태바·전체화면 힌트(웹에선 무해).
  appleWebApp: {
    capable: true,
    title: "Family Memory",
    statusBarStyle: "default",
  },
  // 금액/날짜 텍스트를 iOS가 전화번호 등으로 오탐지해 링크화하는 것 방지.
  formatDetection: { telephone: false },
};

// viewport-fit=cover: 노치/홈 인디케이터 safe-area(env(safe-area-inset-*)) 활성화.
// 하단 탭바가 이미 pb-[env(safe-area-inset-bottom)]로 이 값을 사용한다.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
