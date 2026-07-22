import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Family Memory AI — Capacitor 설정.
 *
 * - webDir: apps/web의 정적 export 산출물(out/)을 번들한다. server.url을 두지 않으므로
 *   앱은 오프라인 셸로 즉시 실행되고, 데이터만 원격 API(NEXT_PUBLIC_API_URL, 빌드 시 주입)로
 *   호출한다. → 스토어 심사에 유리(단순 웹 래퍼 아님).
 * - 딥링크/뒤로가기/상태바/스플래시 hide는 web의 initNative()(lib/native.ts)에서 처리.
 * - appId는 스토어 번들 식별자 → 실제 소유 도메인 기준으로 바꿔도 된다.
 */
const config: CapacitorConfig = {
  appId: "ai.familymemory.app",
  appName: "모아",
  webDir: "../web/out",
  plugins: {
    // 웹 마운트 후 initNative()가 명시적으로 hide() → FOUC 방지.
    // autoHide는 안전망(웹 부팅 실패 시 스플래시가 영구히 남지 않도록).
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: "#ffffff",
    },
    // resize:'native'(iOS): 키보드 표시 시 WKWebView 프레임 자체를 줄여
    // 100dvh·fixed 요소가 키보드 위 영역 기준으로 재계산된다 — 채팅 입력바가
    // 키보드에 밀착되는 유일한 모드(body/ionic은 dvh 수식과 안 맞음).
    // 기본값이지만 레이아웃이 이 동작에 의존하므로 의도를 명시해 고정한다.
    Keyboard: {
      resize: "native",
    },
  },
};

export default config;
