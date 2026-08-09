/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 개인정보 Control Center API (C-3 1단계)
 *
 * 왜 `lib/api-client.ts`·`lib/queries.ts`가 아니라 화면 옆에 있는가: 이 웨이브에서
 * 그 두 파일은 다른 작업들과 동시에 편집되는 공유 지점이라 충돌 비용이 크다. 대신
 * 공용 `apiFetch`(인증·에러 변환·네이티브 헤더 처리)를 그대로 통과시켜 요청 규약이
 * 갈라지지 않게 한다 — 여기서 fetch를 새로 짜면 401 재시도·토큰 헤더가 두 벌이 된다.
 * IA 개편 때 다른 화면들과 함께 `queries.ts`로 올리면 된다.
 * ------------------------------------------------------------------------- */
import type {
  PrivacyConsentRevokeResponse,
  PrivacyOverview,
} from "@family/contracts";

import { apiFetch } from "@/lib/api-client";

export const privacyQueryKey = (householdId: string | null) =>
  ["household-privacy", householdId] as const;

export function fetchPrivacyOverview(
  accessToken: string | null,
  householdId: string,
): Promise<PrivacyOverview> {
  return apiFetch<PrivacyOverview>(`/v1/households/${householdId}/privacy`, {
    accessToken,
  });
}

/** 동의·재동의. `version`은 **화면이 실제로 보여준 문구 버전**이어야 한다(서버가 대조). */
export function grantPrivacyConsent(
  accessToken: string | null,
  householdId: string,
  version: string,
): Promise<PrivacyOverview> {
  return apiFetch<PrivacyOverview>(
    `/v1/households/${householdId}/privacy/consent`,
    { method: "POST", accessToken, body: { version, consent: true } },
  );
}

export function revokePrivacyConsent(
  accessToken: string | null,
  householdId: string,
): Promise<PrivacyConsentRevokeResponse> {
  return apiFetch<PrivacyConsentRevokeResponse>(
    `/v1/households/${householdId}/privacy/consent/revoke`,
    { method: "POST", accessToken, body: { confirm: true } },
  );
}
