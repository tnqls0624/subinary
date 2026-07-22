/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 표시 포맷 유틸 (Phase 5 §6.1)
 *
 * 금액은 해당 통화의 minor units 정수, 시각은 Asia/Seoul 기준으로 표시한다
 * (PRD §3.3). 계산은 서버(SQL)에서 끝났다고 가정하며, 여기서는 표시 변환만 담당한다.
 * 개별 카드거래 금액은 통화별 포맷이 필요하므로 {@link formatMoney}(shared 단일
 * 원천)를 사용한다. formatWon/formatKRW는 KRW 전용 집계(월간/예산 등)에만 쓴다.
 * ------------------------------------------------------------------------- */
import { DEFAULT_TIMEZONE, formatMoney } from "@family/shared";

/**
 * minor-units 금액을 통화별로 포맷한다(₩12,500 / $22.00 …). shared 헬퍼 재노출 —
 * 개별 카드거래 금액 표시의 단일 진입점(worker·web·mobile 공통 규약).
 */
export { formatMoney };

/** KRW 통화 포맷터. 소수점 없음(원화는 정수). */
const krwFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

/** Asia/Seoul 날짜+시각 포맷터. */
const dateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Asia/Seoul 날짜(연월일) 포맷터. */
const dateOnlyFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 현재 월(YYYY-MM) 계산용 Asia/Seoul 포맷터(en-CA → 안정적 YYYY-MM). */
const isoMonthFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
});

/**
 * KRW 정수 금액을 `₩12,500` 형태로 포맷한다.
 * NaN/Infinity 방어를 위해 유한값이 아니면 0으로 취급한다.
 */
export function formatKRW(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return krwFormatter.format(safe);
}

/** 천단위 구분 숫자 포맷터(원 접미사용). */
const numberFormatter = new Intl.NumberFormat("ko-KR");

/**
 * KRW 정수 금액을 `12,500원` 으로 포맷한다(₩ 기호 대신 '원' 접미사).
 * 화면 표기는 이 함수를 기본으로 사용한다.
 */
export function formatWon(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return `${numberFormatter.format(safe)}원`;
}

/**
 * ISO 문자열을 Asia/Seoul 기준으로 포맷한다.
 * `dateOnly`면 연월일만, 아니면 분까지. null/무효값은 대시(`—`)로 표기.
 */
export function formatDate(
  iso: string | null | undefined,
  opts?: Readonly<{ dateOnly?: boolean }>,
): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  const formatter = opts?.dateOnly ? dateOnlyFormatter : dateTimeFormatter;
  return formatter.format(parsed);
}

/**
 * ISO 시각을 상대 표기로("방금·N분 전·N시간 전·어제·N일 전·M월 D일"). 알림함용.
 * 7일 이상 지난 건 Asia/Seoul 기준 월/일 절대 표기. null/무효는 빈 문자열.
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diffMs = Date.now() - then.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "어제";
  if (day < 7) return `${day}일 전`;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: DEFAULT_TIMEZONE,
    month: "long",
    day: "numeric",
  }).format(then);
}

/** `YYYY-MM` → `2026년 7월` 표기. 형식이 아니면 원문 반환. */
export function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return `${match[1]}년 ${Number(match[2])}월`;
}

/** Asia/Seoul 기준 이번 달을 `YYYY-MM`으로 반환(기본 기간). */
export function currentMonth(): string {
  const parts = isoMonthFormatter.formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`;
}

/**
 * 비율(0~1)을 백분율 문자열로 포맷한다(`0.723` → `72.3%`).
 * null/무효값은 대시(`—`). 음수/1 초과도 그대로 계산(예산 초과 표시용).
 */
export function percent(
  ratio: number | null | undefined,
  opts?: Readonly<{ digits?: number }>,
): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  const digits = opts?.digits ?? 1;
  return `${(ratio * 100).toFixed(digits)}%`;
}
