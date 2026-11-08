import { describe, expect, it } from "vitest";
import type { HousingBrandConnection } from "@family/contracts";
import { ApiError } from "@/lib/api-client";
import {
  connectionFromSyncError,
  housingBrandLocalErrorNotice,
  housingBrandSyncErrorMessage,
} from "./housing-brand-sync-error";

const connection = (): HousingBrandConnection => ({
  id: "11111111-1111-4111-8111-111111111111",
  planId: "22222222-2222-4222-8222-222222222222",
  brand: "sujain",
  status: "failed",
  statusMessage: "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.",
  credentialsStored: true,
  version: 2,
  lastFetchAt: "2026-11-07T08:51:00.000Z",
  lastSuccessAt: null,
  canManage: true,
});

describe("housingBrandSyncErrorMessage", () => {
  it("uses the server public message instead of a hardcoded extra-auth hint", () => {
    const error = new ApiError(
      400,
      "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.",
      { message: "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요." },
      "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요."
    );
    expect(housingBrandSyncErrorMessage(error)).toBe(
      "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요."
    );
    expect(housingBrandSyncErrorMessage(error)).not.toContain("추가 인증");
  });

  it("falls back without mentioning extra auth when the error is opaque", () => {
    expect(housingBrandSyncErrorMessage(new Error("boom"))).toBe(
      "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요."
    );
    expect(housingBrandSyncErrorMessage(new Error("boom"))).not.toContain("추가 인증");
  });

  it("builds the fallback from the brand label without changing the sujain sentence", () => {
    expect(housingBrandSyncErrorMessage(new Error("boom"), "sujain")).toBe(
      "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요."
    );
  });
});

describe("connectionFromSyncError", () => {
  it("refreshes connection status from the sync error body", () => {
    const refreshed = connection();
    const error = new ApiError(
      400,
      refreshed.statusMessage!,
      { message: refreshed.statusMessage, connection: refreshed },
      refreshed.statusMessage
    );
    expect(connectionFromSyncError(error)).toEqual(refreshed);
  });

  it("ignores bodies without a valid connection and never echoes secrets", () => {
    const error = new ApiError(
      400,
      "실패",
      { message: "실패", password: "SYNTHETIC_SECRET", connection: { brand: "sujain" } },
      "실패"
    );
    expect(connectionFromSyncError(error)).toBeNull();
    expect(JSON.stringify(connectionFromSyncError(error))).not.toContain("SYNTHETIC_SECRET");
  });
});

describe("housingBrandLocalErrorNotice", () => {
  it("hides a local notice that duplicates the connection status message", () => {
    const same =
      "수자인 표 구성을 읽지 못했어요. 못 읽은 칸은 비워 두었어요.";
    expect(housingBrandLocalErrorNotice(same, same)).toBeNull();
  });

  it("keeps distinct connect/apply notices when status message differs", () => {
    expect(
      housingBrandLocalErrorNotice(
        "수자인 연결을 저장하지 못했어요. 입력값을 확인해 주세요.",
        "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요."
      )
    ).toBe("수자인 연결을 저장하지 못했어요. 입력값을 확인해 주세요.");
    expect(housingBrandLocalErrorNotice("고른 항목을 일정에 반영하지 못했어요.", null)).toBe(
      "고른 항목을 일정에 반영하지 못했어요."
    );
  });
});
