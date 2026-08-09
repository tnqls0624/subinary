/**
 * 재계산 시 **기존 series와 새 후보를 잇는 규칙** — 순수 · 결정적 (C-5).
 *
 * 왜 필요한가: 미확정 후보는 폐기·재생성 가능한 projection이지만, 사용자가 "정기 결제
 * 맞음/아님"을 판단한 series는 **조용히 지우면 안 된다**(PO 판정 Q1-4). 그렇다고
 * 가맹점 문자열이나 금액으로 다시 찾을 수도 없다 — 별칭 merge/unmerge가 이름을 바꾸고
 * ADR-0027 수리가 금액을 바꾸기 때문이다. 남는 연결선은 **근거 거래 ID의 교집합**뿐이다.
 *
 * 재계산 실패가 사용자의 결정을 삭제해선 안 된다(PO 판정 Q5-4). 그래서 이 모듈은
 * "무엇을 지운다"가 아니라 "무엇을 이어 붙이고 무엇을 다시 봐 달라고 남길지"를 낸다.
 */

/** `needs_review`로 넘어간 이유. DB `needs_review_reason` 어휘와 같다. */
export type NeedsReviewReason = 'evidence_lost' | 'merged' | 'split';

/** 사용자가 이미 판단한(또는 재검토 대기 중인) 기존 series. */
export interface DecidedSeries {
  id: string;
  /** 근거 거래 ID 집합(현재 저장된 것). */
  transactionIds: readonly string[];
}

export interface ReconcilePlan {
  /** 기존 series를 새 후보로 갱신한다(신원·상태 유지). */
  updates: { seriesId: string; candidateIndex: number }[];
  /**
   * 상태를 `needs_review`로 바꾼다. `candidateIndex`가 있으면 근거도 그 후보로
   * 갱신하고(갈라진 경우 가장 큰 조각), 없으면 **기존 근거를 그대로 둔다**.
   */
  needsReview: {
    seriesId: string;
    reason: NeedsReviewReason;
    candidateIndex: number | null;
  }[];
  /** 어느 기존 series와도 이어지지 않은 후보 — 새 `candidate`로 넣는다. */
  inserts: number[];
}

interface Match {
  candidateIndex: number;
  overlap: number;
}

/**
 * 기존 결정과 새 후보를 잇는다.
 *
 * 규칙:
 * 1. 교집합이 가장 큰 후보에 이어 붙인다(동률이면 낮은 index — 결정적이어야 한다).
 * 2. 교집합이 하나도 없으면 `evidence_lost`. 근거는 **지우지 않고** 그대로 둔다 —
 *    거래가 잠시 안 보이는 것과 영영 사라진 것을 이 시점에 구별할 수 없다.
 * 3. 둘 이상의 기존 series가 같은 후보를 최선으로 고르면 **합쳐진 것**이다. 어느 쪽
 *    결정을 살릴지 시스템이 정할 수 없으므로 전부 `merged`로 두고 근거도 건드리지
 *    않는다. 그 후보는 새 candidate로도 넣지 않는다 — 넣으면 한 사건이 화면에 세 줄이 된다.
 * 4. 한 series의 근거가 여러 후보로 흩어졌으면 `split`이다. 가장 큰 조각에 이어 붙이고
 *    나머지 조각은 새 candidate가 된다(사용자가 각각 판단할 수 있어야 한다).
 */
export function reconcileSeries(
  decided: readonly DecidedSeries[],
  candidates: readonly { transactionIds: readonly string[] }[],
): ReconcilePlan {
  const candidateSets = candidates.map((c) => new Set(c.transactionIds));

  // 각 기존 series의 후보별 교집합. 결정적 정렬(겹침 큰 순 → index 작은 순).
  const matchesBySeries = new Map<string, Match[]>();
  for (const series of decided) {
    const matches: Match[] = [];
    candidateSets.forEach((set, candidateIndex) => {
      let overlap = 0;
      for (const id of series.transactionIds) if (set.has(id)) overlap += 1;
      if (overlap > 0) matches.push({ candidateIndex, overlap });
    });
    matches.sort(
      (a, b) => b.overlap - a.overlap || a.candidateIndex - b.candidateIndex,
    );
    matchesBySeries.set(series.id, matches);
  }

  // 같은 후보를 최선으로 고른 series가 둘 이상이면 합쳐진 것이다.
  const claimants = new Map<number, string[]>();
  for (const series of decided) {
    const best = matchesBySeries.get(series.id)?.[0];
    if (!best) continue;
    const list = claimants.get(best.candidateIndex) ?? [];
    list.push(series.id);
    claimants.set(best.candidateIndex, list);
  }

  const plan: ReconcilePlan = { updates: [], needsReview: [], inserts: [] };
  const consumed = new Set<number>();

  for (const series of decided) {
    const matches = matchesBySeries.get(series.id) ?? [];
    const best = matches[0];

    if (!best) {
      plan.needsReview.push({
        seriesId: series.id,
        reason: 'evidence_lost',
        candidateIndex: null,
      });
      continue;
    }

    const rivals = claimants.get(best.candidateIndex) ?? [];
    if (rivals.length > 1) {
      plan.needsReview.push({
        seriesId: series.id,
        reason: 'merged',
        candidateIndex: null,
      });
      // 합쳐진 후보는 어느 쪽에도 귀속되지 않지만 새 candidate로도 만들지 않는다.
      consumed.add(best.candidateIndex);
      continue;
    }

    consumed.add(best.candidateIndex);
    if (matches.length > 1) {
      // 갈라졌다 — 가장 큰 조각으로 이어 붙이되 사용자가 다시 보게 한다.
      plan.needsReview.push({
        seriesId: series.id,
        reason: 'split',
        candidateIndex: best.candidateIndex,
      });
      continue;
    }

    plan.updates.push({
      seriesId: series.id,
      candidateIndex: best.candidateIndex,
    });
  }

  candidates.forEach((_, index) => {
    if (!consumed.has(index)) plan.inserts.push(index);
  });
  return plan;
}
