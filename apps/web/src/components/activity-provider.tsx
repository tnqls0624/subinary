"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 전역 결제 활동 레이어
 *
 * "어떤 탭에 있든 새 결제를 실시간으로 인지"를 담당하는 앱 셸 상주 컴포넌트.
 *
 * 수명주기 설계:
 * - 포그라운드: SSE(/v1/realtime/stream) 연결 유지 → 힌트 수신 시 쿼리 무효화
 *   + 새 거래 토스트/탭 배지. 서버 하트비트(25초)를 워치독으로 감시해 half-open
 *   좀비 연결을 감지(60초 무수신 시 강제 재연결). 연결 실패 시 지수 백오프
 *   재연결, 60초 폴링이 최종 안전망(SSE 불통이어도 최대 1분 내 수렴).
 * - 백그라운드 진입(visibilitychange hidden): SSE를 끊는다 — 배터리 절약 +
 *   프록시 유휴 절단으로 인한 무의미한 재연결 방지. 폴링 틱도 쉰다.
 * - 포그라운드 복귀: 즉시 전체 무효화 + 활동 확인(백그라운드 중 유실 이벤트
 *   캐치업) 후 SSE 재연결. Capacitor 복귀는 native-bootstrap의 appStateChange
 *   무효화가 이중 안전망.
 *
 * 새 거래 판정: 거래 목록(createdAt desc)을 커서와 비교. 커서가 없으면(첫 방문)
 * 조용히 커서만 심는다(토스트 폭주 방지). 거래 탭을 보고 있으면 화면이 직접
 * 갱신되므로 토스트/배지를 생략하고 커서만 전진시킨다. summary_only(masked)
 * 거래는 가맹점을 노출하지 않고, 취소 거래는 '취소' 문구로 표기한다.
 * ------------------------------------------------------------------------- */
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { create } from "zustand";

