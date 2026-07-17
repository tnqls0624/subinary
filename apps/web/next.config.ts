import type { NextConfig } from "next";

/**
 * Family Memory AI — web
 *
 * 두 개의 빌드 타깃을 한 소스에서 낸다(BUILD_TARGET 환경변수로 분기):
 *  - 기본(웹/Docker): output 'standalone' — self-contained 서버 산출물.
 *  - BUILD_TARGET=mobile: output 'export' — 정적 out/ 산출물을 Capacitor 네이티브
 *    셸(apps/mobile)에 번들한다. 이 앱은 전 페이지가 클라이언트 컴포넌트 + 원격 API
 *    호출이라 서버 런타임 없이 정적 export가 가능하다.
 *
 * - transpilePackages: 워크스페이스 패키지를 Next 번들러가 직접 트랜스파일.
 * - devIndicators: false — 개발 화면 구석 dev 인디케이터 숨김.
 */
const isMobile = process.env.BUILD_TARGET === "mobile";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: isMobile ? "export" : "standalone",
  // export에는 이미지 최적화 서버가 없다(현재 next/image 미사용, 안전차원 unoptimized).
  ...(isMobile ? { images: { unoptimized: true } } : {}),
  // Capacitor 로컬 서버는 디렉터리 index.html로 라우팅 → trailingSlash로 정적 경로 안정화.
  trailingSlash: isMobile,
  transpilePackages: ["@family/contracts", "@family/shared"],
  devIndicators: false,
};

export default nextConfig;
