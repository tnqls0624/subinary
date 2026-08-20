/**
 * 카드사가 **잘라 보낸** 가맹점 이름을 찾아 병합 후보로 묶는다.
 *
 * 왜 필요한가: `/more/merchants`의 병합 도구는 잘 동작하는데 거의 쓰이지 않는다
 * (실측 2026-08-20: 별칭 4행 vs 사람이 확정한 카테고리 규칙 85행). 도구가 없어서가
 * 아니라 **무엇을 묶어야 하는지 사용자가 발견할 수 없어서**다. 85개 이름이 알파벳순
 * 목록으로 늘어서 있고, `세븐일레븐중구E`와 `세븐일레븐중구ENA센터`가 서로 세 칸
 * 떨어져 있으면 사람은 그걸 같은 가게로 보지 못한다.
 *
 * 그래서 화면이 대신 찾아 준다. 다만 **묶지는 않는다** — 이 저장소의 규약은
 * "묶음은 사용자 확정의 결과여야 한다"이고(`decline-grouping.test.ts`가 그것을
 * 고정한다), 별칭을 프로그램이 넣으면 그 규약이 깨진다. 여기서 만드는 것은 제안이다.
 *
 * ## 감지 규칙: 엄격한 접두 관계 하나뿐
 *
 * A가 B의 **엄격한 접두**면(원문 그대로, 공백 포함) 둘을 같은 후보 묶음에 넣는다.
 * 카드 문자의 가맹점 필드는 길이 상한에서 뒤가 잘리므로, 절단은 항상 "앞이 **한 글자도
 * 다르지 않고** 뒤가 없는" 모양으로 나타난다. 실측으로 잡히는 5덩어리:
 *
 * | 대표 | 묶이는 이름 | 합계 |
 * |---|---|---|
 * | `우아한형제들` | `우아한형` | 4건 68,895원 |
 * | `카카오T일반택시_0` | `카카오T일반택시` | 4건 44,400원 |
 * | `세븐일레븐중구ENA센터` | `세븐일레븐중구ENA` · `세븐일레븐중구E` | 8건 26,300원 |
 * | `메가엠지씨커피도` | `메가엠지씨커피` | 3건 13,200원 |
 * | `씨유영등포도림` | `씨유영등포` | 2건 10,940원 |
 *
 * ## 일부러 감지하지 않는 것
 *
 * **로마자↔한글 음차**(`GS25영등포도림` vs `지에스25 영등포도림`, 실측 12건 58,850원).
 * 접두 관계가 아니고, 음차 표를 만들면 오병합이 시작된다. 이 저장소는 이미 그것을
 * "규칙으로 합칠 수 없다 — 사람만 아는 판단"으로 결정했다
 * (`apps/web/src/app/(app)/more/merchants/page.tsx` 헤더). 그 결정을 뒤집지 않는다.
 *
 * **브랜드·지점 병합**(`CJCGV` + `CJ CGV온라인예매_문화비`, `지에스25영등포` +
 * `지에스25 영등포도림`, `씨제이올리브영` + `올리브영신도림테크노`). "지점별로 볼
 * 것인가 브랜드별로 볼 것인가"는 제품 결정이고 ADR-0019가 답하지 않는다.
 * {@link comparisonKey}가 공백을 남기기 때문에 이것들이 자연히 걸러진다.
 *
 * 접두 규칙이 오병합을 **완전히** 막지는 못한다 — `씨유영등포`는 `씨유영등포도림`의
 * 접두이지만 영등포의 다른 CU 지점일 수도 있다. 그래서 결과는 언제나 제안이고,
 * 확정은 사람이 한다. 반대 방향(음차)을 포기한 것도 같은 이유다: 제안이 틀리면
 * 사용자가 도구를 신뢰하지 않게 되고, 그러면 4행에서 더 나아가지 못한다.
 */

/** 후보 묶음의 입력 — 화면이 이미 들고 있는 가맹점 목록의 최소 형태. */
export interface TruncationCandidateInput {
  /** 정규화된 가맹점 키(`card_transactions.merchant_normalized`). */
  name: string;
  /** 집계 대상 거래 건수. */
  transactionCount: number;
  /** 순지출 합계(원). */
  netTotal: number;
  /** 이 이름이 이미 별칭이면 대표 이름. 별칭은 후보에서 제외한다. */
  aliasOf: string | null;
}

/** 한 덩어리의 절단 변종 제안. */
export interface TruncationCandidateGroup {
  /**
   * 제안하는 대표 이름 — 묶음에서 **가장 긴** 이름.
   *
   * 지출이 가장 큰 이름이 아니라 가장 긴 이름을 고른다. 절단된 쪽이 더 많이 쌓일 수
   * 있는데(카드사가 계속 자르므로) 그쪽을 대표로 삼으면 정보가 적은 이름이 남는다.
   * 실측: `카카오T일반택시`가 3건 41,400원, `카카오T일반택시_0`이 1건 3,000원이다 —
   * 지출로 고르면 잘린 이름이 대표가 된다.
   */
  canonical: string;
  /** 대표로 묶일 이름들(대표 제외). 항상 1개 이상. */
  aliases: string[];
  /** 묶었을 때 합쳐지는 거래 건수. */
  transactionCount: number;
  /** 묶었을 때 합쳐지는 순지출 합계(원). */
  netTotal: number;
}

