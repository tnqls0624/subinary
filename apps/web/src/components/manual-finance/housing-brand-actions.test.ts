/**
 * 수자인 연결하고 가져오기·새로 가져오기·반영의 순서와 실패 처리(2026-11-08 검토 반영). API 는 가짜, 값도 가짜다.
 * 웹 테스트에는 DOM 이 없어 화면 대신 화면이 쓰는 이 함수들을 고정한다.
 */
import type {
  HousingBrandConnection,
  HousingBrandFetchedItem,
  HousingBrandSyncPreview,
  ManualHousingPayment,
  ManualHousingPlanResponse,
} from "@family/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";

import {
  applyBrandChanges,
  BRAND_STALE_MESSAGE,
  brandSelections,
  connectAndSync,
  isHousingBrandStale,
  syncBrand,
  type HousingBrandActionsApi,
} from "./housing-brand-actions";
import { previewChanges } from "./plan-summary";

const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const PAYMENT_ID = "44444444-4444-4444-8444-444444444444";
const AT = "2026-11-08T14:27:00.000Z";

const connection = (
  over: Partial<HousingBrandConnection> = {}
): HousingBrandConnection => ({
  id: "11111111-1111-4111-8111-111111111111",
  planId: PLAN_ID,
  brand: "sujain",
  status: "connected",
  statusMessage: null,
  credentialsStored: true,
  version: 5,
  lastFetchAt: AT,
  lastSuccessAt: AT,
  canManage: true,
  ...over,
});

const payment: ManualHousingPayment = {
  id: PAYMENT_ID,
  planId: PLAN_ID,
  kind: "interim",
  installment: 3,
  label: null,
  dueDate: "2026-11-20",
  amount: "3000000",
  paidAmount: "0",
  paidDate: null,
};

const item = (
  over: Partial<HousingBrandFetchedItem>
): HousingBrandFetchedItem => ({
  key: "55555555-5555-4555-8555-555555555555",
  kind: "interim",
  installment: 3,
  label: null,
  scheduledAmount: null,
  dueDate: null,
  paidAmount: null,
  paidDate: null,
  actualPaidDate: null,
  matchedPaymentId: null,
  changedFields: [],
  unreadFields: [],
  ...over,
});

const preview = (
  items: HousingBrandFetchedItem[],
  over: Partial<HousingBrandConnection> = {}
): HousingBrandSyncPreview => ({
  fetchedAt: AT,
  fetchedAtSeoul: "2026-11-08 23:27",
  source: "sujain_fetch",
  items,
  unreadCount: 0,
  unreadReasons: [],
  connection: connection({ status: "needs_confirmation", version: 7, ...over }),
});

const applied: ManualHousingPlanResponse = {
  item: {
    id: PLAN_ID,
    householdId: HOUSEHOLD,
    ownerUserId: "me",
    version: 3,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-08T14:28:00Z",
    canEdit: true,
    label: "합성 아파트 59",
    visibility: "household",
    occupancyYear: 2028,
    contractStage: null,
    fundingNote: null,
  },
  payments: [{ ...payment, amount: "3100000" }],
  brandConnection: connection({ version: 8 }),
};

const stale = () =>
  new ApiError(409, "기록이 변경됐어요. 최신 내용을 다시 확인해 주세요.", {
    code: "housing_brand_stale",
  });

function fakeApi(over: Partial<HousingBrandActionsApi> = {}) {
  const calls: string[] = [];
  const api = {
    connect: vi.fn(async () => {
      calls.push("connect");
      return { connection: connection({ version: 6 }) };
    }),
    sync: vi.fn(async () => {
      calls.push("sync");
      return preview([]);
    }),
    apply: vi.fn(async () => {
      calls.push("apply");
      return applied;
    }),
    ...over,
  } satisfies HousingBrandActionsApi;
  return { api, calls };
}

