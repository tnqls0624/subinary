/**
 * 가계부 질의 의도 경계 검증(로드맵 C-6 / PO B8).
 *
 * 이 테스트가 지키는 것은 두 방향의 사고다.
 *  - **자신 있는 오답**: 지원하지 않는 질문에 월 총지출이 답으로 나가는 것.
 *  - **조용한 회귀**: 잘 되던 질문이 거부로 바뀌는 것. 이쪽이 더 조용해서 더 위험하다.
 *
 * 그래서 "거부해야 하는 질문"과 "여전히 답해야 하는 질문"을 같은 무게로 고정한다.
 */
import { describe, expect, it } from 'vitest';

import {
  REFUSAL_ANSWER,
  REFUSAL_SUGGESTIONS,
  classifyUnsupportedKind,
  currentSeoulMonth,
  extractIntentHeuristically,
  previousMonth,
  seoulMonthRange,
  toMonthString,
} from './finance-intent';

describe('지원하는 질문은 여전히 답한다(회귀 방어)', () => {
  it('총지출을 묻는 말투를 total 로 알아본다', () => {
    const questions = [
      '이번 달 얼마 썼어?',
      '이번 달 총 지출 얼마야?',
      '이번달 지출 알려줘',
      '지난달 총액이 얼마였지?',
      '이번 달에 돈 얼마나 나갔어?',
      '2026-03 지출 얼만큼이야',
    ];
    for (const question of questions) {
      expect(
        extractIntentHeuristically(question).aggregate,
        `"${question}" 이 거부되면 회귀다`,
      ).toBe('total');
    }
  });

  it('카테고리 이름이 나오면 byCategory 다', () => {
    for (const question of ['카페에 얼마 썼어?', '이번 달 식비 얼마야?']) {
      const intent = extractIntentHeuristically(question);
      expect(intent.aggregate).toBe('byCategory');
      expect(intent.categorySlug).not.toBeNull();
    }
  });

  it('카테고리 이름 없이 축만 말해도 byCategory 다', () => {
    expect(extractIntentHeuristically('카테고리별로 보여줘').aggregate).toBe(
      'byCategory',
    );
    expect(extractIntentHeuristically('항목별 지출 알려줘').aggregate).toBe(
      'byCategory',
    );
  });

  it('가맹점 축 질문은 byMerchant 다', () => {
    for (const question of [
      '어디서 제일 많이 썼어?',
      '가맹점별로 알려줘',
      '이번 달 매장 어디가 많아?',
    ]) {
      expect(
        extractIntentHeuristically(question).aggregate,
        `"${question}"`,
      ).toBe('byMerchant');
    }
  });

  it('월 해석은 그대로다(지난달/이번달/YYYY-MM/N월)', () => {
    const now = currentSeoulMonth();
    expect(extractIntentHeuristically('지난달 얼마 썼어?').month).toBe(
      previousMonth(now),
    );
    expect(extractIntentHeuristically('이번 달 얼마 썼어?').month).toBe(now);
    expect(extractIntentHeuristically('2026-03 지출 얼마야').month).toBe(
      '2026-03',
    );
    expect(extractIntentHeuristically('3월 지출 얼마야').month).toBe(
      `${now.slice(0, 4)}-03`,
    );
    // 월 표현이 없으면 당월.
    expect(extractIntentHeuristically('총 지출 얼마야').month).toBe(now);
  });
});

describe('지원하지 않는 질문은 총지출로 때우지 않고 거부한다', () => {
  it('집계 축을 하나도 못 알아본 질문은 unsupported 다', () => {
    const questions = [
      '지난달이랑 비교해줘',
      '우리 가족 여행 언제 가?',
      '카드 재발급 어떻게 해?',
      '다음 달에는 예산이 남을까?',
      '안녕?',
    ];
    for (const question of questions) {
      expect(
        extractIntentHeuristically(question).aggregate,
        `"${question}" 에 총지출이 나가면 안 된다`,
      ).toBe('unsupported');
    }
  });

  it('월만 알아본 것은 분류가 아니다 — 거부되어야 한다', () => {
    const intent = extractIntentHeuristically('지난달이랑 비교해줘');
    expect(intent.month).toBe(previousMonth(currentSeoulMonth()));
    expect(intent.aggregate).toBe('unsupported');
  });

  it('거부 문구는 오류 톤이 아니고, 물어볼 수 있는 예시를 함께 준다', () => {
    expect(REFUSAL_ANSWER).not.toMatch(/오류|실패|에러|죄송/);
    expect(REFUSAL_ANSWER).toMatch(/어요\.?$/); // 기존 해요체 유지
    expect(REFUSAL_SUGGESTIONS.length).toBeGreaterThan(0);
  });

  it('예시로 제시하는 질문은 전부 실제로 답할 수 있는 질문이다', () => {
    // 거부 화면이 답 못 하는 예시를 권하면 사용자는 두 번 속는다.
    for (const suggestion of REFUSAL_SUGGESTIONS) {
      expect(
        extractIntentHeuristically(suggestion).aggregate,
        `"${suggestion}"`,
      ).not.toBe('unsupported');
    }
  });
});

describe('거부 갈래 분류(관측 전용 — 원문 대신 이것만 저장한다)', () => {
  it('비교/횟수/예측/기타로 나눈다', () => {
    expect(classifyUnsupportedKind('지난달이랑 비교해줘')).toBe('comparison');
    expect(classifyUnsupportedKind('카페 몇 번 갔어?')).toBe('count');
    expect(classifyUnsupportedKind('다음 달 예산 남을까?')).toBe('forecast');
    expect(classifyUnsupportedKind('안녕?')).toBe('other');
  });
});

describe('월 헬퍼(Asia/Seoul 고정 UTC+9)', () => {
  it('월 롤오버를 흡수한다', () => {
    expect(toMonthString(2026, 13)).toBe('2027-01');
    expect(toMonthString(2026, 0)).toBe('2025-12');
    expect(previousMonth('2026-01')).toBe('2025-12');
  });

  it('월 경계는 KST 벽시계 기준이다', () => {
    const { from, to } = seoulMonthRange('2026-08');
    expect(from.toISOString()).toBe('2026-07-31T15:00:00.000Z');
    expect(to.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });
});
