import { describe, expect, it } from "vitest";

import {
  merchantLabelCandidateListResponseSchema,
  merchantLabelCandidateSchema,
  merchantLabelTrainingReadinessSchema,
} from "@family/contracts";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

describe("merchant label candidate contract", () => {
  it("미분류 가맹점과 AI 추천 가맹점을 구분해 허용한다", () => {
    const unlabeled = merchantLabelCandidateSchema.parse({
      representativeTransactionId: TRANSACTION_ID,
      merchantNormalized: "스타벅스 강남점",
      transactionCount: 2,
      latestTransactionAt: "2026-07-19T05:00:00.000Z",
      source: "unlabeled",
      suggestedCategoryId: null,
      suggestedCategorySlug: null,
    });
    const predicted = merchantLabelCandidateSchema.parse({
      ...unlabeled,
      source: "model_prediction",
      suggestedCategoryId: CATEGORY_ID,
      suggestedCategorySlug: "food",
    });

    expect(unlabeled.source).toBe("unlabeled");
    expect(predicted.suggestedCategoryId).toBe(CATEGORY_ID);
  });

  it("빈 가맹점, 0건 집계와 알 수 없는 source를 거부한다", () => {
    const invalidBase = {
      representativeTransactionId: TRANSACTION_ID,
      merchantNormalized: "",
      transactionCount: 0,
      latestTransactionAt: "2026-07-19T05:00:00.000Z",
      source: "automatic",
      suggestedCategoryId: null,
      suggestedCategorySlug: null,
    };

    expect(merchantLabelCandidateSchema.safeParse(invalidBase).success).toBe(
      false,
    );
  });

  it("batch 응답의 hasMore와 라벨 준비도를 검증한다", () => {
    const trainingReadiness = {
      humanConfirmedLabels: 1,
      requiredLabels: 100,
      distinctClasses: 1,
      requiredClasses: 3,
      minimumClassLabels: 1,
      requiredLabelsPerClass: 10,
      missingLineage: 0,
      status: "collect_labels" as const,
    };
    expect(
      merchantLabelCandidateListResponseSchema.parse({
        items: [],
        hasMore: false,
        trainingReadiness,
      }),
    ).toEqual({ items: [], hasMore: false, trainingReadiness });
  });

  it("음수 준비도와 알 수 없는 상태를 거부한다", () => {
    expect(
      merchantLabelTrainingReadinessSchema.safeParse({
        humanConfirmedLabels: -1,
        requiredLabels: 100,
        distinctClasses: 1,
        requiredClasses: 3,
        minimumClassLabels: 1,
        requiredLabelsPerClass: 10,
        missingLineage: 0,
        status: "pending",
      }).success,
    ).toBe(false);
  });
});
