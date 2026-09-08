import type { ReactNode } from "react";
import { AppReadinessBoundary } from "@/components/app-readiness-boundary";
/** 게임에는 금융 화면의 셸과 활동 구독을 마운트하지 않는다. */
export default function GameLayout({children}: {children: ReactNode}) {
  return <AppReadinessBoundary>{children}</AppReadinessBoundary>;
}
