/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 개인정보 Control Center API (C-3 + SOO-34)
 *
 * 공용 `apiFetch`만 통과시켜 401 재시도·토큰 헤더가 갈라지지 않게 한다.
 * ------------------------------------------------------------------------- */
import type {
  PrivacyOverview,
  PrivacyRetentionPreviewResponse,
  PrivacyRetentionUpdateResponse,
  RetentionPolicy,
} from "@family/contracts";

import { apiFetch } from "@/lib/api-client";

export const privacyQueryKey = (householdId: string | null) =>
  ["household-privacy", householdId] as const;

export function fetchPrivacyOverview(
  accessToken: string | null,
  householdId: string
): Promise<PrivacyOverview> {
  return apiFetch<PrivacyOverview>(`/v1/households/${householdId}/privacy`, {
    accessToken,
  });
}

export function previewRetentionPolicy(
  accessToken: string | null,
  householdId: string,
  policy: RetentionPolicy
): Promise<PrivacyRetentionPreviewResponse> {
  return apiFetch<PrivacyRetentionPreviewResponse>(
    `/v1/households/${householdId}/privacy/retention/preview`,
    {
      accessToken,
      method: "POST",
      body: { policy },
    }
  );
}

export function updateRetentionPolicy(
  accessToken: string | null,
  householdId: string,
  input: {
    policy: RetentionPolicy;
    expectedEventCount: number;
    expectedSuppressionCount: number;
  }
): Promise<PrivacyRetentionUpdateResponse> {
  return apiFetch<PrivacyRetentionUpdateResponse>(
    `/v1/households/${householdId}/privacy/retention`,
    {
      accessToken,
      method: "POST",
      body: {
        policy: input.policy,
        confirm: true,
        expectedEventCount: input.expectedEventCount,
        expectedSuppressionCount: input.expectedSuppressionCount,
      },
    }
  );
}
