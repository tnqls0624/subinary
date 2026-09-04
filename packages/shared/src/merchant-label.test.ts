import { describe, expect, it } from 'vitest';

import {
  createMerchantCategoryTargetId,
  createMerchantIdentityTargetId,
} from './merchant-label.js';

describe('createMerchantCategoryTargetId', () => {
  it('household와 가맹점 조합을 안정적인 SHA-256 target id로 만든다', () => {
    expect(createMerchantCategoryTargetId('household-a', '스타벅스')).toBe(
      '139a9e30e4a3377e7cc604a40afcdf2479948158d903b416c09dc26c75e96ded',
    );
  });

  it('같은 가맹점도 household가 다르면 다른 target id를 만든다', () => {
    expect(createMerchantCategoryTargetId('household-a', '스타벅스')).not.toBe(
      createMerchantCategoryTargetId('household-b', '스타벅스'),
    );
  });
});

describe('createMerchantIdentityTargetId', () => {
  const names = ['지에스25 영등포도림', 'GS25영등포도림'];

  it('이름 순서가 달라도 같은 target id다', () => {
    // 목록 정렬이나 대표 선택에 따라 순서가 바뀌는데, 순서가 id를 바꾸면 사용자가
    // 거절한 후보가 다음 렌더에서 다른 id로 다시 올라온다.
    expect(createMerchantIdentityTargetId('h1', names)).toBe(
      createMerchantIdentityTargetId('h1', [...names].reverse()),
    );
  });

  it('어느 이름을 대표로 삼든 같은 target id다', () => {
    // "이 이름들은 같은 가게가 아니다"는 대표 선택과 무관한 판단이다.
    const a = createMerchantIdentityTargetId('h1', [names[0] as string, names[1] as string]);
    const b = createMerchantIdentityTargetId('h1', [names[1] as string, names[0] as string]);
    expect(a).toBe(b);
  });

  it('중복 이름을 한 번으로 센다', () => {
    expect(
      createMerchantIdentityTargetId('h1', [...names, names[0] as string]),
    ).toBe(createMerchantIdentityTargetId('h1', names));
  });

  it('household가 다르면 다른 target id다', () => {
    expect(createMerchantIdentityTargetId('h1', names)).not.toBe(
      createMerchantIdentityTargetId('h2', names),
    );
  });

  it('묶음 구성이 달라지면 다른 target id다', () => {
    // 규칙이 개선돼 묶음에 이름이 하나 더 붙으면 새 후보로 취급돼야 한다 —
    // 과거 거절이 개선된 제안을 영구히 막지 않는다.
    expect(
      createMerchantIdentityTargetId('h1', [...names, '지에스25영등포']),
    ).not.toBe(createMerchantIdentityTargetId('h1', names));
  });

  it('카테고리 target id와 충돌하지 않는다', () => {
    // 두 계보가 같은 target_id를 쓰면 데이터셋 빌드가 다른 질문의 답을 섞어 읽는다.
    expect(createMerchantIdentityTargetId('h1', ['스타벅스'])).not.toBe(
      createMerchantCategoryTargetId('h1', '스타벅스'),
    );
  });
});
