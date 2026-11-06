/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 표시 포맷 유틸 (Phase 5 §6.1)
 *
 * 금액은 해당 통화의 minor units 정수, 시각은 Asia/Seoul 기준으로 표시한다
 * (PRD §3.3). 계산은 서버(SQL)에서 끝났다고 가정하며, 여기서는 표시 변환만 담당한다.
 * 개별 카드거래 금액은 통화별 포맷이 필요하므로 {@link formatMoney}(shared 단일
 * 원천)를 사용한다. formatWon은 KRW 전용 집계(월간/예산 등)에만 쓴다.
 * ------------------------------------------------------------------------- */
import { DEFAULT_TIMEZONE, formatMoney } from "@family/shared";

/**
 * minor-units 금액을 통화별로 포맷한다(₩12,500 / $22.00 …). shared 헬퍼 재노출 —
 * 개별 카드거래 금액 표시의 단일 진입점(worker·web·mobile 공통 규약).
 */
export { formatMoney };

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

/**
 * 발신번호를 읽을 수 있게 쓴다(1661-7654). 카드사 이름은 응답에 없고, 번호로 카드사를
 * 추측하면 틀린 이름을 붙일 수 있어 하지 않는다.
 */
export function formatSender(sender: string): string {
  const digits = sender.replace(/\D/g, "");
  if (digits === sender && /^1[5-9]\d{6}$/.test(digits)) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return sender;
}

/*
 * 날짜·시각 짧은 표기 — 화면마다 'M월 D일'·'2026-11-20'·'2026. 11. 05. 14:31'로 섞여 있던 것을 하나로 모은다
 * (2026-11-05 HIG 검수). 위 formatDate 등은 바꾸지 않는다.
 */

/** 날짜 표기에 받는 값 — ISO 문자열 또는 Date. 비었거나 무효면 대시(`—`). */
type DateValue = string | Date | null | undefined;

/**
 * Asia/Seoul 기준 연·월·일·시·분 조각. 'ko-KR' 출력 대신 숫자만 받아 직접 조립한다 —
 * 엔진·ICU 데이터에 따라 '오후 2:31'·'11. 5.' 같은 모양이 달라지지 않게 하려고.
 * hourCycle h23: hour12:false는 일부 엔진에서 자정을 '24'로 낸다.
 */
const seoulPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

type SeoulParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}>;

function seoulParts(value: DateValue): SeoulParts | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = seoulPartsFormatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
  };
}

function monthDayOf(parts: SeoulParts, now: Date): string {
  const sameYear = parts.year === seoulParts(now)?.year;
  return sameYear
    ? `${parts.month}월 ${parts.day}일`
    : `${parts.year}년 ${parts.month}월 ${parts.day}일`;
}

function timeOf(parts: SeoulParts): string {
  const period = parts.hour < 12 ? "오전" : "오후";
  const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${period} ${hour12}:${String(parts.minute).padStart(2, "0")}`;
}

/**
 * 서울 기준 `11월 5일`. 올해(서울 기준 `now`의 해)가 아니면 `2025년 11월 5일`.
 * 날짜만 있는 'YYYY-MM-DD'도 그 날짜로 나온다(UTC 자정 = 서울 오전 9시라 날이 바뀌지 않는다).
 */
export function formatMonthDay(value: DateValue, now: Date = new Date()): string {
  const parts = seoulParts(value);
  return parts ? monthDayOf(parts, now) : "—";
}

/** 서울 기준 `오후 2:31`(12시간제, 자정은 `오전 12:05`, 정오는 `오후 12:00`). */
export function formatTimeShort(value: DateValue): string {
  const parts = seoulParts(value);
  return parts ? timeOf(parts) : "—";
}

/** 서울 기준 `11월 5일 오후 2:31`. 올해가 아니면 `2025년 11월 5일 오후 2:31`. */
export function formatMonthDayTime(
  value: DateValue,
  now: Date = new Date(),
): string {
  const parts = seoulParts(value);
  return parts ? `${monthDayOf(parts, now)} ${timeOf(parts)}` : "—";
}

/**
 * 조회·스냅샷 기준 시각을 `YYYY-MM-DD HH:mm Asia/Seoul`로 쓴다.
 * 스펙 숫자 표기 규칙 — 신선도 배지·상대 시각이 아니라 절대 시각만.
 */
export function formatAsOfSeoul(value: DateValue): string {
  const parts = seoulParts(value);
  if (!parts) return "—";
  const y = String(parts.year).padStart(4, "0");
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} Asia/Seoul`;
}

