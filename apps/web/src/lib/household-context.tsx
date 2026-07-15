"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 활성 가족(household) 컨텍스트 (Phase 5 §6.1)
 *
 * 여러 가족에 속한 사용자를 위해 "현재 보고 있는" householdId를 앱 전역에 제공한다.
 * 기본값은 useAuth().memberships[0]. 상단바 드롭다운에서 전환하며, 멤버십이 바뀌면
 * 유효하지 않은 선택을 자동으로 memberships[0]로 되돌린다.
 * ------------------------------------------------------------------------- */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { HouseholdMembershipSummary } from "@family/contracts";

import { useAuth } from "./auth-context";

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

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

export function HouseholdProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { memberships } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 멤버십 변경 시 선택 유효성 보정: 미선택이거나 사라진 가족이면 첫 항목으로.
  useEffect(() => {
    const ids = memberships.map((m) => m.householdId);
    if (memberships.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !ids.includes(selectedId)) {
      setSelectedId(memberships[0].householdId);
    }
  }, [memberships, selectedId]);

  const householdId = useMemo<string | null>(() => {
    if (selectedId && memberships.some((m) => m.householdId === selectedId)) {
      return selectedId;
    }
    return memberships[0]?.householdId ?? null;
  }, [selectedId, memberships]);

  const value = useMemo<HouseholdContextValue>(
    () => ({
      householdId,
      setHouseholdId: setSelectedId,
      activeMembership:
        memberships.find((m) => m.householdId === householdId) ?? null,
      memberships,
    }),
    [householdId, memberships],
  );

  return (
    <HouseholdContext.Provider value={value}>
      {children}
    </HouseholdContext.Provider>
  );
}

/** 활성 가족 컨텍스트 접근 훅. */
export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) {
    throw new Error("useHousehold must be used within a <HouseholdProvider>");
  }
  return ctx;
}
