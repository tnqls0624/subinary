/* ---------------------------------------------------------------------------
 * `YYYY-MM` 월 키 유틸 — Asia/Seoul 고정(+09:00, DST 없음).
 *
 * 홈·예산의 월 스위처와 거래 화면의 월 필터가 같은 규칙을 써야 한다. 이전에는
 * `monthRange`/`recentMonths`가 거래 페이지 안에만 있어서, 다른 화면이 월을 다루려면
 * 복사하거나 각자 계산해야 했다(ADR-0026).
 *
 * 월 키를 문자열로 다루는 이유: `new Date()`는 브라우저 로컬 타임존을 따르므로 KST가
 * 아닌 기기에서 월이 하루 어긋난다. 여기서는 문자열 산술만 하고, 서버로 보낼 때만
 * `+09:00` 오프셋을 명시한 ISO 경계로 바꾼다.
 * ------------------------------------------------------------------------- */
import { currentMonth } from "./format";

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** `YYYY-MM` 형식이면 [year, month] 로 분해. 아니면 null. */
function parseMonth(month: string): [number, number] | null {
  const match = MONTH_RE.exec(month);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

/** [year, month] → `YYYY-MM`. */
function formatKey(year: number, mon: number): string {
  return `${year}-${String(mon).padStart(2, "0")}`;
}

/** `YYYY-MM` → Asia/Seoul 월 경계 [월초, 다음달초)의 ISO 문자열. */
export function monthRange(month: string): { from?: string; to?: string } {
  const parsed = parseMonth(month);
  if (!parsed) return {};
  const [year, mon] = parsed;
  // Asia/Seoul은 DST 없는 고정 +09:00 → 오프셋을 명시해 안전하게 경계를 만든다.
  const from = `${formatKey(year, mon)}-01T00:00:00+09:00`;
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  return { from, to: `${formatKey(nextYear, nextMon)}-01T00:00:00+09:00` };
}

/** 현재월부터 과거로 `count`개월(YYYY-MM) 목록. */
export function recentMonths(count: number): string[] {
  const parsed = parseMonth(currentMonth());
  if (!parsed) return [];
  let [year, mon] = parsed;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(formatKey(year, mon));
    mon -= 1;
    if (mon === 0) {
      mon = 12;
      year -= 1;
    }
  }
  return out;
}

/** `YYYY-MM`에 `delta`개월을 더한다(음수면 과거). 무효 입력은 그대로 반환. */
export function addMonths(month: string, delta: number): string {
  const parsed = parseMonth(month);
  if (!parsed) return month;
  const [year, mon] = parsed;
  // 0-based 월로 바꿔 계산하면 연도 넘김이 자동으로 처리된다.
  const zeroBased = year * 12 + (mon - 1) + delta;
  return formatKey(Math.floor(zeroBased / 12), (zeroBased % 12) + 1);
}

/** `YYYY-MM` 형식이고 실재하는 달(01~12)인지. */
export function isMonthKey(month: string): boolean {
  const parsed = parseMonth(month);
  return parsed != null && parsed[1] >= 1 && parsed[1] <= 12;
}

/**
 * `months`(오름차순) 안에서 `month`보다 **작은** 가장 큰 달. 없으면 null.
 *
 * 데이터가 있는 달만 건너뛰기 위한 것 — 실측 데이터는 2026-03과 2026-07 사이가
 * 비어 있어 단순히 `addMonths(month, -1)`로 가면 빈 화면을 4번 지나야 했다.
 * `month`가 목록에 없어도 동작한다(목록 밖의 현재월에서 뒤로 갈 때).
 */
export function prevAvailable(
  months: readonly string[],
  month: string,
): string | null {
  let found: string | null = null;
  for (const m of months) {
    if (m < month) found = m;
    else break;
  }
  return found;
}

/** `months`(오름차순) 안에서 `month`보다 **큰** 가장 작은 달. 없으면 null. */
export function nextAvailable(
  months: readonly string[],
  month: string,
): string | null {
  for (const m of months) if (m > month) return m;
  return null;
}
