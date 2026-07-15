import { formatInTimeZone } from 'date-fns-tz';

import { DEFAULT_TIMEZONE } from './constants.js';

/** Default render format: `2026-07-15 09:30:00+09:00`. */
const DEFAULT_SEOUL_FORMAT = 'yyyy-MM-dd HH:mm:ssXXX';

/**
 * Current instant. `Date` is always an absolute UTC instant internally;
 * the name makes the storage convention (UTC in, Seoul out) explicit.
 */
export function nowUtc(): Date {
  return new Date();
}

/**
 * Render a `Date` as a string in the Asia/Seoul timezone.
 * Throws a `RangeError` when given an invalid `Date`.
 */
export function toSeoulString(date: Date, fmt: string = DEFAULT_SEOUL_FORMAT): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('toSeoulString: received an invalid Date');
  }
  return formatInTimeZone(date, DEFAULT_TIMEZONE, fmt);
}
