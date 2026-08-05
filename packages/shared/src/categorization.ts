/**
 * Category domain logic — Phase 4 spec §3 (PRD §15, keyword tier only).
 *
 * Pure, dependency-free (no pino/db/network) so both the api (`@family/shared`)
 * and the worker promotion pipeline can share exactly one implementation. The
 * keyword tier is priority #3 in the category resolution order
 * (user override -> household merchant rule -> keyword -> unclassified);
 * LLM classification (#5) is out of scope until Phase 7+.
 *
 * Design notes:
 * - Slugs here are the *system* category slugs seeded into `expense_categories`
 *   (`DEFAULT_CATEGORIES`). {@link categorizeByKeyword} only ever returns one of
 *   these slugs, or `null` when nothing matches (leaving the transaction
 *   unclassified — the promotion pipeline never invents a category).
 * - {@link normalizeMerchant} is deterministic: the same raw merchant string
 *   always yields the same output, which is what makes the household
 *   `merchant_category_rules` exact-match key stable across re-promotions.
 * - Matching is substring-based, so it tolerates the branch suffix the card
 *   parser leaves on `merchantRaw` (e.g. `스타벅스강남점` still resolves to `cafe`).
 * - No lower-casing of Korean text; ASCII is compared case-insensitively.
 */

/** A system expense category definition (slug + Korean display name). */
export interface CategoryDef {
  slug: string;
  name: string;
  /**
   * 소비가 아니라 자산 이동(현금 인출·선불 충전)인 카테고리.
   * `expense_categories.is_transfer`로 시드되고, 지출 집계에서 제외된다.
   */
  isTransfer?: boolean;
}

/** A single keyword -> system-category-slug rule. */
export interface CategoryKeywordRule {
  keyword: string;
  slug: string;
}

/**
 * System default categories seeded with `householdId = null`
 * (Phase 4 spec §3 / §5.2 `category-seed.service`). Order is display order.
 */
export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { slug: 'food', name: '식비' },
  { slug: 'cafe', name: '카페' },
  { slug: 'delivery', name: '배달' },
  { slug: 'transport', name: '교통' },
  { slug: 'fuel', name: '주유' },
  { slug: 'shopping', name: '쇼핑' },
  { slug: 'grocery', name: '장보기' },
  { slug: 'medical', name: '의료' },
  { slug: 'telecom', name: '통신' },
  { slug: 'subscription', name: '구독' },
  { slug: 'etc', name: '기타' },
  // 소비가 아닌 자산 이동. 지출 집계에서 빠지되 이력은 남는다(PRD §15 확장).
  { slug: 'transfer', name: '자산이동', isTransfer: true },
];

/**
 * Korean merchant keyword rules, evaluated top-to-bottom; the first substring
 * match wins. Ordering is significant: more specific / compound keywords must
 * precede shorter ones they contain (e.g. `쿠팡이츠` -> delivery is listed before
 * `쿠팡` -> shopping; `노브랜드버거` -> food before `노브랜드` -> grocery).
 *
 * Payment aggregators (네이버페이/카카오페이/토스페이/KG이니시스) are intentionally
 * absent: when only an aggregator is known the transaction stays unclassified
 * (Phase 4 spec §1.3, PRD §15 — never fabricate a merchant/category).
 */
