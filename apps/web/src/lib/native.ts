/* ---------------------------------------------------------------------------
 * Family Memory AI — web · Capacitor 네이티브 브릿지
 *
 * 웹/네이티브 공용 코드에서 안전하게 쓰도록 모든 함수가 웹에서는 no-op이다.
 *  - isNative(): SSR/프리렌더/웹 브라우저에서 false, Capacitor 앱에서만 true.
 *  - refresh 토큰: 웹은 HttpOnly 쿠키, 네이티브는 cross-site 쿠키를 못 쓰므로
 *    @capacitor/preferences(보안 저장)에 보관하고 X-Refresh-Token 헤더로 재전송한다.
 *  - initNative(): 앱 마운트 시 스플래시/상태바/딥링크/뒤로가기 초기화.
 *
 * 네이티브 전용 플러그인은 동적 import로만 로드해 웹 번들·프리렌더 경로에서 제외한다.
 * ------------------------------------------------------------------------- */
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/** Preferences 키 — 로테이션된 refresh 토큰 1개만 보관. */
const REFRESH_KEY = "family.refreshToken";

/**
 * 네이티브(Capacitor) 런타임 여부. window 가드로 SSR/정적 프리렌더에서 항상 false.
 * 이 값이 web/native 분기의 단일 기준점이다.
 */
export function isNative(): boolean {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

/** 네이티브: 저장된 refresh 토큰. 웹: 항상 null(쿠키 사용). */
export async function getStoredRefreshToken(): Promise<string | null> {
  if (!isNative()) return null;
  const { value } = await Preferences.get({ key: REFRESH_KEY });
  return value ?? null;
}

/** 네이티브: AuthResult.refreshToken을 보안 저장. 웹/토큰 없음: no-op. */
export async function persistRefreshToken(
  token: string | null | undefined,
): Promise<void> {
  if (!isNative() || !token) return;
  await Preferences.set({ key: REFRESH_KEY, value: token });
}

/** 네이티브: 저장된 refresh 토큰 제거(로그아웃). 웹: no-op. */
export async function clearStoredRefreshToken(): Promise<void> {
  if (!isNative()) return;
  await Preferences.remove({ key: REFRESH_KEY });
}

interface InitNativeOptions {
  /** 딥링크로 들어온 앱-내부 경로(예: "/join?token=..."). 라우터로 이동시킨다. */
  onDeepLink?: (path: string) => void;
  /** Android 하드웨어 뒤로가기 — 루트에서 눌리면 앱 종료 여부 판단용. */
  canGoBack?: () => boolean;
}

/**
 * 네이티브 앱 초기화. 웹에서는 즉시 반환한다. 멱등이 아니므로 마운트당 1회만 호출.
 * 플러그인은 네이티브에서만 동적 로드 → 웹 번들 오염/프리렌더 오류를 원천 차단.
 */
export async function initNative(opts: InitNativeOptions = {}): Promise<void> {
  if (!isNative()) return;

  const [{ SplashScreen }, { StatusBar, Style }, { App }] = await Promise.all([
    import("@capacitor/splash-screen"),
    import("@capacitor/status-bar"),
    import("@capacitor/app"),
  ]);

  // 상태바: 테마 토큰이 라이트/다크를 모두 지원하므로 시스템 자동에 맡긴다.
  try {
    await StatusBar.setStyle({ style: Style.Default });
  } catch {
    // Android 일부 기기/에지 케이스에서 setStyle 미지원 → 무시.
  }

  // 딥링크(Universal/App Links): 초대 링크 등 https://도메인/join?token=... →
  // 앱-내부 경로만 추출해 클라이언트 라우팅으로 넘긴다.
  App.addListener("appUrlOpen", ({ url }) => {
    try {
      const parsed = new URL(url);
      const path = `${parsed.pathname}${parsed.search}`;
      if (path && path !== "/") opts.onDeepLink?.(path);
    } catch {
      // 스킴 딥링크(capacitor://) 등 URL 파싱 실패 시 무시.
    }
  });

  // Android 하드웨어 뒤로가기: 이동 가능하면 히스토리 back, 루트면 앱을 백그라운드로.
  App.addListener("backButton", () => {
    if (opts.canGoBack?.()) {
      window.history.back();
    } else {
      void App.exitApp();
    }
  });

  // 웹뷰 첫 렌더가 끝난 뒤 스플래시 제거(FOUC 방지).
  await SplashScreen.hide();
}
