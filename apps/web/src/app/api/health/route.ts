import type { LivezResponse } from "@family/contracts";
import { NextResponse } from "next/server";

/**
 * Docker healthcheck 전용 엔드포인트 (`GET /api/health`).
 * 외부 API 서비스에 의존하지 않고 web 프로세스 자체의 liveness만 보고한다.
 *
 * force-static: liveness 프로브는 200 응답만으로 충분하고, mobile 타깃의 정적
 * export(output:'export')는 force-dynamic 라우트 핸들러를 허용하지 않는다.
 * timestamp는 빌드 시점 값으로 고정된다(신선도보다 두 타깃 공용 빌드를 우선).
 */
export const dynamic = "force-static";

export async function GET(): Promise<NextResponse<LivezResponse>> {
  const body: LivezResponse = {
    status: "ok",
    service: "web",
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: 200 });
}
