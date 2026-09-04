/**
 * 가맹점 이름을 **브랜드 + 지점**으로 분해하고, 그 구조로 병합 후보를 찾는다.
 *
 * ## 왜 브랜드를 먼저 떼는가
 *
 * `findTruncationCandidates`(절단)는 이름 **전체의 접두 관계** 하나만 본다. 그것으로
 * 잡히는 것은 실측 1묶음뿐이다(2026-09-04: 102개 이름 중 `씨유영등포` ⊂ `씨유영등포도림`).
 * 남은 100개의 문제는 그 규칙이 **일부러 포기한** 영역이다 — 음차(`GS25` ↔ `지에스25`)와
 * 브랜드·지점 병합. 두 결정 모두 `merchant-truncation.ts` 헤더에 근거가 적혀 있고,
 * "제품 결정이라 규칙이 답하지 않는다"가 그 이유였다.
 *
 * 그 제품 결정이 2026-09-04에 내려졌다: **별칭은 매장 단위로 두고, 브랜드는 별도
 * 집계 축으로 만든다.** 매장 병합은 지점을 잃고 되돌리기가 번거로운데, 집계 축은
 * 파생 데이터라 되돌릴 것이 없다.
 *
 * 그래서 이 모듈이 하는 일은 두 가지다.
 *
 * 1. **같은 매장의 표기 차이**를 찾는다(`지에스25 영등포도림` ↔ `GS25영등포도림`).
 *    브랜드가 같고 지점이 같으면 같은 매장이다.
 * 2. **브랜드 축 집계**를 만든다(`GS25` 5개 매장 합계). 이름은 그대로 남는다.
 *
 * ## 유사도를 쓰지 않는 이유 — 실측 함정 세 개
 *
 * 편집거리·임베딩 같은 유사도 하나로는 아래 셋을 **전부 틀린다.** 그래서 브랜드를
 * 사전으로 먼저 확정하고, 유사도는 쓰지 않는다.
 *
 * | 실측 쌍 | 유사도 판정 | 사실 |
 * |---|---|---|
 * | `씨유영등포도림` vs `GS25영등포도림` | 지명이 같아 높다 | **경쟁 브랜드**(CU vs GS25) |
 * | `이마트 신` vs `이마트24 센트럴` | 접두가 겹친다 | **다른 회사**(이마트 vs 이마트24) |
 * | `올리브약국` vs `올리브영신도림테크노` | "올리브"가 겹친다 | 약국과 화장품 매장 |
 *
 * 앞의 둘은 브랜드 토큰을 **최장 일치**로 떼면 갈린다(`이마트24`를 `이마트`로 떼지
 * 않는다). 셋째는 사전에 `올리브`를 넣지 않는 것으로 막는다 — {@link MERCHANT_BRANDS}에
 * 그 금지가 주석으로 고정되어 있고 테스트가 지킨다.
 *
 * ## LLM이 여기 없는 이유
 *
 * 실측 102개 이름에서 브랜드가 필요한 것은 사전 20여 항목으로 전부 덮인다. 규칙이
 * 먼저이고 LLM은 규칙이 못 잡은 것만 본다는 캐스케이드 원칙(L0→L1→L2)에서, 지금
 * 잔량은 LLM을 부를 만큼 크지 않다. **잔량이 실측으로 커지면 그때 붙인다** — 그 자리는
 * {@link extractMerchantIdentity}가 `brand: null`을 돌려주는 지점이고, 붙일 때도
 * LLM은 `{brand, branch}` 구조만 뽑고 병합 여부는 이 파일의 순수 함수가 정한다.
 */

/* -------------------------------------------------------------------------- */
/* 브랜드 사전                                                                  */
/* -------------------------------------------------------------------------- */

/** 사전 한 항목. */
export interface MerchantBrandEntry {
  /**
   * 표준 브랜드 이름. 화면과 집계 축이 쓰는 **하나의** 이름이다.
   * 거래에 이 이름이 존재하지 않아도 된다(파생 축이므로).
   */
  id: string;
  /**
   * 이 브랜드로 인정하는 **접두 토큰**들. 음차·로마자·법인명 변형을 모두 적는다.
   *
   * 매칭은 전 브랜드의 전 토큰을 **길이 내림차순**으로 훑어 첫 일치를 택한다
   * (최장 일치). 그래서 `이마트24`가 `이마트`보다, `쿠팡플레이`가 `쿠팡`보다 먼저
   * 걸린다 — 사전에 적는 순서는 무관하고, 길이가 순서를 정한다.
   */
  tokens: readonly string[];
}