export const CATEGORY_KEYWORD_RULES: CategoryKeywordRule[] = [
  // transfer (자산 이동 — 소비가 아니라 현금/잔액 이동)
  //
  // 맨 앞에 두는 이유: 실측 `모바일티머니선불`(30,000원 × 2)이 `티머니` 키워드에 걸려
  // 교통비로 계상됐다. 충전은 쓴 게 아니라 옮긴 것이고, 그 잔액을 실제로 쓸 때 다시
  // 잡히면 이중 계상이 된다.
  //
  // `충전소`(전기차·수소)는 실제 소비이므로 transfer보다 **먼저** 걸러낸다.
  { keyword: '충전소', slug: 'transport' },
  { keyword: 'atm', slug: 'transfer' },
  { keyword: '현금서비스', slug: 'transfer' },
  { keyword: '선불', slug: 'transfer' },
  { keyword: '충전', slug: 'transfer' },

  // cafe
  { keyword: '스타벅스', slug: 'cafe' },
  { keyword: 'starbucks', slug: 'cafe' },
  { keyword: '투썸플레이스', slug: 'cafe' },
  { keyword: '투썸', slug: 'cafe' },
  { keyword: '이디야', slug: 'cafe' },
  { keyword: '빽다방', slug: 'cafe' },
  { keyword: '메가커피', slug: 'cafe' },
  { keyword: '메가엠지씨', slug: 'cafe' },
  { keyword: '컴포즈커피', slug: 'cafe' },
  { keyword: '컴포즈', slug: 'cafe' },
  { keyword: '폴바셋', slug: 'cafe' },
  { keyword: '할리스', slug: 'cafe' },
  { keyword: '엔제리너스', slug: 'cafe' },
  { keyword: '공차', slug: 'cafe' },
  { keyword: '커피', slug: 'cafe' },
  { keyword: '카페', slug: 'cafe' },

  // delivery (must precede shopping for 쿠팡이츠 vs 쿠팡)
  { keyword: '배달의민족', slug: 'delivery' },
  { keyword: '배민', slug: 'delivery' },
  { keyword: '쿠팡이츠', slug: 'delivery' },
  { keyword: '요기요', slug: 'delivery' },
  { keyword: '땡겨요', slug: 'delivery' },
  { keyword: '배달', slug: 'delivery' },

  // fuel
  { keyword: 'gs칼텍스', slug: 'fuel' },
  { keyword: 's-oil', slug: 'fuel' },
  { keyword: '에쓰오일', slug: 'fuel' },
  { keyword: 'sk에너지', slug: 'fuel' },
  { keyword: '현대오일뱅크', slug: 'fuel' },
  { keyword: '오일뱅크', slug: 'fuel' },
  { keyword: '알뜰주유', slug: 'fuel' },
  { keyword: '셀프주유', slug: 'fuel' },
  { keyword: '주유소', slug: 'fuel' },
  { keyword: '주유', slug: 'fuel' },

  // transport (must precede telecom for KTX vs KT)
  { keyword: '지하철', slug: 'transport' },
  { keyword: '도시철도', slug: 'transport' },
  { keyword: '코레일', slug: 'transport' },
  { keyword: 'ktx', slug: 'transport' },
  { keyword: 'srt', slug: 'transport' },
  { keyword: '고속버스', slug: 'transport' },
  { keyword: '시외버스', slug: 'transport' },
  { keyword: '버스', slug: 'transport' },
  { keyword: '택시', slug: 'transport' },
  { keyword: '카카오t', slug: 'transport' },
  { keyword: '카카오택시', slug: 'transport' },
  { keyword: '티머니', slug: 'transport' },
  { keyword: '하이패스', slug: 'transport' },
  { keyword: '철도', slug: 'transport' },

  // food (must precede grocery for 노브랜드버거 vs 노브랜드)
  { keyword: '김밥천국', slug: 'food' },
  { keyword: '김밥', slug: 'food' },
  { keyword: '맥도날드', slug: 'food' },
  { keyword: '롯데리아', slug: 'food' },
  { keyword: '버거킹', slug: 'food' },
  { keyword: '맘스터치', slug: 'food' },
  { keyword: '노브랜드버거', slug: 'food' },
  { keyword: 'kfc', slug: 'food' },
  { keyword: '한솥', slug: 'food' },
  { keyword: '본죽', slug: 'food' },
  { keyword: '국밥', slug: 'food' },
  { keyword: '백반', slug: 'food' },
  { keyword: '분식', slug: 'food' },
  { keyword: '식당', slug: 'food' },
  { keyword: '치킨', slug: 'food' },
  { keyword: '피자', slug: 'food' },
  { keyword: '마라탕', slug: 'food' },
  { keyword: '삼겹', slug: 'food' },
  { keyword: '곱창', slug: 'food' },
  { keyword: '냉면', slug: 'food' },
  { keyword: '돈까스', slug: 'food' },

  // grocery
  { keyword: '홈플러스', slug: 'grocery' },
  { keyword: '롯데마트', slug: 'grocery' },
  { keyword: '하나로마트', slug: 'grocery' },
  { keyword: '농협하나로', slug: 'grocery' },
  { keyword: '킴스클럽', slug: 'grocery' },
  { keyword: '코스트코', slug: 'grocery' },
  { keyword: '트레이더스', slug: 'grocery' },
  { keyword: 'gs더프레시', slug: 'grocery' },
  { keyword: '노브랜드', slug: 'grocery' },
  { keyword: '마켓컬리', slug: 'grocery' },
  { keyword: '장보기', slug: 'grocery' },

  // shopping (이마트/쿠팡 per Phase 4 spec §3 example)
  { keyword: '이마트', slug: 'shopping' },
  { keyword: '쿠팡', slug: 'shopping' },
  { keyword: '11번가', slug: 'shopping' },
  { keyword: '지마켓', slug: 'shopping' },
  { keyword: 'g마켓', slug: 'shopping' },
  { keyword: '옥션', slug: 'shopping' },
  { keyword: 'ssg', slug: 'shopping' },
  { keyword: '신세계', slug: 'shopping' },
  { keyword: '롯데백화점', slug: 'shopping' },
  { keyword: '현대백화점', slug: 'shopping' },
  { keyword: '백화점', slug: 'shopping' },
  { keyword: '무신사', slug: 'shopping' },
  { keyword: '올리브영', slug: 'shopping' },
  { keyword: '다이소', slug: 'shopping' },
  { keyword: '위메프', slug: 'shopping' },
  { keyword: '티몬', slug: 'shopping' },

  // medical
  { keyword: '병원', slug: 'medical' },
  { keyword: '의원', slug: 'medical' },
  { keyword: '약국', slug: 'medical' },
  { keyword: '치과', slug: 'medical' },
  { keyword: '한의원', slug: 'medical' },
  { keyword: '의료원', slug: 'medical' },
  { keyword: '클리닉', slug: 'medical' },
  { keyword: '정형외과', slug: 'medical' },
  { keyword: '내과', slug: 'medical' },
  { keyword: '이비인후과', slug: 'medical' },
  { keyword: '피부과', slug: 'medical' },
  { keyword: '안과', slug: 'medical' },
  { keyword: '소아과', slug: 'medical' },
  { keyword: '산부인과', slug: 'medical' },

  // telecom
  { keyword: 'skt', slug: 'telecom' },
  { keyword: 'sk텔레콤', slug: 'telecom' },
  { keyword: 'lg유플러스', slug: 'telecom' },
  { keyword: '유플러스', slug: 'telecom' },
  { keyword: '알뜰폰', slug: 'telecom' },
  { keyword: '헬로모바일', slug: 'telecom' },
  { keyword: '통신요금', slug: 'telecom' },
  { keyword: '통신', slug: 'telecom' },

  // subscription
  { keyword: '넷플릭스', slug: 'subscription' },
  { keyword: 'netflix', slug: 'subscription' },
  { keyword: '유튜브프리미엄', slug: 'subscription' },
  { keyword: '유튜브', slug: 'subscription' },
  { keyword: 'youtube', slug: 'subscription' },
  { keyword: '디즈니플러스', slug: 'subscription' },
  { keyword: '디즈니', slug: 'subscription' },
  { keyword: '왓챠', slug: 'subscription' },
  { keyword: '웨이브', slug: 'subscription' },
  { keyword: 'wavve', slug: 'subscription' },
  { keyword: '티빙', slug: 'subscription' },
  { keyword: 'tving', slug: 'subscription' },
  { keyword: '스포티파이', slug: 'subscription' },
  { keyword: 'spotify', slug: 'subscription' },
  { keyword: '멜론', slug: 'subscription' },
  { keyword: '지니뮤직', slug: 'subscription' },
  { keyword: 'icloud', slug: 'subscription' },
  { keyword: 'chatgpt', slug: 'subscription' },
  { keyword: 'openai', slug: 'subscription' },
];

