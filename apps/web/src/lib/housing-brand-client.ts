"use client";

import {
  housingBrandConnectResponseSchema,
  housingBrandSyncPreviewSchema,
  manualHousingPlanResponseSchema,
  type HousingBrandApplyRequest,
  type HousingBrandConnectRequest,
  type HousingBrandSyncRequest,
} from "@family/contracts";
import { apiFetch, type AccessToken } from "./api-client";

const base = (planId: string) =>
  `/v1/manual-finance/housing-plans/${encodeURIComponent(planId)}`;

export const housingBrandApi = {
  async connect(
    token: AccessToken,
    planId: string,
    body: HousingBrandConnectRequest
  ) {
    return housingBrandConnectResponseSchema.parse(
      await apiFetch(`${base(planId)}/brand-connection`, {
        accessToken: token,
        method: "POST",
        body,
      })
    );
  },
  async sync(token: AccessToken, planId: string, body: HousingBrandSyncRequest) {
    return housingBrandSyncPreviewSchema.parse(
      await apiFetch(`${base(planId)}/brand-sync`, {
        accessToken: token,
        method: "POST",
        body,
      })
    );
  },
  async apply(token: AccessToken, planId: string, body: HousingBrandApplyRequest) {
    return manualHousingPlanResponseSchema.parse(
      await apiFetch(`${base(planId)}/brand-sync/apply`, {
        accessToken: token,
        method: "POST",
        body,
      })
    );
  },
};