/**
 * 브랜드 사전. **실측 근거가 있는 것만 넣는다.**
 *
 * 넣는 기준은 둘 중 하나다.
 *
 * - 실측에서 **두 개 이상의 이름**이 같은 브랜드로 묶인다(GS25·CU·올리브영·다이소·
 *   맥도날드·CJ CGV).
 * - 이름이 하나여도 **경계를 고정해야 한다**(이마트/이마트24, 쿠팡/쿠팡플레이).
 *   단독 브랜드를 넣는 것은 무해하다 — 짝이 없으면 후보가 생기지 않고, 브랜드 축에
 *   이름 하나가 더 생길 뿐이다. 새 거래가 들어오면 즉시 잡힌다.
 *
 * ⛔ **넣지 말아야 하는 것** (전부 실측에서 오매칭을 만든다. 테스트가 고정한다):
 *
 * - `올리브` — `올리브약국`(1건)이 `올리브영`으로 잡힌다. 약국과 화장품 매장이다.
 * - `홈플러스` — `홈플러스익스프레스`(1건)는 대형마트가 아니라 별도 업태(SSM)다.
 *   묶을 짝도 없어 실익이 0인데 오분류 위험만 남는다.
 * - `카카오` — `카카오`(1건)·`카카오T일반택시`(4건)는 결제 대행과 택시 호출이라
 *   실제 가맹점이 다르다. 결제 대행은 병합 대상이 아니다(지시서 §5).
 */
export const MERCHANT_BRANDS: readonly MerchantBrandEntry[] = [
  // --- 편의점: 실측에서 이름이 가장 많이 갈린 곳 ---------------------------
  // GS25가 6개 이름으로 갈려 있다(영등포도림 2표기 + 여의캐 + 영등포 + S9샛강 + S2신도).
  { id: 'GS25', tokens: ['지에스25', 'GS25'] },
  // GS더프레시는 GS25와 **다른 업태**다(슈퍼마켓). `지에스25`와 접두가 겹치지 않아
  // 최장 일치로 자연히 갈리지만, 사전에 두어 브랜드 축에서도 섞이지 않게 한다.
  { id: 'GS더프레시', tokens: ['지에스더프레시', 'GS더프레시', 'GSTHEFRESH'] },
  { id: 'CU', tokens: ['씨유', 'CU'] },
  { id: '세븐일레븐', tokens: ['세븐일레븐', '7-ELEVEN', '7ELEVEN'] },
  // 이마트24는 이마트와 **다른 회사**다. 최장 일치가 이것을 보장한다.
  { id: '이마트24', tokens: ['이마트24'] },
  { id: '이마트', tokens: ['이마트'] },

  // --- 실측에서 두 이름 이상으로 갈린 브랜드 -------------------------------
  // `씨제이올리브영`(법인명 접두) ↔ `올리브영신도림테크노`(지점). 다른 매장이라
  // 병합되지 않고 브랜드 축에서만 합산된다.
  { id: '올리브영', tokens: ['씨제이올리브영', 'CJ올리브영', '올리브영'] },
  // 어순 차이(`다이소아성산업` ↔ `아성다이소`)는 접두 매칭으로 잡히지 않는다.
  // 두 법인명 표기를 **토큰으로 직접 등록**해 양쪽 지점을 모두 빈 값으로 만든다 —
  // 그러면 "지점 없는 같은 브랜드"로 병합 후보가 된다. 법인격 어휘(`산업` 등)를
  // 일반 규칙으로 지우는 방식은 넓어서 위험하다(`대주산업횡성인천`이 실측에 있다).
  { id: '다이소', tokens: ['다이소아성산업', '아성다이소', '다이소'] },
  { id: '맥도날드', tokens: ['한국맥도날드', '맥도날드'] },
  { id: 'CJ CGV', tokens: ['CJ CGV', 'CJCGV', 'CGV'] },

  // --- 경계 고정용: 접두가 겹치는 다른 서비스 ------------------------------
  // `쿠팡`(27건 504,680원)이 `쿠팡플레이`(3건)에 묶이면 가장 큰 가맹점이 오염된다.
  // 최장 일치로 `쿠팡플레이`가 먼저 걸린다.
  { id: '쿠팡플레이', tokens: ['쿠팡플레이'] },
  { id: '쿠팡', tokens: ['쿠팡', '와우'] },

  // Apple: `애플코리아`(2건 129,000원, 3개월 할부)와 `Apple-엔에이치`(1건 19,500원)가
  // 둘 다 Apple 결제다. 다만 `Apple-엔에이치`의 `엔에이치`가 **지점인지 카드사 표기인지
  // 알 수 없다** — 그래서 `Apple-엔에이치`를 토큰으로 등록하지 않는다. 등록하면 지점이
  // 빈 값이 되어 `애플코리아`와 병합 후보가 되는데, 그 병합의 근거가 없다.
  // 지금 상태에서는 브랜드 축에서만 합산되고 이름은 둘로 남는다(관측된 것만 말한다).
  { id: 'Apple', tokens: ['애플코리아', '애플', 'APPLE'] },

  // --- 단독이지만 고유해서 오매칭 위험이 없는 것 ---------------------------
  { id: '파리바게뜨', tokens: ['파리바게뜨'] },
  { id: '뚜레쥬르', tokens: ['뚜레쥬르'] },
  { id: '메가MGC커피', tokens: ['메가엠지씨커피', '메가MGC커피'] },
  { id: '빽다방', tokens: ['빽다방'] },
  { id: '스타벅스', tokens: ['스타벅스', 'STARBUCKS'] },
  { id: '무신사', tokens: ['무신사'] },
];

