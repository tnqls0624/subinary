"use client";
import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { ConnectionError } from "@/components/connection-error";
import { Onboarding } from "@/components/onboarding";
/** 금융·게임이 함께 사용하는 인증 및 가구 준비 경계. */
export function AppReadinessBoundary({children}: {children: ReactNode}) {
  const router=useRouter();
  const {status,memberships,retryBootstrap}=useAuth();
  const {householdId}=useHousehold();
  useEffect(()=>{if(status==="unauthenticated")router.replace("/login");},[status,router]);
  if(status==="offline")return <ConnectionError onRetry={retryBootstrap}/>;
  if(status!=="authenticated")return <main className="flex min-h-dvh items-center justify-center" role="status">불러오는 중…</main>;
  if(!memberships.length||!householdId)return <main className="min-h-dvh px-4 pt-[env(safe-area-inset-top)]"><Onboarding/></main>;
  return children;
}
