"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 인증 컨텍스트 (Phase 5 §6.1)
 *
 * 인증 흐름(스펙 §1.6):
 *  - access token은 메모리(React state + ref)에만 보관한다. 로컬스토리지 금지.
 *  - refresh token은 HttpOnly 쿠키(`/v1/auth`)에 있고 fetch가 자동 전송한다.
 *  - 마운트 시 bootstrap(): POST /v1/auth/refresh → 성공 시 me()로 사용자·멤버십 복원.
 *  - authedFetch: 401 → refresh 1회 재시도 → 재실패 시 로그아웃 상태 전환.
 *  - 네이티브 생체인식 잠금(lib/biometric.ts): 켜져 있으면 bootstrap의 저장 토큰
 *    사용 전에 본인 확인 게이트를 세운다. 세션이 이미 열린 뒤의 401 재시도
 *    경로는 게이트를 다시 세우지 않는다(콜드 스타트 잠금이 목적).
 *  - 부트스트랩이 401이 아닌 이유(오프라인·타임아웃·5xx)로 실패하면 세션을 버리지
 *    않고 "offline"로 두고 재시도(retryBootstrap)를 제안한다.
 * ------------------------------------------------------------------------- */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  AuthResult,
  HouseholdMembershipSummary,
  LoginRequest,
  RegisterRequest,
  UserSummary,
} from "@family/contracts";

import { clearAiChatHistory } from "./ai-chat-history";
import { ApiError, api, type AccessToken } from "./api-client";
import {
  authenticateBiometricResilient,
  getBiometricPref,
  type BiometricResult,
} from "./biometric";
import {
  clearStoredRefreshToken,
  getRegisteredPushToken,
  getStoredRefreshToken,
  persistRefreshToken,
} from "./native";

/** 생체인식 프롬프트 공통 문구(부트스트랩 게이트/로그인 화면 재시도 동일). */
const BIOMETRIC_REASON = "저장된 로그인을 사용하려면 본인 확인이 필요해요";

/**
 * 탭 간 refresh 직렬화 락 이름. Web Locks는 같은 origin의 모든 탭이 공유한다.
 * 액세스 토큰(15분) 만료 시 여러 탭이 각자 refresh하면, 회전으로 무효화된 토큰을
 * 뒤늦게 제시한 탭이 (서버 유예 밖이면) 세션을 흔든다. 한 번에 한 탭만 회전시키고
 * 대기 탭은 앞 탭이 갱신한 쿠키로 진행하게 해 이 경합을 없앤다.
 */
const REFRESH_LOCK = "family-auth-refresh";

/**
 * refresh 실행을 브라우저 전역 락으로 감싼다. Web Locks 미지원 환경(구형 WebView 등)
 * 은 콜백을 그대로 실행한다 — 탭 내 single-flight(inflightRefresh)로 폴백된다.
 */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator !== "undefined" && "locks" in navigator
      ? navigator.locks
      : undefined;
  // lib.dom의 request 콜백 반환이 제네릭이라 () => Promise<T>가 Promise<Promise<T>>로
  // 추론된다 — 실제 런타임 반환은 Promise<T>이므로 좁혀서 반환한다.
  return locks
    ? (locks.request(REFRESH_LOCK, fn) as Promise<T>)
    : fn();
}

/**
 * 인증 부트스트랩/세션 상태.
 *
 * "offline"은 **세션 상태를 모르는** 상태다 — 통신이 안 돼 확인을 못 했을 뿐이라
 * unauthenticated와 섞으면 안 된다. 이 값에서 /login으로 보내면 안 된다(멀쩡한
 * 세션을 가진 사용자에게 재로그인을 요구하는 게 정확히 그 버그였다).
 */
export type AuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "offline";

/**
 * 부트스트랩 실패를 "재시도하면 복구될 수 있음"과 "세션이 죽었음"으로 가른다.
 *
 * ApiError가 아니면 HTTP 응답 자체가 없었던 것(오프라인·DNS·타임아웃·CORS)이다 —
 * status가 없는 실패를 인증 실패로 뭉개면, 지하철에서 앱을 연 것만으로 1년 세션이
 * 날아간다. 5xx/429는 서버·프록시 사정이라 세션과 무관하다(터널 재연결 중 502).
 * 그 밖의 4xx는 예상 못 한 계약 위반이므로 보수적으로 세션을 파기해 기존 동작
 * (로그인 화면)을 유지한다 — 무한 재시도 화면에 갇히는 것보다 낫다.
 */
function isRetriableFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || error.status === 429;
}

interface AuthContextValue {
  user: UserSummary | null;
  memberships: HouseholdMembershipSummary[];
  accessToken: AccessToken;
  status: AuthStatus;
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  /** 현재 메모리 상의 access token(동기 접근). */
  getAccessToken: () => AccessToken;
  /**
   * 인증이 필요한 호출을 감싼다. 401을 만나면 refresh 1회 재시도 후 재실행하고,
   * refresh도 실패하면 세션을 unauthenticated로 전환한 뒤 원 에러를 전파한다.
   */
  authedFetch: <T>(fn: (token: AccessToken) => Promise<T>) => Promise<T>;
  /** me()를 다시 불러 멤버십을 갱신한다(초대 수락/가족 생성 후 사용). */
  refreshMemberships: () => Promise<void>;
  /** status가 "offline"일 때 세션 복원을 다시 시도한다(연결 실패 화면의 버튼). */
  retryBootstrap: () => void;
  /**
   * 네이티브 생체인식으로 저장된 세션을 복원한다(로그인 화면 보조 버튼).
   * "cancelled"/"failed"는 그대로 반환하고, 게이트 통과 후 refresh 실패
   * (세션 만료 등)는 예외를 전파한다.
   */
  biometricLogin: () => Promise<BiometricResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [memberships, setMemberships] = useState<HouseholdMembershipSummary[]>(
    [],
  );
  const [accessToken, setAccessTokenState] = useState<AccessToken>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  // AuthProvider는 QueryClientProvider 안쪽(providers.tsx)이라 그대로 쓸 수 있다.
  const queryClient = useQueryClient();

