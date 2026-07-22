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
 * ------------------------------------------------------------------------- */
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

import { ApiError, api, type AccessToken } from "./api-client";
import {
  authenticateBiometric,
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

/** 인증 부트스트랩/세션 상태. */
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

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
  }, [setAccessToken]);

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
    const gate = await authenticateBiometric(BIOMETRIC_REASON);
    if (gate === "cancelled" || gate === "failed") return gate;
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
          const gate = await authenticateBiometric(BIOMETRIC_REASON);
          if (cancelled) return;
          if (gate === "cancelled" || gate === "failed") {
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
      } catch {
        if (cancelled) return;
        clearSession();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clearSession, refreshSession]);

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
