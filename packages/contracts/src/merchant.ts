import { z } from 'zod';

/**
 * 가맹점 아이덴티티 계약 — `merchant_aliases`(사용자가 확정한 "같은 가게" 판단).
 *
 * `normalizeMerchant`는 결정적 규칙만 적용하므로 로마자↔한글 음차(`GS25` vs
 * `지에스25`)나 카드사가 잘라 보낸 이름(`주식회사우아한형` vs `우아한형제들`)을
 * 합칠 수 없다. 그 판단은 사람만 할 수 있고, 한 번 하면 재사용돼야 한다.
 */

/** 가맹점 목록 한 항목 — 거래 집계 + 별칭·카테고리 상태. */
export const merchantSummarySchema = z.object({
  /** 정규화된 가맹점 키(= `card_transactions.merchant_normalized`). */
  name: z.string(),
  /** 집계 대상(승인·미제외) 거래 건수. */
  transactionCount: z.number().int(),
  /** 순지출 합계(KRW minor units = 원). */
  netTotal: z.number().int(),
  /** 마지막 승인 시각. 거래가 없으면 null(별칭만 등록된 이름). */
  lastTransactionAt: z.string().nullable(),
  /** 이 이름이 별칭이면 대표 이름, 아니면 null. */
  aliasOf: z.string().nullable(),
  /**
   * 이 이름이 별칭일 때 그 `merchant_aliases` 행 id — 해제(DELETE)에 필요하다.
   * 별칭이 아니면 null.
   */
  aliasId: z.string().nullable(),
  /** 이 이름을 대표로 삼는 별칭들(대표 이름 행에만 채워진다). */
  aliases: z.array(z.string()),
  /** 현재 연결된 카테고리 규칙(`merchant_category_rules`) 기준. */
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
});
export type MerchantSummary = z.infer<typeof merchantSummarySchema>;

/** `GET /v1/merchants` */
export const merchantListResponseSchema = z.object({
  items: z.array(merchantSummarySchema),
});
export type MerchantListResponse = z.infer<typeof merchantListResponseSchema>;

/**
 * `POST /v1/merchants/aliases` — "이 이름들은 전부 canonical과 같은 가게다".
 *
 * 등록은 멱등이며 기존 거래·규칙을 대표 이름으로 백필한다. `aliases`에 canonical과
 * 같은 값이 섞여 오면 서버가 조용히 버린다(자기참조 금지 — DB check와 이중 방어).
 */
export const merchantAliasCreateRequestSchema = z.object({
  householdId: z.string().uuid(),
  canonical: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});
export type MerchantAliasCreateRequest = z.infer<
  typeof merchantAliasCreateRequestSchema
>;

export const merchantAliasSummarySchema = z.object({
  id: z.string(),
  alias: z.string(),
  canonical: z.string(),
  createdAt: z.string(),
});
export type MerchantAliasSummary = z.infer<typeof merchantAliasSummarySchema>;

export const merchantAliasCreateResponseSchema = z.object({
  canonical: z.string(),
  created: z.array(merchantAliasSummarySchema),
  /** 대표 이름으로 옮겨진 거래 수. */
  transactionsUpdated: z.number().int(),
  /** 대표 이름으로 병합되며 삭제된 중복 카테고리 규칙 수. */
  rulesMerged: z.number().int(),
});
export type MerchantAliasCreateResponse = z.infer<
  typeof merchantAliasCreateResponseSchema
>;

/**
 * `DELETE /v1/merchants/aliases/:id` — 별칭 해제.
 * 해당 별칭으로 묶여 있던 거래는 원문(`merchant_raw`) 재정규화 값으로 되돌린다.
 */
export const merchantAliasDeleteResponseSchema = z.object({
  id: z.string(),
  alias: z.string(),
  canonical: z.string(),
  transactionsReverted: z.number().int(),
});
export type MerchantAliasDeleteResponse = z.infer<
  typeof merchantAliasDeleteResponseSchema
>;