/**
 * 사전을 **최장 일치 순서**로 펼친 조회 테이블.
 *
 * 모듈 로드 시 한 번 만든다. 사전 항목이 20여 개이고 호출은 이름 수(100 단위)만큼
 * 일어나므로, 매 호출에 정렬하면 O(n·m log m)이 된다.
 *
 * 정렬 기준이 길이 하나가 아니라 **길이 → 사전순**인 이유: 같은 길이의 토큰이 두
 * 브랜드에 있으면 정렬이 불안정해져 같은 입력이 다른 브랜드로 판정될 수 있다.
 * 결정성은 이 모듈의 DoD다.
 */
const BRAND_LOOKUP: readonly { token: string; brand: string }[] = MERCHANT_BRANDS
  .flatMap((entry) => entry.tokens.map((token) => ({ token, brand: entry.id })))
  .sort((a, b) => b.token.length - a.token.length || a.token.localeCompare(b.token));

/* -------------------------------------------------------------------------- */
/* 구조 추출                                                                    */
/* -------------------------------------------------------------------------- */

/** 이름 하나의 브랜드/지점 분해. */
export interface MerchantIdentity {
  /** 사전이 확정한 브랜드 id. 못 찾으면 `null`(미판정). */
  brand: string | null;
  /**
   * 지점 비교용 키 — 브랜드 토큰을 뗀 나머지를 정규화한 값. 브랜드가 없으면 `''`.
   *
   * 빈 문자열은 "브랜드 이름만 있고 지점 정보가 없다"는 뜻이다(`아성다이소`).
   * 지점을 모르는 것과 지점이 없는 것을 구분하지 않는다 — 둘 다 "이 이름으로는
   * 매장을 특정할 수 없다"이고, 병합 판정에서 같게 취급하는 것이 맞다.
   */
  branch: string;
  /**
   * 실제로 일치한 토큰 **원문**. 근거 표시용이다.
   *
   * 사전 id가 아니라 원문을 남기는 이유: 화면이 "`지에스25`를 GS25로 읽었다"를
   * 보여줄 수 있어야 사용자가 판정을 검증한다. 카드문자 L2 파서가 원문 인용을
   * 남기는 것과 같은 이유다(quote-grounded).
   */
  matchedToken: string | null;
}

/**
 * 지점 비교 키 정규화.
 *
 * 공백·구두점을 지우고 로마자를 대문자로 올린다. 브랜드 토큰을 **이미 뗀 뒤**의
 * 문자열에만 적용한다는 점이 중요하다 — `merchant-truncation.ts`가 공백을 보존하는
 * 이유(전체 이름의 접두 관계에서 공백은 절단 여부의 증거다)와 충돌하지 않는다.
 * 여기서 남은 공백은 브랜드와 지점 사이의 구분자일 뿐이라 지우는 것이 정확하다:
 * `지에스25 영등포도림` → `영등포도림`, `GS25영등포도림` → `영등포도림`.
 */
function normalizeBranch(value: string): string {
  return value.replace(/[\s_.*\-·]/g, '').toUpperCase();
}

/**
 * 이름을 브랜드/지점으로 분해한다. **순수 함수** — 같은 입력이면 항상 같은 출력.
 *
 * 사전에 없는 이름은 `{brand: null, branch: '', matchedToken: null}`이다. 이것은
 * 실패가 아니라 **미판정**이고, 미판정은 병합 후보를 만들지 않는다.
 */
