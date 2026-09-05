/**
 * 카테고리 제안 프롬프트 v2 — 실측 기반 개선을 고정한다.
 *
 * v1 정밀도 68.6%(70건 중 22건 오답). 오답의 32%가 `기타`였고, 최다 혼동은
 * 장보기→식비 5건이었다. 둘 다 프롬프트가 만든 문제다 — 모르겠다고 말할 수단이
 * 없었고, 이 가족의 기준을 알려주지 않았다.
 */
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_PROMPT_VERSION,
  buildCategorySystemPrompt,
  buildCategoryUserPrompt,
  selectCategoryExamples,
  type CategoryExample,
} from './category-suggest.prompt';

const RULES: CategoryExample[] = [
  { merchantPattern: '세븐일레븐중구ENA센터', slug: 'food' },
  { merchantPattern: '벤디스', slug: 'food' },
  { merchantPattern: '파리바게뜨', slug: 'food' },
  { merchantPattern: '메가엠지씨커피', slug: 'cafe' },
  { merchantPattern: '도담커피', slug: 'cafe' },
  { merchantPattern: '쿠팡', slug: 'shopping' },
];

describe('selectCategoryExamples', () => {
  it('카테고리별로 정해진 개수만 고른다', () => {
    const picked = selectCategoryExamples(RULES, '대상가맹점', 2);
    // food 3건 중 2건 + cafe 2건 + shopping 1건
    expect(picked).toHaveLength(5);
    expect(picked.filter((e) => e.slug === 'food')).toHaveLength(2);
  });

  it('결정적이다 — 입력 순서가 달라도 같은 결과', () => {
    // 무작위·최근순으로 뽑으면 같은 입력이 호출마다 다른 프롬프트를 만들고,
    // 그러면 정밀도가 변해도 원인을 프롬프트라고 말할 수 없다.
    const forward = selectCategoryExamples(RULES, 'x', 2);
    const reversed = selectCategoryExamples([...RULES].reverse(), 'x', 2);
    expect(reversed).toEqual(forward);
  });

  it('예측 대상 자신은 예시에 넣지 않는다', () => {
    const picked = selectCategoryExamples(RULES, '쿠팡', 2);
    expect(picked.map((e) => e.merchantPattern)).not.toContain('쿠팡');
  });

  it('규칙이 없으면 빈 배열이다', () => {
    expect(selectCategoryExamples([], '쿠팡', 2)).toEqual([]);
  });
});

describe('buildCategorySystemPrompt', () => {
  it('모르겠으면 null을 내라고 명시한다', () => {
    // v1은 "가장 알맞은 하나를 고르라"고만 해서 모델이 `기타`로 던졌다.
    const system = buildCategorySystemPrompt();
    expect(system).toContain('{"slug":null}');
    expect(system).toContain('확신이 없으면');
  });

  it('"기타"로 분류하는 것보다 비우는 게 낫다고 말한다', () => {
    expect(buildCategorySystemPrompt()).toContain('기타');
  });
});

describe('buildCategoryUserPrompt', () => {
  const candidates = [
    { slug: 'food', name: '식비' },
    { slug: 'cafe', name: '카페' },
  ];

  it('이 가족의 확정 예시를 함께 보낸다', () => {
    // "편의점을 식비로 볼지 장보기로 볼지"는 보편 정답이 없고 가족마다 다르다.
    const prompt = buildCategoryUserPrompt({
      merchantName: 'GS25영등포도림',
      candidates,
      examples: [{ merchantPattern: '세븐일레븐중구ENA센터', slug: 'food' }],
    });
    expect(prompt).toContain('세븐일레븐중구ENA센터 → food');
    expect(prompt).toContain('이 가족이 지금까지 확정한 분류');
  });

  it('예시가 없으면 그 절을 통째로 뺀다', () => {
    // 빈 목록을 제목과 함께 보내면 모델이 "예시가 없다"를 신호로 읽는다.
    const prompt = buildCategoryUserPrompt({
      merchantName: 'GS25영등포도림',
      candidates,
      examples: [],
    });
    expect(prompt).not.toContain('이 가족이 지금까지 확정한 분류');
    expect(prompt).toContain('가맹점명: GS25영등포도림');
  });

  it('null 출력 경로를 user 쪽에도 남긴다', () => {
    const prompt = buildCategoryUserPrompt({
      merchantName: 'x',
      candidates,
      examples: [],
    });
    expect(prompt).toContain('{"slug":null}');
  });

  it('금액·날짜·구성원을 넣지 않는다', () => {
    // 지시서 §3-5 최소 전송 원칙. 예시를 더한다고 경계가 바뀌지 않는다.
    const prompt = buildCategoryUserPrompt({
      merchantName: 'GS25영등포도림',
      candidates,
      examples: [{ merchantPattern: '쿠팡', slug: 'shopping' }],
    });
    expect(prompt).not.toMatch(/원|amount|\d{4}-\d{2}-\d{2}/);
  });
});

describe('프롬프트 버전', () => {
  it('v1과 구분되는 버전을 쓴다', () => {
    // 버전을 올리지 않으면 ai_invocations에서 v1/v2 정밀도를 나눠 셀 수 없다.
    expect(CATEGORY_PROMPT_VERSION).toBe('merchant-category-v2');
  });
});
