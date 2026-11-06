/**
 * 잘린 이름 제안의 "다른 가게예요"가 **실제로 다음 목록에서 빠지는가**를 고정한다.
 *
 * 거절 기록의 신원은 이름 집합 해시다. 거절이 저장하는 키와 목록이 거르는 키가 한 글자라도
 * 갈리면 "거절했는데 또 뜬다"로만 드러난다 — 그래서 저장(reject)과 필터(list)를 같은
 * 이름으로 왕복시켜 본다. DB 없이 실제 서비스와 Drizzle을 돌린다(합성 데이터).
 */
import { BadRequestException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import { schema } from "@family/database";
import { createMerchantIdentityTargetId } from "@family/shared";

import { MerchantService } from "./merchant.service";

const HOUSEHOLD = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000003";
const NOW = "2026-11-05T00:00:00.000Z";

interface Captured {
  sql: string;
  params: unknown[];
}

function setup(rejectedTargetIds: string[] = []) {
  const queries: Captured[] = [];

  function execute(query: string): unknown[][] {
    if (query.startsWith('insert into "feedback_events"')) return [];
    if (query.includes('from "household_members"')) return [[MEMBER, "owner"]];
    if (query.includes('from "card_transactions"')) {
      // name, transactionCount, netTotal, lastTransactionAt, firstTransactionAt
      return [
        ["합성상점본점", "4", "50000", NOW, NOW],
        ["합성상점", "2", "18000", NOW, NOW],
        ["다른가게", "5", "30000", NOW, NOW],
      ];
    }
    if (query.includes('from "merchant_aliases"')) return [];
    if (query.includes('from "merchant_category_rules"')) return [];
    if (query.includes('from "feedback_events"'))
      return rejectedTargetIds.map((id) => [id]);
    throw new Error("예상하지 않은 검증용 SQL입니다.");
  }

  const driver = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      queries.push({ sql: query, params });
      const response = Promise.resolve().then(() => execute(query));
      return Object.assign(response, { values: () => response });
    },
    async begin(): Promise<never> {
      throw new Error("이 경로는 트랜잭션을 열지 않는다.");
    },
  };
  const service = new MerchantService(
    drizzle(driver as unknown as postgres.Sql, { schema })
  );
  return { service, queries };
}

describe("잘린 이름 제안은 서버가 계산해 거절한 묶음을 거른다", () => {
  it("거절이 없으면 잘린 이름 묶음을 내려준다", async () => {
    const { service } = setup();
    const { truncationCandidates } = await service.listMerchants(
      USER,
      HOUSEHOLD
    );
    expect(truncationCandidates).toEqual([
      {
        canonical: "합성상점본점",
        aliases: ["합성상점"],
        transactionCount: 6,
        netTotal: 68000,
      },
    ]);
  });

  it("거절이 저장한 키로 다음 목록에서 그 묶음이 빠진다", async () => {
    const rejecting = setup();
    await rejecting.service.rejectIdentityCandidate(USER, {
      householdId: HOUSEHOLD,
      names: ["합성상점본점", "합성상점"],
      reason: "truncation",
    });
    const insert = rejecting.queries.find((q) =>
      q.sql.startsWith('insert into "feedback_events"')
    );
    const storedTargetId = insert?.params.find(
      (p) =>
        p ===
        createMerchantIdentityTargetId(HOUSEHOLD, ["합성상점본점", "합성상점"])
    );
    expect(storedTargetId).toBeDefined();
    // 잘린 이름 제안에는 브랜드가 없다 — label에 빈 brand를 남기지 않는다.
    const label = insert?.params.find(
      (p) => typeof p === "string" && p.includes('"decision"')
    );
    expect(JSON.parse(label as string)).toEqual({
      decision: "rejected",
      reason: "truncation",
      nameCount: 2,
    });

    const listing = setup([storedTargetId as string]);
    const { truncationCandidates } = await listing.service.listMerchants(
      USER,
      HOUSEHOLD
    );
    expect(truncationCandidates).toEqual([]);
  });

  it("브랜드 제안 거절은 브랜드 없이 받지 않는다", async () => {
    const { service, queries } = setup();
    await expect(
      service.rejectIdentityCandidate(USER, {
        householdId: HOUSEHOLD,
        names: ["합성상점본점", "합성상점"],
        reason: "brand_notation",
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queries.some((q) => q.sql.startsWith("insert into"))).toBe(false);
  });
});

/**
 * 확정 경로 구분 — 제안 화면 확정은 label에 brand·reason을 남기고, 수동 병합은 남기지
 * 않는다. source는 둘 다 human_confirmed. 기존 행을 고치는 SQL은 없다.
 */
function setupAliases() {
  const queries: Captured[] = [];

  function execute(query: string, params: unknown[]): unknown[][] {
    if (query.includes('from "household_members"')) return [[MEMBER, "owner"]];
    if (query.includes('from "merchant_aliases"') && query.includes("select")) {
      return [];
    }
    if (query.includes('from "merchant_category_rules"')) return [];
    if (query.startsWith('insert into "merchant_aliases"')) {
      // returning: id, alias, canonical, created_at
      return [["alias-1", "합성상점", "합성상점본점", NOW]];
    }
    if (query.startsWith('update "card_transactions"')) {
      return [["tx-1"]];
    }
    if (query.startsWith('insert into "feedback_events"')) return [];
    throw new Error(`예상하지 않은 검증용 SQL입니다: ${query.slice(0, 120)}`);
  }

  const driver = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      queries.push({ sql: query, params });
      const response = Promise.resolve().then(() => execute(query, params));
      return Object.assign(response, { values: () => response });
    },
    // createAliases는 트랜잭션 안에서 feedback을 남긴다 — 같은 드라이버로 이어 받는다.
    async begin(fn: (sql: unknown) => Promise<unknown>) {
      return fn(driver);
    },
  };
  const service = new MerchantService(
    drizzle(driver as unknown as postgres.Sql, { schema })
  );
  return { service, queries };
}

