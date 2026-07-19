/* ---------------------------------------------------------------------------
 * Family Memory AI — web · Capacitor 네이티브 브릿지
 *
 * 웹/네이티브 공용 코드에서 안전하게 쓰도록 모든 함수가 웹에서는 no-op이다.
 *  - isNative(): SSR/프리렌더/웹 브라우저에서 false, Capacitor 앱에서만 true.
 *  - refresh 토큰: 웹은 HttpOnly 쿠키, 네이티브는 cross-site 쿠키를 못 쓰므로
 *    iOS Keychain/Android Keystore 기반 보안 저장소에 보관하고
 *    X-Refresh-Token 헤더로 재전송한다.
 *  - initNative(): 앱 마운트 시 스플래시/상태바/딥링크/뒤로가기 초기화.
 *
 * 네이티브 전용 플러그인은 동적 import로만 로드해 웹 번들·프리렌더 경로에서 제외한다.
 * ------------------------------------------------------------------------- */
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

/** 이전 버전 Preferences에 저장된 refresh 토큰 키(1회 마이그레이션 전용). */
const LEGACY_REFRESH_KEY = "family.refreshToken";
/** 보안 저장소의 refresh 토큰 키. 실제 저장 키에는 아래 prefix가 추가된다. */
const SECURE_REFRESH_KEY = "refreshToken";
const SECURE_STORAGE_PREFIX = "family-memory.";
/** 재설치와 정상 업그레이드를 구분하는 비민감 Preferences 표식. */
const SECURE_STORAGE_MARKER_KEY = "family.secureRefreshStorageVersion";
const SECURE_STORAGE_VERSION = "1";

type SecureStorageModule =
  typeof import("@aparajita/capacitor-secure-storage");

let secureStorageModulePromise: Promise<SecureStorageModule> | null = null;
let storageOperationTail: Promise<void> = Promise.resolve();

/** 네이티브 보안 저장소 접근 실패. 원인 메시지에 토큰 값은 포함하지 않는다. */
export class SecureTokenStorageError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "SecureTokenStorageError";
    this.cause = cause;
  }
}

/** Keychain/Keystore 설정을 한 번만 적용하고 실패 시 다음 호출에서 재시도한다. */
async function getSecureStorageModule(): Promise<SecureStorageModule> {
  if (!secureStorageModulePromise) {
    secureStorageModulePromise = (async () => {
      const module = await import("@aparajita/capacitor-secure-storage");
      await module.SecureStorage.setKeyPrefix(SECURE_STORAGE_PREFIX);
      // refresh 토큰은 iCloud Keychain으로 동기화하지 않는다.
      await module.SecureStorage.setSynchronize(false);
      // 잠금 해제 상태에서만 읽을 수 있고 백업으로 다른 기기에 이전되지 않는다.
      await module.SecureStorage.setDefaultKeychainAccess(
        module.KeychainAccess.whenUnlockedThisDeviceOnly,
      );
      return module;
    })().catch((error: unknown) => {
      secureStorageModulePromise = null;
      throw error;
    });
  }
  return secureStorageModulePromise;
}

/** get/set/remove 간 경합으로 1회용 refresh 토큰이 뒤바뀌지 않도록 직렬화한다. */
function runStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageOperationTail.then(operation, operation);
  storageOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** 보안 저장소 값을 문자열 refresh 토큰으로 검증한다. */
async function readSecureRefreshToken(
  module: SecureStorageModule,
): Promise<string | null> {
  const value = await module.SecureStorage.get(
    SECURE_REFRESH_KEY,
    false,
    false,
  );
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("보안 저장소의 refresh 토큰 형식이 올바르지 않습니다.");
  }
  return value;
}

/** 토큰을 기기 전용으로 저장한 뒤 즉시 재조회해 쓰기 성공을 검증한다. */
async function writeSecureRefreshToken(
  module: SecureStorageModule,
  token: string,
): Promise<void> {
  await module.SecureStorage.set(
    SECURE_REFRESH_KEY,
    token,
    false,
    false,
    module.KeychainAccess.whenUnlockedThisDeviceOnly,
  );
  const verified = await readSecureRefreshToken(module);
  if (verified !== token) {
    throw new Error("보안 저장소의 refresh 토큰 쓰기 검증에 실패했습니다.");
  }
}

/**
 * 기존 Preferences 토큰을 1회 이전한다. iOS 재설치 후 Keychain에만 남은 토큰은
 * 설치 표식이 없으므로 폐기해 삭제 전 세션이 자동 복원되지 않게 한다.
 */