export function extractMerchantIdentity(name: string): MerchantIdentity {
  if (typeof name !== 'string' || name.length === 0) {
    return { brand: null, branch: '', matchedToken: null };
  }
  // 대소문자만 다른 로마자 표기(`GS25` vs `gs25`)를 같게 보되, 잘라내는 위치는
  // **원문 인덱스**로 잡는다. 대문자로 바꾼 문자열에서 자르면 지점 원문이 훼손된다.
  const upper = name.toUpperCase();
  for (const { token, brand } of BRAND_LOOKUP) {
    if (!upper.startsWith(token.toUpperCase())) continue;
    return {
      brand,
      branch: normalizeBranch(name.slice(token.length)),
      matchedToken: name.slice(0, token.length),
    };
  }
  return { brand: null, branch: '', matchedToken: null };
}

/* -------------------------------------------------------------------------- */
/* 병합 후보                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 지점 접두 판정의 최소 길이.
 *
 * `merchant-truncation.ts`의 `TRUNCATION_MIN_PREFIX_LENGTH`(4)와 **다르게** 2로
 * 둔다. 거기서는 이름 전체를 비교하므로 2~3자 이름(`쿠팡`)이 우연히 접두가 될
 * 위험이 컸다. 여기서는 브랜드가 이미 같다는 것이 확인된 뒤라 후보 공간이 훨씬
 * 좁다 — 실측의 `지에스25영등포`(지점 `영등포`, 3자) ⊂ `지에스25 영등포도림`
 * (지점 `영등포도림`)을 잡으려면 4자로는 놓친다.
 *
 * 이 하한에는 의도한 **부수 효과**가 하나 있다: 빈 지점(`''`)은 모든 문자열의 접두라
 * 하한이 없으면 "지점 없는 이름"이 같은 브랜드의 **모든** 지점에 묶인다. 실측에서
 * 그것이 막는 것들이고, 셋 다 막는 것이 맞다:
 *
 * - `한국맥도날드`(지점 없음) ↛ `맥도날드안산고잔` — 다른 매장이다.
 * - `CJCGV`(지점 없음) ↛ `CJ CGV온라인예매_문화비` — 온라인 예매는 매장이 아니다.
 * - `씨제이올리브영`(지점 없음) ↛ `올리브영신도림테크노` — 다른 매장이다.
 *
 * 즉 지점 정보가 없는 이름은 지점이 있는 이름에 흡수되지 않는다. 흡수시키려면 사람이
 * 목록에서 직접 고르면 되고, 그것이 §4-0에서 정한 "매장 단위 별칭"과 맞는다.
 */
export const BRANCH_MIN_PREFIX_LENGTH = 2;

/** 왜 이 이름들이 한 묶음으로 제안되는가. */
export type MerchantMergeReason =
  /** 브랜드가 같고 지점도 같다 — 표기·어순만 다른 **같은 매장**. */
  | 'brand_notation'
  /** 브랜드가 같고 지점이 엄격한 접두 — 지점명이 잘렸을 가능성. */
  | 'brand_branch_prefix';

/** 후보 판정의 입력. 화면이 이미 들고 있는 목록의 최소 형태. */
export interface MerchantIdentityInput {
  name: string;
  transactionCount: number;
  netTotal: number;
  /** 이미 별칭이면 대표 이름. 별칭은 후보에서 제외한다. */
  aliasOf: string | null;
}

/** 한 묶음의 병합 후보. */
export interface MerchantIdentityCandidateGroup {
  brand: string;
  reason: MerchantMergeReason;
  /** 제안하는 대표 이름. */
  canonical: string;
  /** 대표로 묶일 이름들(대표 제외). 항상 1개 이상. */
  aliases: string[];
  transactionCount: number;
  netTotal: number;
  /**
   * 판정 근거 — 각 이름을 어떻게 읽었는지. 화면이 이것을 그대로 보여준다.
   *
   * 근거 없이 "묶으세요"만 내보내면 사용자가 검증할 방법이 없고, 한 번 틀린 제안이
   * 도구 신뢰를 깎는다(`merchant-truncation.ts`가 같은 판단을 기록했다).
   */
  evidence: readonly { name: string; matchedToken: string; branch: string }[];
}

