import { describe, expect, it } from 'vitest';

import { applyRecipe, deriveRecipe, fieldCandidates } from './recipe.js';
import { templateFingerprint } from './template.js';

import type { CardSmsInput } from './types.js';

/** 실제 삼성카드 레이아웃. 가맹점·금액·시각만 바뀐다. */
const samsung = (amount: string, time: string, merchant: string, receivedAt: string): CardSmsInput => ({
  sender: '15881688',
  content: `[Web발신]\n삼성2승인 이*빈\n${amount} 일시불\n${time} ${merchant}`,
  receivedAt: new Date(receivedAt),
});

/** 실제 현대카드 레이아웃(누적 라인이 뒤에 붙어 금액 후보가 2개다). */
const hyundai = (amount: string, time: string, merchant: string, total: string): CardSmsInput => ({
  sender: '15776000',
  content: `[Web발신]\n네이버 현대카드 승인\n김*진\n${amount} 일시불\n${time}\n${merchant}\n누적${total}`,
  receivedAt: new Date('2026-07-19T15:05:00+09:00'),
});

describe('fieldCandidates', () => {
  it('누적 금액까지 금액 후보로 열거한다 (레시피가 몇 번째인지 기억한다)', () => {
    const input = hyundai('30,000원', '07/19 15:00', '모바일티머니선불', '123,456원');
    const amounts = fieldCandidates(input.content, 'amount').map((s) =>
      input.content.slice(s.start, s.end),
    );
    expect(amounts).toEqual(['30,000원', '123,456원']);
  });

  it('가맹점 후보에서 고정 어휘를 제외한다', () => {
    const input = samsung('1,169원', '07/20 14:32', '영등포구청', '2026-07-20T14:33:00+09:00');
    const merchants = fieldCandidates(input.content, 'merchant').map((s) =>
      input.content.slice(s.start, s.end),
    );
    expect(merchants).toContain('영등포구청');
    expect(merchants).not.toContain('일시불');
  });
});

describe('deriveRecipe → applyRecipe', () => {
  it('한 건의 사람 확정으로 같은 템플릿의 다른 문자를 추출한다 (S4의 핵심)', () => {
    const seed = samsung('1,169원', '07/20 14:32', '영등포구청', '2026-07-20T14:33:00+09:00');
    const fingerprint = templateFingerprint(seed.sender, seed.content);
    const recipe = deriveRecipe(
      seed,
      {
        transactionType: 'approval',
        issuer: '삼성카드',
        amount: 1169,
        currency: 'KRW',
        merchantRaw: '영등포구청',
        occurredAt: new Date('2026-07-20T14:32:00+09:00'),
        installmentMonths: 1,
      },
      fingerprint,
    );
    expect(recipe.fields.amount).toBeDefined();
    expect(recipe.fields.merchant).toBeDefined();
    expect(recipe.fields.occurredAt).toBeDefined();

    // 완전히 다른 가맹점·금액·시각의 같은 템플릿 문자.
    const next = samsung('8,900원', '07/21 09:05', '커피온리샛강역사', '2026-07-21T09:06:00+09:00');
    expect(templateFingerprint(next.sender, next.content)).toBe(fingerprint);

    const { result, rejected } = applyRecipe(next, recipe);
    expect(rejected).toEqual([]);
    expect(result.amount).toBe(8900);
    expect(result.currency).toBe('KRW');
    expect(result.merchantRaw).toBe('커피온리샛강역사');
    expect(result.occurredAt?.toISOString()).toBe('2026-07-21T00:05:00.000Z');
    expect(result.installmentMonths).toBe(1);
    expect(result.issuer).toBe('삼성카드');
    expect(result.transactionType).toBe('approval');
  });

  it('누적 라인이 있어도 결제 금액을 고른다 (후보 순서를 기억하므로)', () => {
    const seed = hyundai('30,000원', '07/19 15:00', '모바일티머니선불', '123,456원');
    const fingerprint = templateFingerprint(seed.sender, seed.content);
    const recipe = deriveRecipe(
      seed,
      {
        transactionType: 'approval',
        issuer: '현대카드',
        amount: 30000,
        currency: 'KRW',
        merchantRaw: '모바일티머니선불',
        occurredAt: new Date('2026-07-19T15:00:00+09:00'),
      },
      fingerprint,
    );
    expect(recipe.fields.amount?.candidateIndex).toBe(0);

    const next = hyundai('4,500원', '07/22 08:10', '뚜레쥬르서울시청', '987,654원');
    const { result } = applyRecipe(next, recipe);
    // 누적(987,654)이 아니라 결제 금액을 골라야 한다.
    expect(result.amount).toBe(4500);
    expect(result.merchantRaw).toBe('뚜레쥬르서울시청');
  });

  it('외화 템플릿도 통화를 보존한다', () => {
    const build = (amount: string, merchant: string): CardSmsInput => ({
      sender: '15776000',
      content: `[Web발신]\n네이버 현대카드 해외승인\n김*진님\n07/20 19:31\n${amount}\n${merchant}`,
      receivedAt: new Date('2026-07-20T19:32:00+09:00'),
    });
    const seed = build('USD 22.00', 'ANTHROPIC*CLAUDESUB');
    const fingerprint = templateFingerprint(seed.sender, seed.content);
    const recipe = deriveRecipe(
      seed,
      { transactionType: 'approval', amount: 2200, currency: 'USD', merchantRaw: 'ANTHROPIC*CLAUDESUB' },
      fingerprint,
    );

    const { result } = applyRecipe(build('USD 30.00', 'GITHUB*COPILOT'), recipe);
    expect(result.amount).toBe(3000);
    expect(result.currency).toBe('USD');
  });

  it('후보가 모자라면 그 필드를 비우고 사유를 남긴다 (변종 오승격 방지)', () => {
    const seed = hyundai('30,000원', '07/19 15:00', '모바일티머니선불', '123,456원');
    const recipe = deriveRecipe(
      seed,
      { transactionType: 'approval', amount: 123456, currency: 'KRW' },
      templateFingerprint(seed.sender, seed.content),
    );
    expect(recipe.fields.amount?.candidateIndex).toBe(1);

    // 누적 라인이 없는 변종 — 두 번째 금액 후보가 존재하지 않는다.
    const variant: CardSmsInput = {
      sender: '15776000',
      content: '[Web발신]\n네이버 현대카드 승인\n김*진\n7,000원 일시불\n07/23 10:00\n어떤가게',
      receivedAt: new Date('2026-07-23T10:01:00+09:00'),
    };
    const { result, rejected } = applyRecipe(variant, recipe);
    expect(result.amount).toBeUndefined();
    expect(rejected.join(';')).toContain('candidate #1 not present');
  });

  it('확정 값과 일치하는 후보가 없으면 그 필드는 레시피에 넣지 않는다', () => {
    const seed = samsung('1,169원', '07/20 14:32', '영등포구청', '2026-07-20T14:33:00+09:00');
    const recipe = deriveRecipe(
      seed,
      { transactionType: 'approval', amount: 99999, merchantRaw: '없는가게' },
      templateFingerprint(seed.sender, seed.content),
    );
    expect(recipe.fields.amount).toBeUndefined();
    expect(recipe.fields.merchant).toBeUndefined();
  });
});