async function readOrMigrateRefreshToken(): Promise<string | null> {
  const module = await getSecureStorageModule();
  const [secureToken, legacyResult, markerResult] = await Promise.all([
    readSecureRefreshToken(module),
    Preferences.get({ key: LEGACY_REFRESH_KEY }),
    Preferences.get({ key: SECURE_STORAGE_MARKER_KEY }),
  ]);
  const legacyToken = legacyResult.value;
  const initialized = markerResult.value === SECURE_STORAGE_VERSION;

  if (!initialized && secureToken && !legacyToken) {
    // iOS Keychain은 앱 삭제 후에도 남을 수 있다. 새 설치에서는 이전 세션을 폐기한다.
    await module.SecureStorage.remove(SECURE_REFRESH_KEY, false);
    await Preferences.set({
      key: SECURE_STORAGE_MARKER_KEY,
      value: SECURE_STORAGE_VERSION,
    });
    return null;
  }

  if (legacyToken) {
    // 업그레이드 중에는 기존 Preferences 토큰이 마지막으로 사용된 원본이다.
    await writeSecureRefreshToken(module, legacyToken);
    await Preferences.set({
      key: SECURE_STORAGE_MARKER_KEY,
      value: SECURE_STORAGE_VERSION,
    });
    await Preferences.remove({ key: LEGACY_REFRESH_KEY });
    return legacyToken;
  }

  if (!initialized) {
    await Preferences.set({
      key: SECURE_STORAGE_MARKER_KEY,
      value: SECURE_STORAGE_VERSION,
    });
  }
  return secureToken;
}

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
  return runStorageOperation(async () => {
    try {
      return await readOrMigrateRefreshToken();
    } catch (error: unknown) {
      throw new SecureTokenStorageError(
        "저장된 로그인 정보를 안전하게 불러오지 못했습니다.",
        error,
      );
    }
  });
}

/** 네이티브: AuthResult.refreshToken을 Keychain/Keystore에 저장. 웹/토큰 없음: no-op. */
export async function persistRefreshToken(
  token: string | null | undefined,
): Promise<void> {
  if (!isNative() || !token) return;
  await runStorageOperation(async () => {
    try {
      const module = await getSecureStorageModule();
      await writeSecureRefreshToken(module, token);
      await Preferences.set({
        key: SECURE_STORAGE_MARKER_KEY,
        value: SECURE_STORAGE_VERSION,
      });
      await Preferences.remove({ key: LEGACY_REFRESH_KEY });
    } catch (error: unknown) {
      throw new SecureTokenStorageError(
        "로그인 정보를 기기의 보안 저장소에 저장하지 못했습니다.",
        error,
      );
    }
  });
}

/** 네이티브: 저장된 refresh 토큰 제거(로그아웃). 웹: no-op. */
export async function clearStoredRefreshToken(): Promise<void> {
  if (!isNative()) return;
  await runStorageOperation(async () => {
    let secureStorageError: unknown;
    let preferencesError: unknown;
    try {
      const module = await getSecureStorageModule();
      await module.SecureStorage.remove(SECURE_REFRESH_KEY, false);
    } catch (error: unknown) {
      secureStorageError = error;
    }
    try {
      await Preferences.remove({ key: LEGACY_REFRESH_KEY });
    } catch (error: unknown) {
      preferencesError = error;
    }
    if (secureStorageError || preferencesError) {
      throw new SecureTokenStorageError(
        "기기의 로그인 정보를 완전히 삭제하지 못했습니다.",
        secureStorageError ?? preferencesError,
      );
    }
  });
}

/**
 * 네이티브 상태바 아이콘 명암을 앱 테마에 맞춘다(웹: no-op).
 *  - dark 테마(어두운 헤더) → Style.Dark (밝은/흰 아이콘)
 *  - light 테마(밝은 헤더) → Style.Light (어두운 아이콘)
 * next-themes의 resolvedTheme 변화마다 NativeBootstrap이 호출한다.
 */
export async function applyStatusBarStyle(dark: boolean): Promise<void> {
  if (!isNative()) return;
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {
    // 일부 기기/에지 케이스 미지원 → 무시.
  }
}

