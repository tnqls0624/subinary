import type { NextConfig } from "next";

/**
 * Family Memory AI — web (Phase 0)
 *
 * - transpilePackages: 워크스페이스 패키지(@family/contracts, @family/shared)를
 *   Next.js 번들러가 직접 트랜스파일하도록 지정.
 * - output 'standalone': Docker 배포 시 self-contained 서버 산출물 생성.
 * - devIndicators: false — 개발 화면 구석의 Next.js dev 인디케이터(로고 버튼)를 숨긴다.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@family/contracts", "@family/shared"],
  devIndicators: false,
};

export default nextConfig;