  // authedFetch가 최신 토큰을 동기적으로 읽을 수 있도록 ref로도 보관한다.
  const accessTokenRef = useRef<AccessToken>(null);
  const setAccessToken = useCallback((token: AccessToken) => {
    accessTokenRef.current = token;
    setAccessTokenState(token);
  }, []);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setMemberships([]);
    setStatus("unauthenticated");
    // 서버 데이터 캐시까지 함께 버린다. 알림함·안읽음 뱃지·알림 설정은 user 스코프인데
    // 키에 userId가 없어(queries.ts), 같은 기기에서 다음 사용자가 로그인하면 staleTime
    // 30초 동안 **이전 사용자의 알림 제목·가맹점명·금액**이 먼저 렌더된다. household
    // 스코프 쿼리도 가족을 옮긴 계정 사이에서 같은 문제가 된다.
    //
    // 세션 만료(authedFetch의 refresh 실패)·부트스트랩 401 경로도 여기를 지난다 —
    // "로그아웃했는가"와 "이 캐시의 주인이 바뀔 수 있는가"는 다른 질문이고, 후자가
    // 참인 건 세션이 닫히는 모든 경로에서 동일하다. 재로그인하면 다시 받아온다.
    queryClient.clear();
    // `/ai` 대화는 react-query 캐시가 아니라 localStorage에 있다 — 같은 이유로
    // 함께 버린다. 금융 질문·답변이 담기므로 다음 사용자에게 남으면 안 된다.
    clearAiChatHistory();
  }, [setAccessToken, queryClient]);

  const getAccessToken = useCallback<() => AccessToken>(
    () => accessTokenRef.current,
    [],
  );

  // 진행 중인 refresh 1건을 공유하기 위한 single-flight 슬롯.
  const inflightRefresh = useRef<Promise<AuthResult> | null>(null);

  /**
   * refresh를 단일화한다(single-flight). refresh 토큰은 1회용(서버가 매번 로테이션)
   * 이고, 이미 로테이션된 토큰이 재제시되면 서버가 '재사용'으로 보고 **전 세션을
   * 무효화**한다. 액세스 토큰 만료 시 여러 요청이 동시에 401을 만나 각자 refresh하면
   * 같은 저장 토큰이 두 번 나가 강제 로그아웃되므로, 진행 중 refresh가 있으면 그
   * Promise를 공유해 서버로는 딱 한 번만 보낸다. 새 토큰 저장/액세스 토큰 갱신도
   * 여기서 한 번만 수행한다(웹은 쿠키라 persist가 no-op).
   */
  const refreshSession = useCallback((): Promise<AuthResult> => {
    if (inflightRefresh.current) return inflightRefresh.current;
    // 탭 간 락으로 감싼다 → 동시에 여러 탭이 회전해 서로의 토큰을 무효화하는 걸 막는다.
    const run = withRefreshLock(async () => {
      try {
        const stored = await getStoredRefreshToken();
        const refreshed = await api.auth.refresh(stored ?? undefined);
        await persistRefreshToken(refreshed.refreshToken);
        setAccessToken(refreshed.tokens.accessToken);
        setUser(refreshed.user);
        return refreshed;
      } catch (error) {
        // 만료/회수(401)면 죽은 저장 토큰을 제거(콜드 스타트마다 실패하는 생체인식
        // 프롬프트·죽은 재시도 버튼 방지). 네트워크 오류(비 401)는 보존.
        if (error instanceof ApiError && error.status === 401) {
          await clearStoredRefreshToken();
        }
        throw error;
      } finally {
        inflightRefresh.current = null;
      }
    });
    inflightRefresh.current = run;
    return run;
  }, [setAccessToken]);

  const authedFetch = useCallback(
    async <T,>(fn: (token: AccessToken) => Promise<T>): Promise<T> => {
      try {
        return await fn(accessTokenRef.current);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          throw error;
        }
        // 401 → 단일화된 refresh 후 1회 재시도(동시 401은 같은 refresh를 공유).
        try {
          const refreshed = await refreshSession();
          setStatus("authenticated");
          return await fn(refreshed.tokens.accessToken);
        } catch (refreshError) {
          clearSession();
          throw refreshError;
        }
      }
    },
    [clearSession, refreshSession],
  );

  const refreshMemberships = useCallback(async () => {
    const me = await authedFetch((token) => api.auth.me(token));
    setUser(me.user);
    setMemberships(me.memberships);
  }, [authedFetch]);

  const login = useCallback(
    async (input: LoginRequest) => {
      const result = await api.auth.login(input);
      await persistRefreshToken(result.refreshToken);
      setAccessToken(result.tokens.accessToken);
      setUser(result.user);
      const me = await api.auth.me(result.tokens.accessToken);
      setMemberships(me.memberships);
      setStatus("authenticated");
    },
    [setAccessToken],
  );

  const register = useCallback(
    async (input: RegisterRequest) => {
      const result = await api.auth.register(input);
      await persistRefreshToken(result.refreshToken);
      setAccessToken(result.tokens.accessToken);
      setUser(result.user);
      const me = await api.auth.me(result.tokens.accessToken);
      setMemberships(me.memberships);
      setStatus("authenticated");
    },
    [setAccessToken],
  );

  const biometricLogin = useCallback(async (): Promise<BiometricResult> => {
    const gate = await authenticateBiometricResilient(BIOMETRIC_REASON);
    // ⚠️ `interrupted`를 여기서 막지 않으면 게이트를 통과시킨다 — 프롬프트를
    // 시스템 취소로 만들 수만 있으면 생체인식 없이 세션이 열린다는 뜻이다.
    if (gate === "cancelled" || gate === "failed" || gate === "interrupted") {
      return gate;
    }
    // "ok" 또는 "unsupported"(게이트 스킵) → 저장된 세션 복원 시도.
    // refreshSession이 토큰 저장/401 정리를 단일화해 처리한다.
    const refreshed = await refreshSession();
    const me = await api.auth.me(refreshed.tokens.accessToken);
    setMemberships(me.memberships);
    setStatus("authenticated");
    return "ok";
  }, [refreshSession]);

  const logout = useCallback(async () => {
    // 이 기기의 푸시 구독을 먼저 해지(다음 사용자에게 내 알림이 가지 않도록).
    // authedFetch로 감싸 액세스 토큰이 만료됐어도 refresh 후 1회 재시도한다.
    // 실패는 무시 — 재로그인 시 upsert로 소유자가 교체되고, 서버도 무효 토큰을 정리한다.
    const pushToken = getRegisteredPushToken();
    if (pushToken) {
      try {
        await authedFetch((token) =>
          api.notifications.unsubscribe(token, pushToken),
        );
      } catch {
        // 무시.
      }
    }
    try {
      const stored = await getStoredRefreshToken();
      await api.auth.logout(stored ?? undefined);
    } catch {
      // 서버 실패와 무관하게 로컬 세션은 반드시 정리한다.
    } finally {
      try {
        // 네이티브 보안 저장의 refresh 토큰도 반드시 제거(웹은 no-op).
        await clearStoredRefreshToken();
      } finally {
        // Keychain/Keystore 오류가 나도 메모리 세션은 반드시 닫는다.
        clearSession();
      }
    }
  }, [clearSession]);

  // "offline"에서 사용자가 재시도를 누르면 올라가는 카운터(부트스트랩 이펙트 재실행).
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const retryBootstrap = useCallback(() => {
    setStatus("loading");
    setBootstrapAttempt((n) => n + 1);
  }, []);

  // 마운트 시 1회 부트스트랩: refresh 쿠키가 있으면 자동 로그인 복원.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getStoredRefreshToken();
        // 네이티브 생체인식 잠금: 저장된 세션을 사용하기 전에 본인 확인.
        // 미지원/미등록("unsupported")은 게이트를 건너뛴다 — 잠금이 로그인
        // 데드락이 되면 안 된다. 취소/실패는 로그인 화면으로 보낸다(토큰 보존
        // → 로그인 화면의 생체인식 재시도 버튼으로 다시 시도 가능).
        if (stored && (await getBiometricPref()) === "on") {
          // 시스템 취소는 재시도한다. 콜드 스타트(5시간 이상 미사용 후 안드로이드가
          // 프로세스를 회수한 뒤)에서 앱이 다 뜨기 전에 프롬프트를 띄우면 OS가
          // 거둬 가는데, 그걸 사용자 취소로 처리하는 동안 **아무 조작도 하지
          // 않은 사용자가 로그인 화면으로 튕겼다**. 서버 세션은 멀쩡했다.
          const gate = await authenticateBiometricResilient(BIOMETRIC_REASON);
          if (cancelled) return;
          // 재시도까지 소진한 `interrupted`는 여기서 잠금 화면으로 보낸다 —
          // 토큰은 보존되므로 로그인 화면의 생체인식 버튼으로 다시 열 수 있다.
          if (
            gate === "cancelled" ||
            gate === "failed" ||
            gate === "interrupted"
          ) {
            clearSession();
            return;
          }
        }
        // 단일화된 refresh(토큰 저장·401 정리 포함) → me()로 멤버십 복원.
        const refreshed = await refreshSession();
        if (cancelled) return;
        const me = await api.auth.me(refreshed.tokens.accessToken);
        if (cancelled) return;
        setMemberships(me.memberships);
        setStatus("authenticated");
      } catch (error) {
        if (cancelled) return;
        // 통신 실패(오프라인·타임아웃·5xx)를 미인증으로 처리하면 refresh 쿠키가
        // 멀쩡한데도 로그인 화면으로 튕긴다. refreshSession도 이미 401만 저장 토큰을
        // 지우도록 구분하고 있으니, 여기서도 같은 기준으로 나눈다.
        if (isRetriableFailure(error)) setStatus("offline");
        else clearSession();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clearSession, refreshSession, bootstrapAttempt]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      memberships,
      accessToken,
      status,
      login,
      register,
      logout,
      getAccessToken,
      authedFetch,
      refreshMemberships,
      retryBootstrap,
      biometricLogin,
    }),
    [
      user,
      memberships,
      accessToken,
      status,
      login,
      register,
      logout,
      getAccessToken,
      authedFetch,
      refreshMemberships,
      retryBootstrap,
      biometricLogin,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 인증 컨텍스트 접근 훅. Provider 밖에서 호출하면 명확히 실패시킨다. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}
