"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 클라이언트 전역 상태 (Zustand)
 *
 * 서버 상태(사용자·멤버십·목록)는 TanStack Query + auth-context가 소유한다.
 * 여기서는 순수 "클라 UI 선택" 상태만 다룬다 — 현재 활성 householdId.
 * persist 미들웨어로 새로고침/재방문 시 마지막 선택을 복원한다(localStorage).
 * 실제 활성 household 유효성 보정은 useHousehold()에서 memberships와 대조한다.
 * ------------------------------------------------------------------------- */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface HouseholdSelectionStore {
  /** 사용자가 마지막으로 선택한 householdId(유효성은 useHousehold에서 대조). */
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}

export const useHouseholdStore = create<HouseholdSelectionStore>()(
  persist(
    (set) => ({
      selectedId: null,
      setSelectedId: (id) => set({ selectedId: id }),
    }),
    { name: "fma.active-household" },
  ),
);
