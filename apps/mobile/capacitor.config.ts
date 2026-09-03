import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Family Memory AI — Capacitor 설정.
 *
 * - webDir: apps/web의 정적 export 산출물(out/)을 번들한다. server.url을 두지 않으므로
 *   앱은 오프라인 셸로 즉시 실행되고, 데이터만 원격 API(NEXT_PUBLIC_API_URL, 빌드 시 주입)로
 *   호출한다. → 스토어 심사에 유리(단순 웹 래퍼 아님).
 *
 *   ⛔ **server.url로 원격을 직접 로드하지 않는다** (2026-09-04 검토·기각). 그러면 WebView
 *   origin이 `capacitor://localhost`에서 `https://app.subinary.cloud`로 바뀌는데, 그건 웹
 *   브라우저도 보내는 값이다. `isTrustedNativeClient`가 **origin으로 네이티브를 확인**하므로
 *   (platform 헤더는 위조 가능해서 그렇게 설계했다) 앱이 네이티브로 인식되지 않고, 허용
 *   목록에 그 origin을 넣으면 웹 스크립트가 모바일 권한(refresh TTL 1년)을 훔칠 수 있다.
 *   바디 토큰 인증·생체인식 자동 로그인이 전부 그 판정에 걸려 있다.
 *
 * - **OTA(@capgo/capacitor-updater)로 웹 자산만 갱신한다.** origin이 그대로라 인증·보안
 *   모델을 하나도 건드리지 않고, 오프라인 셸도 유지되며, 웹만 바뀐 릴리스에서 네이티브
 *   재빌드가 사라진다. 네이티브 코드(플러그인·권한·Info.plist)가 바뀌면 여전히 재빌드다.
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
    /**
     * OTA 웹 번들 업데이트 (자체 호스팅). Capgo 클라우드를 쓰지 않는다.
     *
     * - `autoUpdate: "atBackground"`: 백그라운드에서 확인·다운로드하고 **다음 실행에**
     *   적용한다. 쓰는 도중 화면이 갈아끼워지는 것보다 낫다.
     * - `updateUrl`: 우리 API가 현재 번들 버전을 알려준다. 앱이 POST로 자기 버전을
     *   보내면 서버가 `{version, url, checksum}` 또는 "없음"을 응답한다.
     * - `statsUrl`/`channelUrl`은 **빈 문자열로 끈다.** 기본값은 Capgo 클라우드를 향하고,
     *   자체 호스팅에서 그쪽으로 기기 정보를 보낼 이유가 없다.
     * - `appReadyTimeout`: 새 번들로 부팅한 뒤 이 시간 안에 `notifyAppReady()`가 오지
     *   않으면 **이전 번들로 자동 롤백**한다. 깨진 번들을 올려도 앱이 벽돌이 되지 않는
     *   유일한 안전장치라, 웹 부팅 경로에서 반드시 호출해야 한다(native.ts).
     */
    CapacitorUpdater: {
      autoUpdate: "atBackground",
      updateUrl: "https://app.subinary.cloud/v1/ota/updates",
      statsUrl: "",
      channelUrl: "",
      appReadyTimeout: 10000,
      resetWhenUpdate: true,
    },
  },
};

export default config;