/**
 * 브랜드/지점 구조로 병합 후보를 찾는다.
 *
 * **브랜드가 다르면 절대 후보가 되지 않는다** — 지점명이 같아도(`씨유영등포도림` vs
 * `GS25영등포도림`) 다르게 남는다. 이것이 이 모듈의 첫 DoD다.
 *
 * 절단(`findTruncationCandidates`)과 **겹치지 않는다**: 저쪽은 이름 전체의 접두
 * 관계를, 이쪽은 브랜드를 뗀 뒤의 지점을 본다. 실측에서 겹치는 유일한 쌍
 * (`씨유영등포` ⊂ `씨유영등포도림`)은 양쪽에서 잡히므로, 화면은 절단 제안을 먼저
 * 두고 여기서 나온 같은 묶음을 걸러야 한다(`excludeNames`).
 */
export function findMerchantIdentityCandidates(
  items: readonly MerchantIdentityInput[],
  options: {
    /**
     * 이미 다른 제안이 다루는 이름들. 같은 묶음이 두 블록에 나오면 사용자가 같은
     * 가게를 두 번 처리하게 된다.
     */
    excludeNames?: ReadonlySet<string>;
  } = {},
): MerchantIdentityCandidateGroup[] {
  const exclude = options.excludeNames ?? new Set<string>();
  const pool = items
    .filter((m) => m.aliasOf === null && !exclude.has(m.name))
    .map((m) => ({ ...m, identity: extractMerchantIdentity(m.name) }))
    // 미판정(브랜드 없음)은 후보를 만들지 않는다.
    .filter((m) => m.identity.brand !== null);

  const byBrandBranch = new Map<string, typeof pool>();
  for (const m of pool) {
    // 브랜드를 key에 넣는 것이 §1-E 방어의 전부다. 지점만으로 묶으면 CU와 GS25의
    // `영등포도림`이 한 묶음이 된다.
    const key = `${m.identity.brand as string} ${m.identity.branch}`;
    const bucket = byBrandBranch.get(key);
    if (bucket) bucket.push(m);
    else byBrandBranch.set(key, [m]);
  }

  const groups: MerchantIdentityCandidateGroup[] = [];
  const claimed = new Set<string>();

  // 1) 브랜드·지점이 완전히 같은 것 — 같은 매장의 표기 차이.
  for (const members of byBrandBranch.values()) {
    if (members.length < 2) continue;
    // 대표는 지출이 큰 이름. 절단 모듈은 "가장 긴 이름"을 골랐는데(잘린 쪽이 더
    // 쌓이므로 정보가 적은 이름이 대표가 되는 것을 막으려고), 여기서는 지점이
    // **이미 같다**고 확인된 뒤라 길이가 정보량을 뜻하지 않는다. 실측
    // `지에스25 영등포도림`(11건)과 `GS25영등포도림`(7건)에서 앞의 것이 대표가 된다.
    const sorted = [...members].sort(
      (a, b) => b.netTotal - a.netTotal || a.name.localeCompare(b.name),
    );
    const canonical = sorted[0] as (typeof sorted)[number];
    for (const m of members) claimed.add(m.name);
    groups.push({
      brand: canonical.identity.brand as string,
      reason: 'brand_notation',
      canonical: canonical.name,
      aliases: sorted.slice(1).map((m) => m.name),
      transactionCount: members.reduce((s, m) => s + m.transactionCount, 0),
      netTotal: members.reduce((s, m) => s + m.netTotal, 0),
      evidence: sorted.map((m) => ({
        name: m.name,
        matchedToken: m.identity.matchedToken as string,
        branch: m.identity.branch,
      })),
    });
  }

  // 2) 브랜드가 같고 지점이 엄격한 접두 — 지점명 절단 가능성.
  //
  // 1)에서 이미 묶인 이름은 건너뛴다. 표기 차이가 확정 사실에 더 가깝고, 같은
  // 이름이 두 제안에 나오면 사용자가 두 번 처리한다.
  //
  // 그래서 제안은 **단계적으로** 드러난다. 실측이 그 모양이다: `지에스25영등포`(지점
  // `영등포`)는 `지에스25 영등포도림`의 절단일 수 있는데, 첫 라운드에서는 그 대표가
  // 표기 차이 묶음(`GS25영등포도림`과의 병합)에 이미 쓰여 후보로 나오지 않는다.
  // 사용자가 그 확실한 병합을 확정하면 별칭 쪽이 pool에서 빠지고, 다음 렌더에서 절단
  // 후보가 나타난다. 확실한 판단을 먼저 처리하고 추측성 판단이 뒤따르는 순서다 —
  // 둘을 한 번에 보여주면 사용자가 어느 쪽을 믿어야 할지 알 수 없다.
  const rest = pool.filter((m) => !claimed.has(m.name));
  for (const short of rest) {
    if (short.identity.branch.length < BRANCH_MIN_PREFIX_LENGTH) continue;
    for (const long of rest) {
      if (short.name === long.name) continue;
      if (short.identity.brand !== long.identity.brand) continue;
      if (short.identity.branch.length >= long.identity.branch.length) continue;
      if (!long.identity.branch.startsWith(short.identity.branch)) continue;
      // 대표는 **긴 쪽**이다. 절단이 의심되는 상황에서는 정보가 많은 이름을 남긴다
      // (절단 모듈과 같은 판단).
      groups.push({
        brand: long.identity.brand as string,
        reason: 'brand_branch_prefix',
        canonical: long.name,
        aliases: [short.name],
        transactionCount: short.transactionCount + long.transactionCount,
        netTotal: short.netTotal + long.netTotal,
        evidence: [long, short].map((m) => ({
          name: m.name,
          matchedToken: m.identity.matchedToken as string,
          branch: m.identity.branch,
        })),
      });
    }
  }

  // 큰 덩어리부터 — 위에서부터 처리하면 효과가 큰 순서가 된다.
  return groups.sort(
    (a, b) => b.netTotal - a.netTotal || a.canonical.localeCompare(b.canonical),
  );
}

