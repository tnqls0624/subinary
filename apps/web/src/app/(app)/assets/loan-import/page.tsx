"use client";

import { LoanImportScreen } from "@/components/loan-import/import-screen";
import { manualFinanceCanCreate } from "@/components/manual-finance/model";
import { EmptyState } from "@/components/widgets";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";

export default function LoanImportPage() {
  const { user, status } = useAuth();
  const { householdId, activeMembership } = useHousehold();
  if (!householdId || !user || status !== "authenticated") {
    return <EmptyState title="가족을 선택해 주세요" description="로그인한 가족에서 대출 확인 파일을 가져올 수 있어요." />;
  }
  // Changing identity, household or write permission destroys all in-memory file/draft state.
  return <LoanImportScreen key={`${user.id}/${householdId}/${activeMembership?.role}`} householdId={householdId} userId={user.id} canCreate={manualFinanceCanCreate(activeMembership?.role)} />;
}