/** Payment aggregator names — trimmed as a suffix, but kept when standalone. */
const AGGREGATOR_SUFFIX_RE =
  /[\s/·|]+(네이버페이|카카오페이|토스페이|페이코|payco|스마일페이|나이스페이|kg이니시스|이니시스)\s*$/i;

/** Bracketed carrier / channel headers such as `[Web발신]`. */
const BRACKET_RE = /\[[^\]]*\]/g;

/**
 * 소괄호 부가표기 — 결제수단(`쿠팡(쿠페이)`), 영문 병기(`지에스(GS)25`),
 * 법인격(`(주)벤디스`). 카드 문자는 가맹점명을 **자르기** 때문에 닫는 괄호가
 * 없는 형태(`카카오T일반택시(`)도 흔하다 → 닫는 괄호를 optional로 둔다.
 *
 * 전각 괄호도 포함한다(카드사별로 섞여 온다).
 */
const PARENTHETICAL_RE = /[(（][^)）]*[)）]?/g;

/**
 * 법인격 표기. 접두(`주식회사팀오투`)와 접미(`애플코리아유한회사`) 모두 나타나고,
 * 카드 문자 길이 제한에 잘린 꼬리(`유한회`, `주식회`)로도 온다 —
 * 실측된 `애플코리아유한회`가 그 예다. 긴 형태를 먼저 두어 부분 매치를 막는다.
 */
