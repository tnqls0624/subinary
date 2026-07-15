/**
 * KRW money helpers.
 *
 * All monetary amounts in this project are represented as plain KRW integers
 * (no decimals, no floating-point fractions). These helpers enforce that
 * invariant at runtime.
 */

/**
 * Assert that a value is a valid KRW amount (a safe integer).
 * Throws a `TypeError` for non-finite values and non-integers.
 */
export function assertKrwInteger(v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`KRW amount must be a finite number, received: ${String(v)}`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new TypeError(`KRW amount must be an integer within the safe integer range, received: ${v}`);
  }
}

/**
 * Sum a list of KRW integer amounts.
 * Every element is validated via {@link assertKrwInteger}; the running total
 * is also guarded against exceeding `Number.MAX_SAFE_INTEGER`.
 */
export function sumKrw(values: number[]): number {
  let total = 0;
  for (const value of values) {
    assertKrwInteger(value);
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('KRW sum exceeded the safe integer range');
    }
  }
  return total;
}