/* -------------------------------------------------------------------------- */
/* 브랜드 집계 축                                                               */
/* -------------------------------------------------------------------------- */

/** 브랜드 하나의 합계. */
export interface MerchantBrandRollup {
  brand: string;
  /** 이 브랜드로 잡힌 **서로 다른 이름** 수. 매장 수의 하한이다. */
  storeCount: number;
  transactionCount: number;
  netTotal: number;
  /** 묶인 이름들(지출 큰 순). 사용자가 무엇이 합산됐는지 펼쳐 볼 수 있어야 한다. */
  names: readonly string[];
}

/**
 * 브랜드 축 집계. **이름을 바꾸지 않는다** — 파생 데이터다.
 *
 * 이것이 §4-0의 채택안이다: 매장 이름은 그대로 두고 브랜드 합계를 축으로 더한다.
 * 병합이 아니므로 되돌릴 것이 없고, 지점별 소비도 그대로 보인다.
 *
 * `storeCount`를 "매장 수"라 부르지 않고 **서로 다른 이름 수**로 세는 이유: 표기가
 * 갈린 같은 매장이 아직 병합되지 않았으면 두 개로 세어진다(실측 `지에스25 영등포도림`
 * + `GS25영등포도림`). 실제 매장 수보다 크게 나올 수 있고, 그것을 "매장 5곳"이라
 * 단정하면 관측하지 않은 사실을 말하는 것이 된다. 화면은 `names`를 함께 보여
 * 사용자가 직접 판단할 수 있어야 한다.
 *
 * 브랜드를 못 찾은 이름(`brand: null`)은 **집계에 넣지 않는다.** 미판정을 "기타"로
 * 묶으면 그 안에서 아무 사실도 읽을 수 없는 큰 덩어리가 생긴다.
 */
export function rollupByMerchantBrand(
  items: readonly MerchantIdentityInput[],
): MerchantBrandRollup[] {
  const acc = new Map<
    string,
    { transactionCount: number; netTotal: number; names: { name: string; netTotal: number }[] }
  >();
  for (const m of items) {
    // 별칭 행은 대표 쪽에 이미 합산돼 있다(서버가 거래를 대표 이름으로 백필한다).
    // 여기서 또 세면 이중 계상이다.
    if (m.aliasOf !== null) continue;
    const { brand } = extractMerchantIdentity(m.name);
    if (brand === null) continue;
    const bucket = acc.get(brand) ?? { transactionCount: 0, netTotal: 0, names: [] };
    bucket.transactionCount += m.transactionCount;
    bucket.netTotal += m.netTotal;
    bucket.names.push({ name: m.name, netTotal: m.netTotal });
    acc.set(brand, bucket);
  }
  return [...acc.entries()]
    .map(([brand, v]) => ({
      brand,
      storeCount: v.names.length,
      transactionCount: v.transactionCount,
      netTotal: v.netTotal,
      names: v.names
        .sort((a, b) => b.netTotal - a.netTotal || a.name.localeCompare(b.name))
        .map((n) => n.name),
    }))
    .sort((a, b) => b.netTotal - a.netTotal || a.brand.localeCompare(b.brand));
}
