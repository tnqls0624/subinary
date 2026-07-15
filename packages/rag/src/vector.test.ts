import { describe, expect, it } from 'vitest';

import { toVectorLiteral } from './vector.js';

describe('toVectorLiteral', () => {
  it('renders a numeric vector as a bracketed comma-separated literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
    expect(toVectorLiteral([1, -2, 3])).toBe('[1,-2,3]');
  });

  it('renders an empty vector as "[]"', () => {
    expect(toVectorLiteral([])).toBe('[]');
  });

  it('throws on non-finite components', () => {
    expect(() => toVectorLiteral([1, Number.NaN, 3])).toThrow(RangeError);
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => toVectorLiteral([1, Number.NEGATIVE_INFINITY])).toThrow(RangeError);
  });
});
