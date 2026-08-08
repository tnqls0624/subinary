/**
 * shadow 재생 — 코퍼스 전수를 기존 파서와 새 추출기로 **동시에** 돌린다.
 * ADR-0027 롤아웃 3단계의 측정에 해당하며, 어떤 동작도 바꾸지 않는다.
 *
 * 이 파일이 지키는 두 가지:
 *
 * 1. **기존 금액 delta 0** — `legacyAmount`는 이번 변경 이전에 측정한 값이다. 하나라도
 *    달라지면 기존 경로에 손을 댔다는 뜻이고, 그건 회귀다.
 * 2. **분류 가시성** — 동일 / 신규가 비승격 판정 / 금액 다름 / 신규가 추출 실패를
 *    세어 콘솔에 남긴다. 리포트에 옮겨 적는 숫자가 여기서 나온다.
 */
import { describe, expect, it } from 'vitest';

import {
  compareAmountEvidence,
  extractActionGroundedAmount,
  summarizeAmountShadow,
} from './action-amount.js';
import { parseCardSms } from './dispatch.js';
import { SHADOW_CORPUS } from './fixtures/action-amount.corpus.js';

import type { AmountShadowRecord } from './action-amount.js';

const replay = (): { entry: (typeof SHADOW_CORPUS)[number]; record: AmountShadowRecord }[] =>
  SHADOW_CORPUS.map((entry) => {
    const input = { sender: entry.sender, content: entry.content, receivedAt: entry.receivedAt };
    return { entry, record: compareAmountEvidence(input, parseCardSms(input)) };
  });

describe('shadow 재생 — 기존 결과 무회귀', () => {
  it.each(SHADOW_CORPUS.map((e) => [e.id, e] as const))(
    '기존 파서 금액이 기준값 그대로다: %s',
    (_id, entry) => {
      const legacy = parseCardSms({
        sender: entry.sender,
        content: entry.content,
        receivedAt: entry.receivedAt,
      });
      expect(legacy.amount).toBe(entry.legacyAmount);
      if (entry.legacyCurrency !== undefined) {
        expect(legacy.currency).toBe(entry.legacyCurrency);
      }
    },
  );

  it('코퍼스 전수의 기존 금액 delta가 0이다', () => {
    const delta = SHADOW_CORPUS.filter((entry) => {
      const legacy = parseCardSms({
        sender: entry.sender,
        content: entry.content,
        receivedAt: entry.receivedAt,
      });
      return legacy.amount !== entry.legacyAmount;
    });
    expect(delta).toEqual([]);
  });
});

describe('shadow 재생 — 액션 결박 추출기', () => {
  it.each(SHADOW_CORPUS.map((e) => [e.id, e] as const))(
    '새 추출기가 기대한 판정을 낸다: %s',
    (_id, entry) => {
      const candidate = extractActionGroundedAmount(entry.content);
      expect(candidate.status).toBe(entry.expectedStatus);
      expect(candidate.amount).toBe(entry.expectedAmount);
      if (entry.expectedCurrency !== undefined) {
        expect(candidate.currency).toBe(entry.expectedCurrency);
      }
    },
  );

  it('확정된 span이 원문 증거를 그대로 복원한다 (ADR-0027 §5 span 불변식)', () => {
    for (const entry of SHADOW_CORPUS) {
      const candidate = extractActionGroundedAmount(entry.content);
      if (candidate.status !== 'resolved') continue;
      const { amountSpan, actionSpan } = candidate;
      expect(amountSpan).toBeDefined();
      expect(actionSpan).toBeDefined();
      // slice가 증거 문자열이어야 한다 — 정규화본이나 byte offset이 아니다.
      expect(entry.content.slice(amountSpan!.start, amountSpan!.end)).toMatch(/\d/);
      expect(entry.content.slice(actionSpan!.start, actionSpan!.end)).toMatch(
        /승인|취소|환불|매출|매입|정정|결제/,
      );
    }
  });

  it('정상 승인(positive)은 기존 금액과 100% 일치한다', () => {
    const mismatches = replay()
      .filter(({ entry }) => entry.kind === 'positive')
      .filter(({ record }) => record.verdict !== 'same')
      .map(({ entry, record }) => `${entry.id}: ${record.verdict}`);
    expect(mismatches).toEqual([]);
  });

  // 기존이 우연히 맞은 건(`d4-누적-뒤`: 누적 라인이 뒤에 있어 첫 `N원`이 결제액과
  // 같다)은 `same`이 정답이다. 고쳐야 하는 것은 **기존이 틀린 금액을 고른 건**이다.
  it('D-4 negative에서 기존이 틀린 금액을 고른 건은 전부 바로잡힌다', () => {
    const unfixed = replay()
      .filter(({ entry }) => entry.kind === 'negative' && entry.legacyAmount !== entry.expectedAmount)
      .filter(({ record }) => record.verdict === 'same')
      .map(({ entry, record }) => `${entry.id}: ${record.verdict}`);
    expect(unfixed).toEqual([]);
  });

  it('분류 집계를 남긴다 (리포트 수치의 출처)', () => {
    const records = replay();
    const summary = summarizeAmountShadow(records.map((r) => r.record));

    const byKind = (kind: string): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const { entry, record } of records) {
        if (entry.kind !== kind) continue;
        counts[record.verdict] = (counts[record.verdict] ?? 0) + 1;
      }
      return counts;
    };

    // 확정 범위 분포 — Tier 1(액션 같은 구간)과 Tier 2(줄 분리 레이아웃)의 비율.
    // 게이트를 ADR §5의 엄격 해석으로 조일 때 무엇이 떨어지는지 이 수치가 알려준다.
    const scope: Record<string, number> = {};
    for (const { record } of records) {
      if (record.candidate.status !== 'resolved') continue;
      const key = record.candidate.scope ?? 'unknown';
      scope[key] = (scope[key] ?? 0) + 1;
    }

    // 콘솔 출력은 리포트에 옮겨 적기 위한 것이다(테스트 판정에는 쓰지 않는다).

    console.log(
      '[ADR-0027 shadow]',
      JSON.stringify(
        {
          summary,
          positive: byKind('positive'),
          negative: byKind('negative'),
          non_card: byKind('non_card'),
          resolvedScope: scope,
          diffs: records
            .filter(({ record }) => record.verdict !== 'same')
            .map(({ entry, record }) => ({
              id: entry.id,
              kind: entry.kind,
              routed: record.routed,
              verdict: record.verdict,
              legacy: record.legacyAmount,
              next: record.candidate.amount,
              status: record.candidate.status,
            })),
        },
        null,
        2,
      ),
    );

    expect(summary.total).toBe(SHADOW_CORPUS.length);
  });
});