/**
 * 키보드 UX 초기화 — 네이티브/웹 공용(마운트당 1회).
 *
 * 네이티브(iOS·Android): @capacitor/keyboard 이벤트로 <html>에 kb-open을 토글한다.
 * 웹뷰 리사이즈(iOS resize:native, Android adjustResize)가 뷰포트를 줄여주므로
 * CSS는 탭바만 접으면 되고(globals.css), 나머지 레이아웃은 수식이 따라온다.
 *
 * 웹(터치 기기): iOS 사파리는 키보드가 떠도 레이아웃 뷰포트를 줄이지 않아
 * (interactive-widget 미지원) fixed 하단 요소가 키보드에 가려진다. visualViewport
 * 차이를 --kb-inset으로 주입해 AI 입력바가 키보드 위로 올라오게 한다.
 * (Android Chrome은 resizes-content 메타로 뷰포트가 줄어 inset≈0 → 자연 무해)
 */
export async function initKeyboardUx(): Promise<void> {
  if (typeof window === "undefined") return;
  const root = document.documentElement;

  if (isNative()) {
    try {
      const { Keyboard } = await import("@capacitor/keyboard");
      await Keyboard.addListener("keyboardWillShow", () =>
        root.classList.add("kb-open"),
      );
      await Keyboard.addListener("keyboardWillHide", () =>
        root.classList.remove("kb-open"),
      );
    } catch {
      // 플러그인 미탑재 셸(구버전 앱 바이너리) — 키보드 UX만 저하, 치명적 아님.
    }
    return;
  }

  // 웹 폴백은 터치 기기에서만 — 데스크톱의 pinch-zoom 등으로 visualViewport가
  // 변할 때 레이아웃을 건드리지 않기 위한 가드.
  const vv = window.visualViewport;
  if (!vv || !window.matchMedia("(pointer: coarse)").matches) return;
  const onResize = () => {
    // 키보드 높이 ≈ 레이아웃 뷰포트 − 비주얼 뷰포트(패닝 offsetTop 보정).
    const inset = Math.max(
      0,
      Math.round(window.innerHeight - vv.height - vv.offsetTop),
    );
    // 100px 미만은 URL바 개폐 등 노이즈로 보고 키보드로 취급하지 않는다.
    const open = inset > 100;
    root.style.setProperty("--kb-inset", open ? `${inset}px` : "0px");
    root.classList.toggle("kb-open", open);
  };
  vv.addEventListener("resize", onResize);
  vv.addEventListener("scroll", onResize);
}

interface InitNativeOptions {
  /** 딥링크로 들어온 앱-내부 경로(예: "/join?token=..."). 라우터로 이동시킨다. */
  onDeepLink?: (path: string) => void;
  /** Android 하드웨어 뒤로가기 — 루트에서 눌리면 앱 종료 여부 판단용. */
  canGoBack?: () => boolean;
  /**
   * 백그라운드 → 포그라운드 복귀 콜백. 네이티브 앱은 웹뷰가 계속 살아있어
   * 복귀 시 리로드가 없으므로, 그 사이 서버에서 바뀐 데이터(다른 가족의
   * 거래·수정)를 여기서 최신화해야 한다.
   */
  onAppActive?: () => void;
}

/** 마지막으로 등록된 FCM 토큰(로그아웃 시 서버 구독 해지에 사용). */
let lastPushToken: string | null = null;

/** 현재 기기의 FCM 토큰(미등록/웹이면 null). 로그아웃 해지에 쓴다. */
export function getRegisteredPushToken(): string | null {
  return lastPushToken;
}

/** 푸시 초기화 콜백(토큰 등록·포그라운드 수신·알림 탭). */
interface InitPushOptions {
  /** FCM 등록 토큰을 서버에 등록(재발급 시 재호출). platform 포함. */
  onToken?: (token: string, platform: "android" | "ios") => void;
  /** 앱이 떠 있는 중 푸시 수신 — 리스트 갱신용(무효화). */
  onForegroundReceived?: () => void;
  /** 알림 탭으로 앱 진입 — data.deepLink 경로로 라우팅. */
  onDeepLink?: (path: string) => void;
}

/**
 * 최신 콜백을 담는 모듈 ref. 리스너는 세션당 딱 한 번만 등록하고(아래 플래그),
 * 콜백은 이 ref를 통해 읽는다 — 로그아웃→재로그인으로 initPushNotifications가
 * 다시 호출돼도 리스너가 누적되지 않는다(Capacitor 리스너는 컴포넌트 언마운트로
 * 제거되지 않으므로, 등록을 1회로 고정하는 것이 유일하게 안전한 방법).
 */
let pushCallbacks: InitPushOptions = {};
let pushListenersRegistered = false;
let pushPlatform: "android" | "ios" | null = null;

