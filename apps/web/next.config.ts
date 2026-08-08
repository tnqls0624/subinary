import type { NextConfig } from "next";

/**
 * Family Memory AI — web
 *
 * 두 개의 빌드 타깃을 한 소스에서 낸다(BUILD_TARGET 환경변수로 분기):
 *  - 기본(웹/prod): 일반 빌드 → `next start`로 서빙(프로덕션 서버).
 *  - BUILD_TARGET=mobile: output 'export' — 정적 out/ 산출물을 Capacitor 네이티브
 *    셸(apps/mobile)에 번들한다. 이 앱은 전 페이지가 클라이언트 컴포넌트 + 원격 API
 *    호출이라 서버 런타임 없이 정적 export가 가능하다.
 *
 * (standalone 대신 next start를 쓰는 이유: pnpm 모노레포에서 standalone 파일
 *  트레이싱이 워크스페이스 패키지/심링크를 놓치기 쉬워, 전체 install이 있는 단일
 *  prod 이미지에서 next start가 더 견고하다. api/worker도 같은 이미지 공유.)
 *
 * - transpilePackages: 워크스페이스 패키지를 Next 번들러가 직접 트랜스파일.
 * - devIndicators: false — 개발 화면 구석 dev 인디케이터 숨김.
 *
 * package.json의 build 스크립트가 NODE_ENV=production을 **직접 박는 이유**:
 * `next build`는 NODE_ENV를 덮어쓰지 않고 경고만 하고 진행한다. dev compose의 .env는
 * NODE_ENV=development를 넣으므로, dev 컨테이너에서 그대로 빌드하면 app-page 런타임은
 * dev 번들(`app-page-turbo.runtime.dev.js`)이 잡히는데 산출 청크는 프로덕션으로 컴파일된다.
 * 그 조합에서 SSR용 React(`vendored["react-ssr"].React`)가 null이 되어
 * `/_global-error`·`/_not-found` 프리렌더가 "Cannot read properties of null" 로 죽는다.
 * 환경에 상관없이 프로덕션 빌드는 프로덕션 NODE_ENV로 돌아야 한다.
 */
const isMobile = process.env.BUILD_TARGET === "mobile";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: isMobile ? "export" : undefined,
  // export에는 이미지 최적화 서버가 없다(현재 next/image 미사용, 안전차원 unoptimized).
  ...(isMobile ? { images: { unoptimized: true } } : {}),
  // Capacitor 로컬 서버는 디렉터리 index.html로 라우팅 → trailingSlash로 정적 경로 안정화.
  trailingSlash: isMobile,
  transpilePackages: ["@family/contracts", "@family/shared"],
  devIndicators: false,
};

export default nextConfig;
