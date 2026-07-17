"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 활성 가족(household) 훅
 *
 * 이전(Context) 구현을 Zustand store(useHouseholdStore) 기반으로 교체했다.
 * 공개 API(useHousehold의 반환 shape)는 그대로 유지 → 기존 페이지 무수정.
 *
 * - 활성 householdId = 선택값(store)이 현재 멤버십에 유효하면 그 값, 아니면
 *   memberships[0]로 폴백. 폴백은 파생값이라 store에 쓰지 않는다(effect 없음).
 * - 가족 전환(setHouseholdId)만 store에 저장되어 새로고침 후에도 복원된다.
 * ------------------------------------------------------------------------- */
import { useCallback, useMemo } from "react";

import type { HouseholdMembershipSummary } from "@family/contracts";

import { useAuth } from "./auth-context";
import { useHouseholdStore } from "./store";

interface HouseholdContextValue {
  /** 현재 활성 householdId(멤버십이 없으면 null). */
  householdId: string | null;
  /** 활성 가족 전환. */
  setHouseholdId: (id: string) => void;
  /** 현재 활성 멤버십 항목(역할 등 참조용). */
  activeMembership: HouseholdMembershipSummary | null;
  /** 선택 가능한 전체 멤버십. */
  memberships: HouseholdMembershipSummary[];
}

/** 활성 가족 훅. Provider 불필요(Zustand). */
export function useHousehold(): HouseholdContextValue {
  const { memberships } = useAuth();
  const selectedId = useHouseholdStore((s) => s.selectedId);
  const setSelectedId = useHouseholdStore((s) => s.setSelectedId);

  const householdId = useMemo<string | null>(() => {
    if (selectedId && memberships.some((m) => m.householdId === selectedId)) {
      return selectedId;
    }
    return memberships[0]?.householdId ?? null;
  }, [selectedId, memberships]);

  const setHouseholdId = useCallback(
    (id: string) => setSelectedId(id),
    [setSelectedId],
  );

  return useMemo<HouseholdContextValue>(
    () => ({
      householdId,
      setHouseholdId,
      activeMembership:
        memberships.find((m) => m.householdId === householdId) ?? null,
      memberships,
    }),
    [householdId, setHouseholdId, memberships],
  );
}
