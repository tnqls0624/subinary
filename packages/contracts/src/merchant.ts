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

/**
 * 브랜드/지점 구조로 찾은 병합 후보 하나.
 *
 * **서버가 계산해서 내려준다.** 절단 후보(`findTruncationCandidates`)는 화면이
 * 목록 데이터만으로 계산하는데 이쪽은 서버에 두는 이유가 하나 있다: 사용자가
 * 거절한 후보를 걸러야 하고, 거절 기록의 신원은 `createMerchantIdentityTargetId`
 * 해시다(feedback 계보에 가맹점 원문을 남기지 않기 위해). 그 해시는 `node:crypto`로
 * 만들어 브라우저에서 같은 값을 재현할 수 없다 — 재현하려 들면 직렬화가 어긋났을 때
 * "거절했는데 또 뜬다"로만 드러나는 버그가 된다.
 *
 * 그래서 해시를 가진 쪽에서 걸러 내려준다.
 */
export const merchantIdentityCandidateSchema = z.object({
  /** 사전이 확정한 브랜드(집계 축과 같은 이름). */
  brand: z.string(),
  /** 왜 후보인가. 화면이 문구와 신뢰도 표현을 이것으로 가른다. */
  reason: z.enum(['brand_notation', 'brand_branch_prefix']),
  canonical: z.string(),
  aliases: z.array(z.string()),
  /** 묶었을 때 합쳐지는 거래 건수·순지출. 확정 전 미리보기다. */
  transactionCount: z.number().int(),
  netTotal: z.number().int(),
  /**
   * 판정 근거 — 각 이름을 어떻게 읽었는지(브랜드 토큰 원문 + 지점).
   * 근거 없는 제안은 사용자가 검증할 수 없다.
   */
  evidence: z.array(
    z.object({
      name: z.string(),
      matchedToken: z.string(),
      branch: z.string(),
    }),
  ),
});
export type MerchantIdentityCandidate = z.infer<
  typeof merchantIdentityCandidateSchema
>;

/** `GET /v1/merchants` */
export const merchantListResponseSchema = z.object({
  items: z.array(merchantSummarySchema),
  /**
   * 브랜드/지점 구조로 찾은 병합 후보. 사용자가 거절한 묶음은 **이미 빠져 있다.**
   *
   * 빈 배열은 "제안할 것이 없다"이고 정상이다 — 실측에서 이 값은 2묶음이다.
   */
  identityCandidates: z.array(merchantIdentityCandidateSchema),
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

/**
 * `POST /v1/merchants/identity-feedback` — 병합 후보에 대한 사람의 판단을 남긴다.
 *
 * **거절만 이 경로로 온다.** 확정은 `POST /v1/merchants/aliases`가 이미 사실을
 * 만들고(별칭 + 거래 백필), 서버가 그 안에서 feedback도 함께 남긴다 — 확정을
 * 두 번 호출하게 만들면 하나가 실패했을 때 상태가 갈린다.
 *
 * `names`는 묶음 전체(대표 포함)다. 대표를 따로 받지 않는 이유: "이 이름들은 같은
 * 가게가 아니다"라는 판단은 어느 것을 대표로 삼든 유효하다.
 *
 * `brand`·`reason`은 제안이 **무엇을 근거로** 올라왔는지를 남긴다. 정밀도를 유형별로
 * 볼 수 있어야 어느 규칙이 틀리는지 말할 수 있다 — 전체 정밀도 하나로는
 * "표기 차이는 잘 맞고 지점 절단이 틀린다"를 구분할 수 없다.
 */
export const merchantIdentityRejectRequestSchema = z.object({
  householdId: z.string().uuid(),
  names: z.array(z.string().trim().min(1).max(200)).min(2).max(50),
  brand: z.string().trim().min(1).max(100),
  reason: z.enum(['brand_notation', 'brand_branch_prefix']),
});
export type MerchantIdentityRejectRequest = z.infer<
  typeof merchantIdentityRejectRequestSchema
>;

export const merchantIdentityRejectResponseSchema = z.object({
  /** 저장된 target id. 화면이 즉시 이 후보를 지울 수 있다. */
  targetId: z.string(),
});
export type MerchantIdentityRejectResponse = z.infer<
  typeof merchantIdentityRejectResponseSchema
>;
