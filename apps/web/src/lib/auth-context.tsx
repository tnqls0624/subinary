"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 인증 컨텍스트 (Phase 5 §6.1)
 *
 * 인증 흐름(스펙 §1.6):
 *  - access token은 메모리(React state + ref)에만 보관한다. 로컬스토리지 금지.
 *  - refresh token은 HttpOnly 쿠키(`/v1/auth`)에 있고 fetch가 자동 전송한다.
 *  - 마운트 시 bootstrap(): POST /v1/auth/refresh → 성공 시 me()로 사용자·멤버십 복원.
 *  - authedFetch: 401 → refresh 1회 재시도 → 재실패 시 로그아웃 상태 전환.
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
  HouseholdMembershipSummary,
  LoginRequest,
  RegisterRequest,
  UserSummary,
} from "@family/contracts";

import { ApiError, api, type AccessToken } from "./api-client";
import {
  clearStoredRefreshToken,
  getStoredRefreshToken,
  persistRefreshToken,
} from "./native";

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

  const authedFetch = useCallback(
    async <T,>(fn: (token: AccessToken) => Promise<T>): Promise<T> => {
      try {
        return await fn(accessTokenRef.current);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          throw error;
        }
        // 401 → refresh 1회 재시도. 네이티브는 저장된 토큰을 싣고, 로테이션된
        // 새 토큰을 다시 저장한다(웹은 두 헬퍼 모두 no-op → 쿠키 흐름 그대로).
        try {
          const stored = await getStoredRefreshToken();
          const refreshed = await api.auth.refresh(stored ?? undefined);
          await persistRefreshToken(refreshed.refreshToken);
          setAccessToken(refreshed.tokens.accessToken);
          setUser(refreshed.user);
          setStatus("authenticated");
          return await fn(refreshed.tokens.accessToken);
        } catch (refreshError) {
          clearSession();
          throw refreshError;
        }
      }
    },
    [clearSession, setAccessToken],
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

  const logout = useCallback(async () => {
    try {
      const stored = await getStoredRefreshToken();
      await api.auth.logout(stored ?? undefined);
    } catch {
      // 서버 실패와 무관하게 로컬 세션은 반드시 정리한다.
    } finally {
      // 네이티브 보안 저장의 refresh 토큰도 반드시 제거(웹은 no-op).
      await clearStoredRefreshToken();
    }
    clearSession();
  }, [clearSession]);

  // 마운트 시 1회 부트스트랩: refresh 쿠키가 있으면 자동 로그인 복원.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getStoredRefreshToken();
        const refreshed = await api.auth.refresh(stored ?? undefined);
        if (cancelled) return;
        await persistRefreshToken(refreshed.refreshToken);
        setAccessToken(refreshed.tokens.accessToken);
        setUser(refreshed.user);
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
  }, [clearSession, setAccessToken]);

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