describe("연결하고 가져오기", () => {
  const input = {
    householdId: HOUSEHOLD,
    brand: "sujain" as const,
    planVersion: 2,
    loginId: "synthetic-user",
    password: "synthetic-pass",
  };

  it("연결을 저장한 뒤 그 연결 version 으로 가져온다 — 순서·인자 고정", async () => {
    const { api, calls } = fakeApi();
    const connected = vi.fn();
    const outcome = await connectAndSync(api, input, connected);
    expect(calls).toEqual(["connect", "sync"]);
    expect(api.connect).toHaveBeenCalledWith({
      householdId: HOUSEHOLD,
      brand: "sujain",
      loginId: "synthetic-user",
      password: "synthetic-pass",
      expectedPlanVersion: 2,
    });
    expect(api.sync).toHaveBeenCalledWith({
      householdId: HOUSEHOLD,
      expectedConnectionVersion: 6,
    });
    // 화면은 가져오기 전에 폼을 닫고 '가져오는 중'을 보인다.
    expect(connected).toHaveBeenCalledTimes(1);
    expect(connected.mock.calls[0]?.[0]).toMatchObject({ version: 6 });
    expect(outcome).toMatchObject({
      step: "sync",
      connection: { version: 6 },
      sync: { ok: true, preview: { connection: { version: 7 } } },
    });
  });

  it("연결 저장이 실패하면 가져오기를 부르지 않는다", async () => {
    const { api } = fakeApi({
      connect: vi.fn(async () => {
        throw new ApiError(400, "입력한 값과 미입력 항목을 확인해 주세요.");
      }),
    });
    const connected = vi.fn();
    const outcome = await connectAndSync(api, input, connected);
    expect(api.sync).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      step: "connect",
      stale: false,
      message:
        "수자인 연결을 저장하지 못했어요. 아이디와 비밀번호를 확인해 주세요.",
    });
  });

  it("주택 version 이 낡아 연결이 409 면 stale — 화면이 다시 읽고 '다시 눌러 주세요'", async () => {
    const { api } = fakeApi({
      connect: vi.fn(async () => {
        throw stale();
      }),
    });
    expect(await connectAndSync(api, input)).toEqual({
      step: "connect",
      stale: true,
      message: BRAND_STALE_MESSAGE.connect,
    });
    expect(api.sync).not.toHaveBeenCalled();
  });

  it("연결은 됐는데 가져오기가 실패하면 서버가 남긴 실패 연결을 돌려준다(폼은 이미 닫혔다)", async () => {
    const failedConnection = connection({
      status: "failed",
      statusMessage:
        "수자인 로그인에 실패했어요. 아이디와 비밀번호를 다시 확인해 주세요.",
      version: 7,
    });
    const { api } = fakeApi({
      sync: vi.fn(async () => {
        throw new ApiError(400, failedConnection.statusMessage!, {
          connection: failedConnection,
        });
      }),
    });
    const connected = vi.fn();
    const outcome = await connectAndSync(api, input, connected);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      step: "sync",
      connection: connection({ version: 6 }),
      sync: {
        ok: false,
        stale: false,
        message: failedConnection.statusMessage,
        connection: failedConnection,
      },
    });
  });
});

