import type { LivezResponse } from "@family/contracts";
import { NextResponse } from "next/server";

/**
 * Docker healthcheck 전용 엔드포인트 (`GET /api/health`).
 * 외부 API 서비스에 의존하지 않고 web 프로세스 자체의 liveness만 보고한다.
 * timestamp가 요청 시점마다 갱신되도록 정적 최적화를 비활성화한다.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<LivezResponse>> {
  const body: LivezResponse = {
    status: "ok",
    service: "web",
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: 200 });
}