/**
 * 비교용 키 — **아무것도 손대지 않는다.** 공백도 이름의 일부다.
 *
 * 처음에 공백을 지웠다가 테스트가 그 규칙의 결함을 잡았다. 절단은 **꼬리를 자르는**
 * 것이므로 접두를 공백까지 그대로 보존한다. 따라서 공백을 지우면 절단이 아닌 것이
 * 절단으로 보인다:
 *
 * - `CJCGV` vs `CJ CGV온라인예매_문화비` — 공백을 지우면 접두가 되지만, 실제 절단이면
 *   짧은 쪽도 `CJ CGV`처럼 공백을 갖고 있어야 한다. 공백이 없다는 것은 카드사가 **다른
 *   형식으로** 보냈다는 뜻이다. 브랜드 병합(제품 결정)이라 제안 대상이 아니다.
 * - `지에스25영등포` vs `지에스25 영등포도림` — 같은 이유. `지에스25 영등포도림`이
 *   잘렸다면 `지에스25 영등포`가 나온다. 공백 없는 쪽은 다른 지점일 수 있고,
 *   지점 병합은 ADR-0019가 답하지 않는 제품 결정이다.
 *
 * 즉 공백을 남기는 것이 편의가 아니라 **더 정확하다**.
 */
function comparisonKey(name: string): string {
  return name;
}

/**
 * 접두 관계로 이어지는 이름들을 한 묶음으로 만든다.
 *
 * 관계는 **이행적으로** 이어 붙인다(`A ⊂ B`, `B ⊂ C`면 `{A, B, C}` 한 묶음).
 * `세븐일레븐중구E` → `ENA` → `ENA센터`가 실제로 그 모양이라, 쌍 단위로 제안하면
 * 사용자가 같은 가게를 두 번 묶어야 한다.
 *
 * 짧은 이름은 절단의 결과이므로 **최소 길이 조건**을 둔다. 2~3자 이름은 접두가 우연히
 * 맞을 확률이 높고(`쿠팡` ⊂ `쿠팡플레이`는 실제로 다른 서비스다) 그런 제안 하나가
 * 도구의 신뢰를 깎는다 — 특히 `쿠팡`은 실측 20건 445,180원으로 가장 큰 가맹점이라,
 * 그것을 2건짜리 `쿠팡플레이`에 묶자는 제안은 무시할 수 있는 소음이 아니라 경고로 읽힌다.
 *
 * 4자로 두는 근거는 실측이다: 걸러야 하는 가장 긴 오탐이 `쿠팡`(2자)이고, 잡아야 하는
 * 가장 짧은 절단이 `우아한형`(4자, `우아한형제들`이 잘린 것)이다.
 */
export const TRUNCATION_MIN_PREFIX_LENGTH = 4;

export function findTruncationCandidates(
  items: readonly TruncationCandidateInput[],
): TruncationCandidateGroup[] {
  // 이미 묶인 별칭 행은 후보가 아니다(대표를 바꾸려면 먼저 해제해야 한다).
  const pool = items.filter((m) => m.aliasOf === null);

  // union-find로 이행적 묶음을 만든다. 이름 수가 100 단위라 단순 구현으로 충분하다.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  for (const m of pool) parent.set(m.name, m.name);

  for (const a of pool) {
    for (const b of pool) {
      if (a.name === b.name) continue;
      const ka = comparisonKey(a.name);
      const kb = comparisonKey(b.name);
      // a가 b의 엄격한 접두인가. 짧은 쪽이 최소 길이를 넘어야 한다.
      if (ka.length < TRUNCATION_MIN_PREFIX_LENGTH) continue;
      if (ka.length >= kb.length) continue;
      if (!kb.startsWith(ka)) continue;
      const ra = find(a.name);
      const rb = find(b.name);
      if (ra !== rb) parent.set(ra, rb);
    }
  }

  const groups = new Map<string, TruncationCandidateInput[]>();
  for (const m of pool) {
    const root = find(m.name);
    const bucket = groups.get(root);
    if (bucket) bucket.push(m);
    else groups.set(root, [m]);
  }

  const result: TruncationCandidateGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // 대표는 가장 긴 이름. 길이가 같으면 지출이 큰 쪽(안정적 정렬용).
    const sorted = [...members].sort((x, y) => {
      const d = comparisonKey(y.name).length - comparisonKey(x.name).length;
      return d !== 0 ? d : y.netTotal - x.netTotal;
    });
    const canonical = sorted[0] as TruncationCandidateInput;
    result.push({
      canonical: canonical.name,
      aliases: sorted.slice(1).map((m) => m.name),
      transactionCount: members.reduce((s, m) => s + m.transactionCount, 0),
      netTotal: members.reduce((s, m) => s + m.netTotal, 0),
    });
  }

  // 큰 덩어리부터 — 사용자가 위에서부터 처리하면 효과가 큰 순서가 된다.
  return result.sort((a, b) => b.netTotal - a.netTotal);
}