import { API_BASE_URL, ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { formatWon } from "@/lib/format";
import { useHousehold } from "@/lib/household-context";
import { initPushNotifications } from "@/lib/native";
import { invalidateTransactionScope } from "@/lib/queries";
import { nextBackoff, readSseStream } from "@/lib/realtime";

/** SSE 힌트 디바운스(ms) — 연속 승격(백필 등) 폭주를 1회 무효화로 합친다. */
const HINT_DEBOUNCE_MS = 400;
/** 폴링 안전망 주기(ms). SSE가 정상일 땐 힌트가 먼저 도착해 사실상 유휴. */
const FALLBACK_POLL_MS = 60_000;
/** 활동 확인 시 가져올 최근 거래 수(체크 간 대량 유입 과소 카운트 완화). */
const ACTIVITY_SCAN_LIMIT = 50;
/**
 * SSE 무수신 워치독(ms). 서버 하트비트가 25초이므로 그 2배 이상 무소식이면
 * half-open(예: 모바일 슬립 후 소켓 유령화)으로 보고 강제 재연결한다.
 */
const SSE_WATCHDOG_MS = 60_000;

interface ActivityStore {
  /** 거래 탭 미방문 동안 쌓인 새 거래 수(탭 배지). */
  unseenCount: number;
  bump: (n: number) => void;
  clear: () => void;
}

/** 하단 탭 배지가 구독하는 전역 활동 상태. */
export const useActivityStore = create<ActivityStore>((set) => ({
  unseenCount: 0,
  bump: (n) =>
    set((s) => ({ unseenCount: Math.min(s.unseenCount + n, 99) })),
  clear: () => set({ unseenCount: 0 }),
}));

/**
 * 커서 인메모리 미러 — localStorage 쓰기가 실패해도(사파리 프라이빗·쿼터 초과)
 * 세션 내에서는 커서가 전진해 같은 거래가 반복 토스트되는 것을 막는다.
 */
const memoryCursor = new Map<string, string>();

function cursorKey(householdId: string): string {
  return `fma.activity-cursor.${householdId}`;
}

function readCursor(householdId: string): string | null {
  const inMemory = memoryCursor.get(householdId);
  if (inMemory) return inMemory;
  try {
    return window.localStorage.getItem(cursorKey(householdId));
  } catch {
    return null;
  }
}

function writeCursor(householdId: string, value: string): void {
  // 인메모리 먼저(항상 성공) → localStorage 시도(실패해도 세션 내 반복 방지 유지).
  memoryCursor.set(householdId, value);
  try {
    window.localStorage.setItem(cursorKey(householdId), value);
  } catch {
    // 저장 불가 — 인메모리 커서로 세션 내 동작은 유지되고, 재방문 시 첫 커서만
    // 다시 심긴다(치명적이지 않다).
  }
}

/** 앱 셸((app)/layout)에 1회 마운트되는 무렌더 컴포넌트. */
export function ActivityProvider() {
  const { status, authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const router = useRouter();
  const bump = useActivityStore((s) => s.bump);
  const clear = useActivityStore((s) => s.clear);

  // 콜백들이 최신 값을 리렌더 없이 읽도록 ref로 미러링.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const householdIdRef = useRef(householdId);
  householdIdRef.current = householdId;
  // checkActivity 단일화 가드(동시 실행 시 응답 교차로 커서 역행 방지).
  const checkingRef = useRef(false);

  /**
   * 활동 확인: 최근 거래를 커서와 비교해 새 거래를 감지한다. 단일화(single-flight)
   * 되어 동시 호출은 조용히 스킵한다. 새 거래가 있으면 무효화(+거래 탭 밖이면
   * 토스트/배지). 실패는 조용히 무시(다음 틱/힌트가 재시도).
   */
  const checkActivity = useCallback(async () => {
    if (checkingRef.current) return;
    const hid = householdIdRef.current;
    if (!hid) return;
    checkingRef.current = true;
    try {
      let items;
      try {
        const res = await authedFetch((token) =>
          api.transactions.list(token, { householdId: hid, limit: ACTIVITY_SCAN_LIMIT }),
        );
        items = res.items;
      } catch {
        return;
      }

      // 응답이 도착하기 전에 가족이 바뀌었으면 이전 가족 결과를 적용하지 않는다.
      if (householdIdRef.current !== hid) return;

      const newest = items[0]?.createdAt;
      const cursor = readCursor(hid);
      if (newest) writeCursor(hid, newest);
      if (!cursor) return; // 첫 방문 — 커서만 심고 침묵.

      const fresh = items.filter((t) => t.createdAt > cursor);
      if (fresh.length === 0) return;

      invalidateTransactionScope(queryClient);
      if (pathnameRef.current === "/transactions") return; // 화면이 직접 갱신됨.

      bump(fresh.length);
      // 스냅샷이 상한(ACTIVITY_SCAN_LIMIT)에 가득 찼으면 더 있을 수 있어 '+' 표기.
      const many = fresh.length >= ACTIVITY_SCAN_LIMIT;
      const first = fresh[0];
      const isCancel = first.transactionType === "cancellation";
      const merchant = first.masked
        ? null
        : (first.merchantNormalized ?? first.merchantRaw);
      const noun = isCancel ? "결제 취소" : "거래";
      const message =
        fresh.length === 1 && merchant
          ? `${merchant} ${formatWon(first.amount)} ${noun}가 기록됐어요`
          : `새 ${noun} ${fresh.length}${many ? "+" : ""}건이 기록됐어요`;
      toast.info(message, {
        action: { label: "보기", onClick: () => router.push("/transactions") },
      });
    } finally {
      checkingRef.current = false;
    }
  }, [authedFetch, queryClient, bump, router]);

  const checkActivityRef = useRef(checkActivity);
  checkActivityRef.current = checkActivity;

  // 네이티브 푸시 초기화. 권한 요청 → 토큰을 서버에 등록하고, 포그라운드 수신 시
  // 무효화, 알림 탭 시 딥링크(거래 상세)로 이동한다. 웹에서는 no-op. 리스너 중복
  // 등록은 native.ts가 세션당 1회로 고정하므로, 재로그인 시 재호출해 콜백만
  // 최신으로 갱신해도 안전하다.
  useEffect(() => {
    if (status !== "authenticated") return;
    void initPushNotifications({
      onToken: (token, platform) => {
        void authedFetch((t) =>
          api.notifications.subscribe(t, { token, platform }),
        ).catch(() => {
          // 등록 실패는 조용히 무시(다음 세션에서 재시도). 앱 내 SSE가 대체 경로.
        });
      },
      onForegroundReceived: () => invalidateTransactionScope(queryClient),
      onDeepLink: (path) => router.push(path),
    });
  }, [status, authedFetch, queryClient, router]);

  // 거래 탭 방문 = 확인 완료 → 배지 해제 + 커서 전진(재토스트 방지).
  // 가족 전환 시에도 배지 리셋.
  useEffect(() => {
    if (pathname === "/transactions") {
      clear();
      void checkActivityRef.current();
    }
  }, [pathname, clear]);
  useEffect(() => {
    clear();
  }, [householdId, clear]);

  // SSE 연결 + 폴링 안전망 + 백/포그라운드 수명주기.
  useEffect(() => {
    if (status !== "authenticated" || !householdId) return;

    let stopped = false;
    let running = false;
    let controller: AbortController | null = null;
    let hintTimer: number | null = null;

    const sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    // 힌트 디바운스 → 무효화 + 활동 확인(토스트/배지).
    const scheduleHint = () => {
      if (hintTimer != null) return;
      hintTimer = window.setTimeout(() => {
        hintTimer = null;
        invalidateTransactionScope(queryClient);
        void checkActivityRef.current();
      }, HINT_DEBOUNCE_MS);
    };

    // 연결 루프(동시 1개 보장). visible 상태에서만 돈다 — hidden이면 종료하고,
    // visible 복귀 시 onVisibility가 재시작한다. 종료 조건을 signal.aborted가
    // 아니라 '중단(stopped)/숨김(hidden)'으로 두는 게 핵심: refresh 도중 abort가
    // 겹쳐 시도가 취소돼도, 여전히 visible이면 루프를 끝내지 않고 재연결한다.
    // 함수 호출로 감싸 TS가 visibilityState를 리터럴로 좁히지 않게 한다
    // (getter라 루프 반복 사이 값이 바뀐다).
    const isHidden = () => document.visibilityState === "hidden";

    const connect = async () => {
      if (running) return;
      running = true;
      let backoff = 1_000;
      try {
        while (!stopped && !isHidden()) {
          controller = new AbortController();
          const { signal } = controller;
          let watchdog: number | null = null;
          try {
            await authedFetch(async (token) => {
              const query = `householdId=${encodeURIComponent(householdId)}`;
              const res = await fetch(
                `${API_BASE_URL}/v1/realtime/stream?${query}`,
                {
                  headers: {
                    accept: "text/event-stream",
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                  },
                  credentials: "include",
                  cache: "no-store",
                  signal,
                },
              );
              if (!res.ok || !res.body) {
                // 401은 authedFetch가 refresh 후 1회 재시도한다.
                throw new ApiError(
                  res.status,
                  `realtime stream failed (${res.status})`,
                );
              }
              backoff = 1_000; // 연결 성공 → 백오프 리셋.
              // 워치독: 힌트/하트비트 어느 것이든 수신되면 리셋. 무수신 지속 시
              // half-open으로 보고 abort → 루프가 재연결한다.
              const arm = () => {
                if (watchdog != null) window.clearTimeout(watchdog);
                watchdog = window.setTimeout(
                  () => controller?.abort(),
                  SSE_WATCHDOG_MS,
                );
              };
              arm();
              await readSseStream(
                res.body,
                (msg) => {
                  arm();
                  if (msg.event === "hint") scheduleHint();
                },
                signal,
              );
            });
          } catch {
            // 네트워크 오류/중단/재인증 실패 — 아래 백오프 후 재시도.
          } finally {
            if (watchdog != null) window.clearTimeout(watchdog);
          }
          if (stopped || isHidden()) break;
          await sleep(backoff, controller.signal);
          backoff = nextBackoff(backoff);
        }
      } finally {
        running = false;
      }
    };

    // 백그라운드: 연결 해제. 포그라운드 복귀: 캐치업 무효화 + 재연결.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        controller?.abort();
        return;
      }
      invalidateTransactionScope(queryClient);
      void checkActivityRef.current();
      void connect();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void connect();

    // 폴링 안전망: 포그라운드에서만. SSE 정상 시 fresh가 없어 사실상 no-op.
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void checkActivityRef.current();
      }
    }, FALLBACK_POLL_MS);

    return () => {
      stopped = true;
      controller?.abort();
      if (hintTimer != null) window.clearTimeout(hintTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(tick);
    };
  }, [status, householdId, authedFetch, queryClient]);

  return null;
}
