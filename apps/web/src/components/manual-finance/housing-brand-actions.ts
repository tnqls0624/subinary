/**
 * 수자인 연결·가져오기·반영의 순서와 실패 처리(2026-11-08 PO 재설계 검토 반영).
 * 화면(HousingBrandPanel)은 이 결과로 상태만 바꾼다. API 는 주입받아 테스트에서 가짜로 돌린다(웹 테스트에는 DOM 이 없다).
 * 409(기록이 바뀜)는 'stale'로 따로 돌려준다 — 화면이 주택을 다시 읽어 version 을 맞춰야 다시 누를 수 있다.
 * 새로 가져오기는 연결 version 만 맞추고 주택 version 은 그대로라, 다시 읽지 않으면 반영이 계속 409 가 난다.
 */
import {
  HOUSING_BRAND_INFO,
  type HousingBrand,
  type HousingBrandApplyRequest,
  type HousingBrandConnectRequest,
  type HousingBrandConnectResponse,
  type HousingBrandConnection,
  type HousingBrandSyncPreview,
  type HousingBrandSyncRequest,
  type ManualHousingPlanResponse,
} from "@family/contracts";
import { ApiError } from "@/lib/api-client";
import {
  connectionFromSyncError,
  housingBrandSyncErrorMessage,
} from "./housing-brand-sync-error";
import type { PreviewChange } from "./plan-summary";

export type HousingBrandActionsApi = {
  connect: (
    body: HousingBrandConnectRequest
  ) => Promise<HousingBrandConnectResponse>;
  sync: (body: HousingBrandSyncRequest) => Promise<HousingBrandSyncPreview>;
  apply: (body: HousingBrandApplyRequest) => Promise<ManualHousingPlanResponse>;
};

/** 다시 읽은 뒤 무엇을 다시 누르면 되는지까지 말한다. */
export const BRAND_STALE_MESSAGE = {
  connect: "최신 일정을 다시 불러왔어요. 다시 눌러 주세요.",
  sync: "최신 일정을 다시 불러왔어요. 다시 가져와 주세요.",
  apply: "최신 일정을 다시 불러왔어요. 다시 가져와 반영해 주세요.",
} as const;
export const BRAND_RELOAD_FAILED_MESSAGE =
  "최신 일정을 불러오지 못했어요. 창을 닫았다가 다시 열어 주세요.";

export function isHousingBrandStale(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export type BrandSyncOutcome =
  | { ok: true; preview: HousingBrandSyncPreview }
  | {
      ok: false;
      stale: boolean;
      message: string;
      /**
       * 서버가 실패를 연결에 남겼으면 그 연결(version 이 올라 있다). 본문에 없으면 null —
       * 실패가 기록됐는지(version 이 올랐는지) 모르므로 지어내지 않고 화면이 다시 읽는다.
       */
      connection: HousingBrandConnection | null;
    };

export async function syncBrand(
  api: Pick<HousingBrandActionsApi, "sync">,
  input: { householdId: string; connection: HousingBrandConnection }
): Promise<BrandSyncOutcome> {
  try {
    const preview = await api.sync({
      householdId: input.householdId,
      expectedConnectionVersion: input.connection.version,
    });
    return { ok: true, preview };
  } catch (failure) {
    if (isHousingBrandStale(failure))
      return {
        ok: false,
        stale: true,
        message: BRAND_STALE_MESSAGE.sync,
        connection: null,
      };
    return {
      ok: false,
      stale: false,
      message: housingBrandSyncErrorMessage(failure, input.connection.brand),
      connection: connectionFromSyncError(failure),
    };
  }
}

export type BrandConnectOutcome =
  /** 연결 저장이 안 됐다 — 가져오기는 부르지 않는다. */
  | { step: "connect"; stale: boolean; message: string }
  /** 연결은 저장됐고 그 연결로 가져오기를 했다(성공·실패는 sync 에). */
  | {
      step: "sync";
      connection: HousingBrandConnection;
      sync: BrandSyncOutcome;
    };

/** '연결하고 가져오기' — 연결을 저장하고, 성공하면 그 연결 version 으로 바로 가져온다. */
export async function connectAndSync(
  api: HousingBrandActionsApi,
  input: {
    householdId: string;
    brand: HousingBrand;
    planVersion: number;
    loginId: string;
    password: string;
  },
  /** 연결이 저장된 순간(가져오기 전) — 화면이 폼을 닫고 '가져오는 중'을 보인다. */
  onConnected?: (connection: HousingBrandConnection) => void
): Promise<BrandConnectOutcome> {
  let connection: HousingBrandConnection;
  try {
    const result = await api.connect({
      householdId: input.householdId,
      brand: input.brand,
      loginId: input.loginId,
      password: input.password,
      expectedPlanVersion: input.planVersion,
    });
    connection = result.connection;
  } catch (failure) {
    return isHousingBrandStale(failure)
      ? { step: "connect", stale: true, message: BRAND_STALE_MESSAGE.connect }
      : {
          step: "connect",
          stale: false,
          message: `${
            HOUSING_BRAND_INFO[input.brand].label
          } 연결을 저장하지 못했어요. 아이디와 비밀번호를 확인해 주세요.`,
        };
  }
  onConnected?.(connection);
  return {
    step: "sync",
    connection,
    sync: await syncBrand(api, { householdId: input.householdId, connection }),
  };
}

/** 반영할 고른 항목 — 처음부터 모두 골라 두므로 뺀 것만 지운다. 바뀐 칸 없는 맞춤 항목은 changes 에 이미 없다. */
export function brandSelections(
  changes: readonly PreviewChange[],
  unchecked: ReadonlySet<string>
): { key: string }[] {
  return changes
    .filter((change) => !unchecked.has(change.key))
    .map((change) => ({ key: change.key }));
}

export type BrandApplyOutcome =
  | { ok: true; plan: ManualHousingPlanResponse }
  | { ok: false; stale: boolean; message: string };

export async function applyBrandChanges(
  api: Pick<HousingBrandActionsApi, "apply">,
  input: {
    householdId: string;
    planVersion: number;
    connection: HousingBrandConnection;
    selections: readonly { key: string }[];
  }
): Promise<BrandApplyOutcome> {
  try {
    const plan = await api.apply({
      householdId: input.householdId,
      expectedPlanVersion: input.planVersion,
      expectedConnectionVersion: input.connection.version,
      selections: [...input.selections],
    });
    return { ok: true, plan };
  } catch (failure) {
    return isHousingBrandStale(failure)
      ? { ok: false, stale: true, message: BRAND_STALE_MESSAGE.apply }
      : {
          ok: false,
          stale: false,
          message:
            "고른 내용을 반영하지 못했어요. 새로 가져온 뒤 다시 반영해 주세요.",
        };
  }
}
