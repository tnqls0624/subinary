import { describe, expect, it } from 'vitest';

import { createMerchantCategoryTargetId } from './merchant-label.js';

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