function feedbackLabel(queries: Captured[]): {
  label: Record<string, unknown>;
  source: unknown;
} {
  const insert = queries.find((q) =>
    q.sql.startsWith('insert into "feedback_events"')
  );
  expect(insert).toBeDefined();
  const labelRaw = insert?.params.find(
    (p) => typeof p === "string" && p.includes('"decision"')
  );
  expect(typeof labelRaw).toBe("string");
  // source는 label 다음에 오는 enum 문자열이다(human_confirmed / human_rejected).
  const source = insert?.params.find(
    (p) => p === "human_confirmed" || p === "human_rejected"
  );
  return { label: JSON.parse(labelRaw as string), source };
}

describe("확정 기록은 제안 경로와 수동 병합을 label로 가른다", () => {
  it("제안 화면 확정은 source가 human_confirmed이고 label에 reason(있으면 brand)을 남긴다", async () => {
    const { service, queries } = setupAliases();
    await service.createAliases(USER, {
      householdId: HOUSEHOLD,
      canonical: "합성상점본점",
      aliases: ["합성상점"],
      brand: "합성상점",
      reason: "brand_notation",
    });
    const { label, source } = feedbackLabel(queries);
    expect(source).toBe("human_confirmed");
    expect(label).toEqual({
      decision: "confirmed",
      nameCount: 2,
      brand: "합성상점",
      reason: "brand_notation",
    });
    expect(queries.every((q) => !q.sql.startsWith("update \"feedback_events\""))).toBe(
      true
    );
  });

  it("잘린 이름 제안 확정은 brand 없이 reason truncation만 남긴다", async () => {
    const { service, queries } = setupAliases();
    await service.createAliases(USER, {
      householdId: HOUSEHOLD,
      canonical: "합성상점본점",
      aliases: ["합성상점"],
      reason: "truncation",
    });
    const { label, source } = feedbackLabel(queries);
    expect(source).toBe("human_confirmed");
    expect(label).toEqual({
      decision: "confirmed",
      nameCount: 2,
      reason: "truncation",
    });
  });

  it("수동 병합 확정은 source가 human_confirmed이고 제안 경로 표시가 없다", async () => {
    const { service, queries } = setupAliases();
    await service.createAliases(USER, {
      householdId: HOUSEHOLD,
      canonical: "합성상점본점",
      aliases: ["합성상점"],
    });
    const { label, source } = feedbackLabel(queries);
    expect(source).toBe("human_confirmed");
    expect(label).toEqual({
      decision: "confirmed",
      nameCount: 2,
    });
  });

  it("브랜드 제안 확정은 브랜드 없이 받지 않는다", async () => {
    const { service, queries } = setupAliases();
    await expect(
      service.createAliases(USER, {
        householdId: HOUSEHOLD,
        canonical: "합성상점본점",
        aliases: ["합성상점"],
        reason: "brand_notation",
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queries.some((q) => q.sql.startsWith("insert into"))).toBe(false);
  });

  it("거절은 source가 human_rejected이고 기존 label 형태를 유지한다", async () => {
    const { service, queries } = setup();
    await service.rejectIdentityCandidate(USER, {
      householdId: HOUSEHOLD,
      names: ["합성상점본점", "합성상점"],
      brand: "합성상점",
      reason: "brand_notation",
    });
    const { label, source } = feedbackLabel(queries);
    expect(source).toBe("human_rejected");
    expect(label).toEqual({
      decision: "rejected",
      brand: "합성상점",
      reason: "brand_notation",
      nameCount: 2,
    });
  });
});
