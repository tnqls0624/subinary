import type { NextConfig } from "next";

/**
 * Family Memory AI — web (Phase 0)
 *
 * - transpilePackages: 워크스페이스 패키지(@family/contracts, @family/shared)를
 *   Next.js 번들러가 직접 트랜스파일하도록 지정.
 * - output 'standalone': Docker 배포 시 self-contained 서버 산출물 생성.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@family/contracts", "@family/shared"],
};

export default nextConfig;