/**
 * 푸시 알림 초기화(네이티브 전용, 웹은 no-op). 권한을 요청하고 등록 토큰을
 * onToken으로 넘긴다. 콜드 스타트(알림 탭으로 앱 시작) 시에도 pushNotification
 * ActionPerformed가 전달되므로 딥링크가 동작한다. 인증 확정 후 호출한다.
 *
 * 리스너 등록은 세션당 1회로 고정(누수 방지)하되, 콜백은 매 호출마다 최신으로
 * 갱신하고 register()도 매번 호출해 토큰을 재확인한다(멱등, 재로그인 안전).
 * 권한이 거부되면 조용히 종료(앱 내 SSE/폴링이 대체 인지 경로).
 */
export async function initPushNotifications(
  opts: InitPushOptions = {},
): Promise<void> {
  if (!isNative()) return;
  const platform = Capacitor.getPlatform();
  if (platform !== "android" && platform !== "ios") return;

  // 콜백은 항상 최신으로 교체(리스너는 이 ref를 읽는다).
  pushCallbacks = opts;
  pushPlatform = platform;

  const { PushNotifications } = await import("@capacitor/push-notifications");

  // 권한: 이미 허용이면 그대로, 미결정이면 요청. 거부면 등록하지 않는다.
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== "granted") return;

  // 리스너는 세션 최초 1회만 등록한다(중복 등록 방지).
  if (!pushListenersRegistered) {
    pushListenersRegistered = true;
    void PushNotifications.addListener("registration", (token) => {
      if (token?.value) {
        lastPushToken = token.value;
        pushCallbacks.onToken?.(token.value, pushPlatform ?? "android");
      }
    });
    void PushNotifications.addListener("registrationError", () => {
      // 등록 실패는 조용히 무시(다음 실행에서 재시도). 원문 로그 금지.
    });
    // 포그라운드 수신 → 리스트 무효화(앱 안이면 배너 대신 데이터 갱신으로 충분).
    void PushNotifications.addListener("pushNotificationReceived", () => {
      pushCallbacks.onForegroundReceived?.();
    });
    // 알림 탭 → data.deepLink로 라우팅(워밍/콜드 공통).
    void PushNotifications.addListener(
      "pushNotificationActionPerformed",
      (action) => {
        const deepLink = action.notification?.data?.deepLink;
        if (typeof deepLink === "string" && deepLink.startsWith("/")) {
          pushCallbacks.onDeepLink?.(deepLink);
        }
      },
    );
  }

  // OS에 등록 요청 → 성공 시 registration 리스너로 토큰이 온다.
  await PushNotifications.register();
}

/**
 * 네이티브 앱 초기화. 웹에서는 즉시 반환한다. 멱등이 아니므로 마운트당 1회만 호출.
 * 플러그인은 네이티브에서만 동적 로드 → 웹 번들 오염/프리렌더 오류를 원천 차단.
 */
export async function initNative(opts: InitNativeOptions = {}): Promise<void> {
  if (!isNative()) return;

  const [{ SplashScreen }, { App }] = await Promise.all([
    import("@capacitor/splash-screen"),
    import("@capacitor/app"),
  ]);

  // 상태바 아이콘 색은 Style.Default(시스템 추종) 대신 앱 테마에 맞춰
  // applyStatusBarStyle()로 별도 동기화한다(앱↔시스템 테마 불일치 시 흰 아이콘이
  // 흰 헤더에 묻히는 문제 방지). → NativeBootstrap이 resolvedTheme 변화마다 호출.

  // 딥링크: 초대 링크를 앱-내부 경로로 바꿔 클라이언트 라우팅으로 넘긴다.
  //  - HTTPS App/Universal Links: https://<도메인>/join?token=...
  //  - 커스텀 스킴: familymemory://join?token=...
  // 커스텀 스킴은 URL 파싱 시 host="join"이라 pathname이 비므로 token을 직접 뽑는다.
  App.addListener("appUrlOpen", ({ url }) => {
    const token = url.match(/[?&]token=([^&#\s]+)/)?.[1];
    if (token) {
      opts.onDeepLink?.(`/join?token=${token}`);
      return;
    }
    // 그 외 https 링크는 경로를 보존해 라우팅.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const path = `${parsed.pathname}${parsed.search}`;
        if (path && path !== "/") opts.onDeepLink?.(path);
      }
    } catch {
      // URL 파싱 실패 시 무시.
    }
  });

  // 포그라운드 복귀 감지(웹의 visibilitychange 대응물).
  App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) opts.onAppActive?.();
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
