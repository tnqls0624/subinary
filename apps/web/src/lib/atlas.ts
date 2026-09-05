/* ---------------------------------------------------------------------------
 * 가맹점 도감 — 방문한 곳을 수집물로 본다
 *
 * ## 왜 이게 성립하나
 *
 * "여기에 갔다"는 **관측된 사실**이다. 등급도 점수도 매기지 않고 방문 자체만 세면
 * 이 저장소의 원칙을 하나도 건드리지 않는다. 게임적 재미는 판정이 아니라 **수집**에서
 * 나온다 — 새로 발견한 곳, 단골이 된 곳, 아직 이름이 정리되지 않은 곳.
 *
 * ## 정리 작업이 곧 게임 목표다
 *
 * 카드사가 잘라 보낸 이름(`도동터미`)과 표기가 갈린 이름(`지에스25 영등포도림` ↔
 * `GS25영등포도림`)은 **미완성 카드**로 보인다. 사용자가 병합하면 카드가 완성된다.
 * 어제 만든 병합 제안(`identityCandidates`)이 그대로 퀘스트가 된다.
 *
 * 이 연결이 이 화면의 값이다 — 가맹점 정리는 유용하지만 지루한 작업이고, 실측에서
 * 도구가 있어도 거의 쓰이지 않았다(별칭 10건 vs 카테고리 규칙 109건). 수집물이
 * 완성되는 형태로 보이면 같은 작업의 동기가 달라진다.
 *
 * ## 하지 않는 것
 *
 * 방문 횟수로 등급을 매기지 않는다("골드 단골" 같은 것). 3회를 단골로 부르는 것도
 * 임의 기준이라, 화면은 **"3회 이상"이라고 그대로 적는다** — 이름표가 아니라 조건을
 * 보여주면 사용자가 기준을 알고 읽는다.
 * ------------------------------------------------------------------------- */
import { extractMerchantIdentity } from "@family/shared";

/** 도감 계산에 필요한 가맹점의 최소 형태(`MerchantSummary`의 부분집합). */
export interface AtlasMerchant {
  name: string;
  transactionCount: number;
  netTotal: number;
  firstTransactionAt: string | null;
  aliasOf: string | null;
}

/**
 * 단골로 세는 최소 방문 횟수.
 *
 * 3인 이유는 정기 지출 판별과 같다 — 2회는 간격이 하나뿐이라 "또 갔다"와 "우연히
 * 두 번"을 가를 수 없다. 값을 바꾸면 화면 문구("3회 이상")도 함께 바꾼다.
 */
export const REGULAR_MIN_VISITS = 3;

export interface AtlasSummary {
  /** 발견한 가맹점 수(별칭으로 묶인 이름은 대표 하나로 센다). */
  discovered: number;
  /** {@link REGULAR_MIN_VISITS} 이상 방문한 곳. */
  regulars: number;
  /** 방문이 한 번뿐인 곳. */
  onceOnly: number;
}

/** 별칭 행을 뺀 목록 — 도감의 모든 계산이 이 위에서 이뤄진다. */
function collectible(items: readonly AtlasMerchant[]): AtlasMerchant[] {
  // 별칭은 대표에 이미 합산돼 있다(서버가 거래를 대표 이름으로 백필한다).
  // 여기서 또 세면 "발견한 곳"이 실제보다 많아진다.
  return items.filter((m) => m.aliasOf === null && m.transactionCount > 0);
}

export function summarizeAtlas(items: readonly AtlasMerchant[]): AtlasSummary {
  const pool = collectible(items);
  return {
    discovered: pool.length,
    regulars: pool.filter((m) => m.transactionCount >= REGULAR_MIN_VISITS).length,
    onceOnly: pool.filter((m) => m.transactionCount === 1).length,
  };
}

/**
 * `monthKey`(`YYYY-MM`)에 **처음 방문한** 곳들. 최근 발견 순.
 *
 * 첫 방문 기준인 이유: 마지막 방문으로 세면 지난달부터 다니던 단골이 전부 "이번 달
 * 새 발견"이 된다.
 */
export function newlyDiscovered(
  items: readonly AtlasMerchant[],
  monthKey: string,
): AtlasMerchant[] {
  return collectible(items)
    .filter((m) => (m.firstTransactionAt ?? "").slice(0, 7) === monthKey)
    .sort((a, b) =>
      (b.firstTransactionAt ?? "").localeCompare(a.firstTransactionAt ?? ""),
    );
}

/** 단골 — 방문 많은 순. */
export function regularMerchants(
  items: readonly AtlasMerchant[],
): AtlasMerchant[] {
  return collectible(items)
    .filter((m) => m.transactionCount >= REGULAR_MIN_VISITS)
    .sort(
      (a, b) =>
        b.transactionCount - a.transactionCount ||
        b.netTotal - a.netTotal ||
        a.name.localeCompare(b.name),
    );
}

/** 브랜드 배지 하나 — 같은 브랜드로 묶인 이름들. */
export interface AtlasBrand {
  brand: string;
  nameCount: number;
  visitCount: number;
  netTotal: number;
  names: string[];
}

/**
 * 브랜드 배지 목록.
 *
 * `rollupByMerchantBrand`를 쓰지 않고 여기서 다시 세는 이유: 저쪽은 이름 수가
 * **2개 이상**인 브랜드만 화면에 띄우는 것을 전제로 만들어졌고(가맹점 정리 화면),
 * 도감에서는 이름이 하나뿐인 브랜드도 배지로서 값이 있다(세븐일레븐 11회).
 * 같은 사전(`extractMerchantIdentity`)을 쓰므로 판정은 어긋나지 않는다.
 */
export function atlasBrands(items: readonly AtlasMerchant[]): AtlasBrand[] {
  const acc = new Map<string, AtlasBrand>();
  for (const m of collectible(items)) {
    const { brand } = extractMerchantIdentity(m.name);
    if (brand === null) continue;
    const bucket = acc.get(brand) ?? {
      brand,
      nameCount: 0,
      visitCount: 0,
      netTotal: 0,
      names: [],
    };
    bucket.nameCount += 1;
    bucket.visitCount += m.transactionCount;
    bucket.netTotal += m.netTotal;
    bucket.names.push(m.name);
    acc.set(brand, bucket);
  }
  return [...acc.values()].sort(
    (a, b) => b.visitCount - a.visitCount || a.brand.localeCompare(b.brand),
  );
}