const CORPORATE_FORM_RE = /(주식회사|유한회사|㈜|주식회|유한회)/g;

/** Explicit multi-syllable branch markers. */
const EXPLICIT_BRANCH_RE = /(직영점|본점|지점)$/;

/**
 * Dominant Korean branch pattern: a 2-syllable district qualifier + `점`
 * (e.g. `강남점`, `성수점`). We peel exactly this shape so a substantive brand
 * base survives and generic single-word terms (`편의점`) are preserved.
 */
const DISTRICT_BRANCH_RE = /[가-힣]{2}점$/;

/** Strip a trailing payment-aggregator tag, keeping the aggregator when alone. */
function stripAggregatorSuffix(name: string): string {
  const stripped = name.replace(AGGREGATOR_SUFFIX_RE, '').trim();
  return stripped.length >= 2 ? stripped : name;
}

/**
 * Strip parenthetical annotations, keeping the original when the brand itself was
 * inside the parens (`(쿠페이)` alone must not collapse to an empty key).
 */
function stripParenthetical(name: string): string {
  // 빈 문자열로 치환한다(공백 아님) — 괄호가 이름 **중간**에 삽입된 실측 형태
  // `지에스(GS)25여의캐`에서 공백을 넣으면 `지에스 25여의캐`로 갈라지기 때문이다.
  const stripped = name.replace(PARENTHETICAL_RE, '').replace(/\s+/g, ' ').trim();
  return stripped.length >= 2 ? stripped : name;
}

/** Strip corporate-form markers, keeping the original when that was the whole name. */
function stripCorporateForm(name: string): string {
  const stripped = name.replace(CORPORATE_FORM_RE, '').replace(/\s+/g, ' ').trim();
  return stripped.length >= 2 ? stripped : name;
}

/** Strip a trailing store-branch suffix, keeping a >= 2 char brand base. */
function stripBranchSuffix(name: string): string {
  const explicit = name.replace(EXPLICIT_BRANCH_RE, '').trim();
  if (explicit !== name && explicit.length >= 2) return explicit;

  if (DISTRICT_BRANCH_RE.test(name)) {
    const base = name.slice(0, name.length - 3).trim();
    if (base.length >= 2) return base;
  }
  return name;
}

/**
 * Normalize a raw merchant string into a stable exact-match key.
 *
 * Steps: strip bracketed headers -> collapse whitespace -> strip parenthetical
 * annotations -> strip corporate-form markers -> trim aggregator suffix -> trim
 * store-branch suffix. Korean is preserved as-is (no lower-casing).
 * Deterministic: identical input always yields identical output, which is the
 * invariant `merchant_category_rules(householdId, merchantPattern)` relies on
 * across re-promotions.
 *
 * 괄호·법인격 단계가 있는 이유: 이것들이 빠져 있어 같은 브랜드가 여러 키로 쪼개졌고
 * (`쿠팡` vs `쿠팡(쿠페이)`), 그 파편마다 `merchant_category_rules`가 따로 학습돼
 * 사용자가 같은 가맹점을 반복 확정해야 했다. 로마자↔한글 표기 차이(`GS25` vs
 * `지에스25`)는 여기서 다루지 않는다 — 임의 음차 매핑은 결정적으로 만들 수 없어
 * 사용자가 확정하는 별칭(`merchant_aliases`)의 몫이다.
 *
 * Returns an empty string for empty / whitespace-only / non-string input.
 */
export function normalizeMerchant(raw: string): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(BRACKET_RE, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  return stripBranchSuffix(
    stripAggregatorSuffix(stripCorporateForm(stripParenthetical(collapsed))),
  );
}

/**
 * Resolve a merchant string to a system category slug via keyword matching, or
 * `null` when nothing matches. Matching is substring-based and ASCII
 * case-insensitive, so it works on either the raw or normalized merchant
 * (e.g. both `스타벅스강남점` and `스타벅스` resolve to `cafe`).
 */
export function categorizeByKeyword(merchant: string): string | null {
  if (typeof merchant !== 'string') return null;
  const haystack = merchant.toLowerCase();
  if (haystack.trim().length === 0) return null;
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (haystack.includes(rule.keyword.toLowerCase())) return rule.slug;
  }
  return null;
}