describe("새로 가져오기", () => {
  it("본문에 연결이 없으면 version 을 지어내지 않는다 — 화면이 다시 읽는다", async () => {
    const { api } = fakeApi({
      sync: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const outcome = await syncBrand(api, {
      householdId: HOUSEHOLD,
      connection: connection(),
    });
    expect(api.sync).toHaveBeenCalledWith({
      householdId: HOUSEHOLD,
      expectedConnectionVersion: 5,
    });
    expect(outcome).toEqual({
      ok: false,
      stale: false,
      message: "수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.",
      connection: null,
    });
  });

  it("연결 version 이 낡아 409 면 stale", async () => {
    const { api } = fakeApi({
      sync: vi.fn(async () => {
        throw stale();
      }),
    });
    expect(
      await syncBrand(api, { householdId: HOUSEHOLD, connection: connection() })
    ).toEqual({
      ok: false,
      stale: true,
      message: BRAND_STALE_MESSAGE.sync,
      connection: null,
    });
  });
});

describe("반영하기", () => {
  const items = [
    // 기존 일정과 맞춰졌고 금액이 바뀜 → 목록에 나온다.
    item({
      matchedPaymentId: PAYMENT_ID,
      scheduledAmount: "3100000",
      changedFields: ["scheduledAmount"],
    }),
    // 맞춰졌지만 바뀐 칸이 없고 못 읽은 칸만 → 목록에서 빠지고 보내지도 않는다.
    item({
      key: "66666666-6666-4666-8666-666666666666",
      matchedPaymentId: PAYMENT_ID,
      unreadFields: [
        { field: "paidAmount", reason: "낸 금액 칸을 읽지 못했어요." },
      ],
    }),
    // 새 옵션 일정.
    item({
      key: "77777777-7777-4777-8777-777777777777",
      kind: "option",
      installment: null,
      label: "발코니 확장 외 2 · 계약금",
      scheduledAmount: "1000000",
      dueDate: "2026-11-20",
      changedFields: ["scheduledAmount", "dueDate", "label"],
    }),
    item({
      key: "88888888-8888-4888-8888-888888888888",
      kind: "option",
      installment: null,
      label: "시스템 에어컨 · 계약금",
      scheduledAmount: "2000000",
      changedFields: ["scheduledAmount", "label"],
    }),
  ];
  const changes = previewChanges(items, [payment]);

  it("처음부터 모두 고른 상태 — 뺀 키와 바뀐 칸 없는 맞춤 항목은 보내지 않는다", () => {
    expect(changes.map((change) => change.key)).toEqual([
      items[0]!.key,
      items[2]!.key,
      items[3]!.key,
    ]);
    expect(brandSelections(changes, new Set())).toEqual([
      { key: items[0]!.key },
      { key: items[2]!.key },
      { key: items[3]!.key },
    ]);
    expect(brandSelections(changes, new Set([items[3]!.key]))).toEqual([
      { key: items[0]!.key },
      { key: items[2]!.key },
    ]);
    expect(
      brandSelections(changes, new Set(changes.map((change) => change.key)))
    ).toEqual([]);
  });

  it("주택 version 과 연결 version 을 함께 보내고, 성공하면 새 주택(연결 포함)을 돌려준다", async () => {
    const { api } = fakeApi();
    const outcome = await applyBrandChanges(api, {
      householdId: HOUSEHOLD,
      planVersion: 2,
      connection: connection({ status: "needs_confirmation", version: 7 }),
      selections: brandSelections(changes, new Set([items[3]!.key])),
    });
    expect(api.apply).toHaveBeenCalledWith({
      householdId: HOUSEHOLD,
      expectedPlanVersion: 2,
      expectedConnectionVersion: 7,
      selections: [{ key: items[0]!.key }, { key: items[2]!.key }],
    });
    expect(outcome).toEqual({ ok: true, plan: applied });
  });

  it("409 면 stale — 화면이 결과를 닫고 다시 읽은 뒤 '다시 가져와 반영해 주세요'", async () => {
    const { api } = fakeApi({
      apply: vi.fn(async () => {
        throw stale();
      }),
    });
    expect(
      await applyBrandChanges(api, {
        householdId: HOUSEHOLD,
        planVersion: 2,
        connection: connection({ version: 7 }),
        selections: [{ key: items[0]!.key }],
      })
    ).toEqual({ ok: false, stale: true, message: BRAND_STALE_MESSAGE.apply });
    expect(BRAND_STALE_MESSAGE.apply).toBe(
      "최신 일정을 다시 불러왔어요. 다시 가져와 반영해 주세요."
    );
  });

  it("다른 실패는 stale 이 아니다", async () => {
    const { api } = fakeApi({
      apply: vi.fn(async () => {
        throw new ApiError(400, "확인할 미리보기가 없어요.");
      }),
    });
    expect(
      await applyBrandChanges(api, {
        householdId: HOUSEHOLD,
        planVersion: 2,
        connection: connection(),
        selections: [{ key: items[0]!.key }],
      })
    ).toEqual({
      ok: false,
      stale: false,
      message:
        "고른 내용을 반영하지 못했어요. 새로 가져온 뒤 다시 반영해 주세요.",
    });
    expect(isHousingBrandStale(new ApiError(400, "x"))).toBe(false);
    expect(isHousingBrandStale(new Error("x"))).toBe(false);
    expect(isHousingBrandStale(stale())).toBe(true);
  });
});
