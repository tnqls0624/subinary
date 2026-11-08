/**
 * 수자인 분양대금조회 표 해석. 확인된 화면(2026-11-08)을 근거로 읽는다.
 * - 단지를 고르고 조회하면 보이는 table.st1 이 나온다. 머리(thead th)는 8칸:
 *   회차|약정일자|약정금액|납부일자|납부원금|연체료|할인료|실납부금.
 * - 「아파트 분양대금」 줄 첫 칸(th)은 회차 이름: 계약금1차·계약금2차·중도금1차…·잔금·계(합계).
 * - 「별도 계약 품목」 표는 옵션 계약마다 하나, 줄은 계약금(또는 계약금1차)·중도금·잔금·계이고
 *   표 앞 div.ect_item 의 품목 이름 목록이 itemLabel 로 온다.
 * 모르는 칸은 비우고 이유를 남긴다. 없는 숫자는 추정하지 않는다('0'은 0 으로 둔다).
 */
import { randomUUID } from 'node:crypto';
import type { HousingBrandFetchedItem, ManualHousingPaymentKind } from '@family/contracts';

export type SujainRawRow = {
  cells: string[];
  headers?: string[];
  /** 'unit-items' 는 옛 러너(세대 내 설치 품목 화면)만 보낸다. */
  sourcePage: 'payment' | 'unit-items';
  /** 표 caption 으로 정한 구역. 없으면 옛 러너 — 분양대금(payment)으로 본다. */
  section?: 'payment' | 'option';
  /** 별도 계약 품목 표 앞 품목 이름 목록(공백 정리, 최대 200자). */
  itemLabel?: string;
};

export type SujainParseResult = {
  items: HousingBrandFetchedItem[];
  unreadCount: number;
  unreadReasons: string[];
  /** Rows that looked like payment/option tables (not member-profile/contact junk). */
  eligibleRowCount: number;
};

type UnreadField = HousingBrandFetchedItem['unreadFields'][number]['field'];
type Note = (field: UnreadField, reason: string) => void;

/**
 * 회차 이름(줄 첫 칸)에서 종류를 고른다. 머리 글자는 보지 않는다 — 옛 러너가 머리에
 * '계약금1차' 같은 줄 이름을 섞어 보내도 모든 줄을 계약금으로 보지 않게 한다.
 */
const ROW_KIND_HINTS: Array<{ kind: ManualHousingPaymentKind; pattern: RegExp }> = [
  { kind: 'contract', pattern: /계약금/u },
  { kind: 'interim', pattern: /중도금/u },
  { kind: 'balance', pattern: /잔금/u },
  { kind: 'option', pattern: /옵션|설치\s*품목|유상/u },
];

/** 합계 줄은 일정이 아니다 — 조용히 건너뛰고 unread 로 세지 않는다. */
const TOTAL_ROW_NAME = /^(?:계|합계|총계)$/u;
/** 계약금1차·중도금3차·2회 */
const ROW_INSTALLMENT = /(\d{1,4})\s*(?:차|회)/u;
const OPTION_LABEL_MAX = 100;
const OPTION_ROW_NAME_MAX = 30;
const OPTION_TITLE_FALLBACK = '별도 계약 품목';

/** Amount-like column names — a name/항목 column alone is not enough. */
const AMOUNT_LIKE_HEADER = /예정(?!일)|금액|분양가|대금/u;
/** Option-table headers (품목). Do not treat bare 항목/이름/명칭 as option lists. */
const OPTION_TABLE_HEADER = /옵션|유상|설치\s*품목|품목/u;
/** Payment/option kind signals in header or cell text. */
const PAYMENT_OR_OPTION_SIGNAL = /계약금|중도금|잔금|옵션|유상|설치\s*품목/u;

/**
 * Member-profile / contact tables share a name-like column but are not 분양대금·옵션.
 * Only keep rows that look like payment or option tables.
 */
export function isEligibleSujainRow(row: SujainRawRow): boolean {
  const headers = row.headers ?? [];
  if (headers.some((header) => AMOUNT_LIKE_HEADER.test(header))) return true;
  if (headers.some((header) => OPTION_TABLE_HEADER.test(header))) return true;
  const joined = [...headers, ...row.cells].join(' ');
  return PAYMENT_OR_OPTION_SIGNAL.test(joined);
}

/** After filtering junk tables, zero readable payment/option items → fail honestly. */
export function isSujainUnsupportedLayout(result: SujainParseResult): boolean {
  return result.items.length === 0;
}

function digitsOnly(value: string): string | null {
  const cleaned = value.replace(/[,\s원]/gu, '');
  if (!/^(0|[1-9]\d{0,19})$/u.test(cleaned)) return null;
  return cleaned;
}

function parseDate(value: string): string | null {
  const matched = /(\d{4})[./-](\d{1,2})[./-](\d{1,2})/u.exec(value.trim());
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > maxDay) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function installmentNumber(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
}

/** '(\d+)\s*(차|회)' 에서 회차를 읽는다(계약금1차도 1). */
function installmentFromName(value: string): number | null {
  const matched = ROW_INSTALLMENT.exec(value);
  return matched ? installmentNumber(matched[1]) : null;
}

/** 옛 모양(회차 칸이 따로 있는 표): '2회'·'2차'·'2'. */
function installmentFromColumn(value: string): number | null {
  const fromName = installmentFromName(value);
  if (fromName !== null) return fromName;
  const bare = /^(\d{1,4})$/u.exec(value.trim());
  return bare ? installmentNumber(bare[1]) : null;
}

function kindFromRowName(rowName: string): ManualHousingPaymentKind | null {
  for (const entry of ROW_KIND_HINTS) {
    if (entry.pattern.test(rowName)) return entry.kind;
  }
  return null;
}

/** 여러 칸이 맞으면 패턴 목록에서 더 앞(더 구체적)인 쪽을 고른다. */
function headerIndex(headers: string[] | undefined, patterns: RegExp[]): number {
  if (!headers) return -1;
  let bestHeader = -1;
  let bestRank = patterns.length;
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i]!;
    for (let rank = 0; rank < patterns.length; rank += 1) {
      if (!patterns[rank]!.test(header)) continue;
      if (rank < bestRank) {
        bestRank = rank;
        bestHeader = i;
      }
      break;
    }
  }
  return bestHeader;
}

function cellAt(cells: string[], index: number): string {
  return index >= 0 && index < cells.length ? cells[index]!.trim() : '';
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * 품목 이름 목록을 최상위 쉼표로 나눈다. 대괄호·괄호 안 쉼표는 나누지 않는다.
 * 품목 사이는 ', '(쉼표 뒤 공백) 또는 ',[' 로 이어지고, '거실,침실1,2'처럼 공백 없이 붙은 쉼표는
 * 한 품목 안의 위치 나열이라 나누지 않는다(괄호 밖에 있어도). 같은 글자면 늘 같은 결과가 나온다.
 */
export function splitSujainOptionItems(value: string): string[] {
  const text = normalizeSpaces(value);
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '[' || ch === '(') depth += 1;
    else if ((ch === ']' || ch === ')') && depth > 0) depth -= 1;
    else if (ch === ',' && depth === 0) {
      const next = text[i + 1] ?? '';
      if (next === ' ' || next === '[' || next === '') {
        const part = text.slice(start, i).trim();
        if (part) items.push(part);
        start = i + 1;
      }
    }
  }
  const last = text.slice(start).trim();
  if (last) items.push(last);
  return items;
}

/**
 * 옵션 확인 항목 이름 '<짧은 제목> · <회차 이름>'(예 '발코니 확장 외 2 · 계약금').
 * matchFetchedItems 가 이름으로 맞추므로 같은 글자에서 늘 같은 이름이 나와야 한다.
 * 100자를 넘으면 첫 품목만 줄여 ' 외 N'·회차 이름이 잘리지 않게 한다.
 */
function optionLabel(itemLabel: string | undefined, rowName: string): { label: string; titled: boolean } {
  const items = splitSujainOptionItems(itemLabel ?? '');
  const name = rowName.slice(0, OPTION_ROW_NAME_MAX);
  const suffix = name ? ` · ${name}` : '';
  const more = items.length > 1 ? ` 외 ${items.length - 1}` : '';
  const head = items[0] ?? OPTION_TITLE_FALLBACK;
  const room = Math.max(1, OPTION_LABEL_MAX - suffix.length - more.length);
  const label = `${head.slice(0, room).trim()}${more}${suffix}`.slice(0, OPTION_LABEL_MAX).trim();
  return { label, titled: items.length > 0 };
}

type MoneyFields = Pick<
  HousingBrandFetchedItem,
  'scheduledAmount' | 'dueDate' | 'paidAmount' | 'paidDate' | 'actualPaidDate'
>;

/** 금액=약정금액, 예정일=약정일자, 낸 금액=납부원금, 납부일=납부일자(빈 칸이면 null). */
function readMoneyFields(row: SujainRawRow, kind: ManualHousingPaymentKind, note: Note): MoneyFields {
  // `/예정(?!일)/` — 납부예정일 같은 날짜 칸에 `/예정/`이 맞지 않게 한다.
  const amountIdx = headerIndex(row.headers, [/예정(?!일)/u, /약정금액/u, /금액/u, /분양가/u, /대금/u]);
  const dueIdx = headerIndex(row.headers, [/약정일/u, /예정일/u, /납부일/u, /납입일/u, /일자/u]);
  // 납부원금(원금)이 실납부금(연체료·할인료 반영)보다 앞선다.
  const paidIdx = headerIndex(row.headers, [/납부원금/u, /실납부금/u, /납부액/u, /납입액/u, /이미\s*낸/u, /수납(?!일)/u]);
  // Do not let `/실\s*납/` steal 실납부금 (paid amount). Prefer 납부일자 for paid date.
  const paidDateIdx = headerIndex(row.headers, [/납부일자/u, /실\s*납부일/u, /납부\s*완료/u, /수납일/u]);

  const fields: MoneyFields = {
    scheduledAmount: null,
    dueDate: null,
    paidAmount: null,
    paidDate: null,
    actualPaidDate: null,
  };

  if (amountIdx >= 0) {
    fields.scheduledAmount = digitsOnly(cellAt(row.cells, amountIdx));
    if (fields.scheduledAmount === null && cellAt(row.cells, amountIdx)) {
      note('scheduledAmount', '예정 금액 칸을 숫자로 읽지 못했어요.');
    }
  } else {
    // 헤더로 열을 알 수 있을 때만 채운다. 숫자처럼 보이는 칸을 추정하지 않는다.
    note(
      'scheduledAmount',
      row.sourcePage === 'unit-items'
        ? '세대 내 설치 품목에서 금액 칸 이름을 확인하지 못했어요.'
        : '분양대금조회 표에서 예정 금액 칸 이름을 확인하지 못했어요.',
    );
  }

  if (dueIdx >= 0) {
    fields.dueDate = parseDate(cellAt(row.cells, dueIdx));
    if (fields.dueDate === null && cellAt(row.cells, dueIdx)) note('dueDate', '납부 예정일 칸을 날짜로 읽지 못했어요.');
  } else if (kind !== 'option') {
    note('dueDate', '납부 예정일 칸 이름을 확인하지 못했어요.');
  }

  if (paidIdx >= 0) {
    fields.paidAmount = digitsOnly(cellAt(row.cells, paidIdx));
    if (fields.paidAmount === null && cellAt(row.cells, paidIdx)) note('paidAmount', '이미 낸 금액 칸을 숫자로 읽지 못했어요.');
  } else if (kind !== 'option') {
    note('paidAmount', '이미 낸 금액 칸 이름을 확인하지 못했어요.');
  }

  if (paidDateIdx >= 0) {
    fields.actualPaidDate = parseDate(cellAt(row.cells, paidDateIdx));
    fields.paidDate = fields.actualPaidDate;
    if (fields.actualPaidDate === null && cellAt(row.cells, paidDateIdx)) {
      note('actualPaidDate', '실제 납부일 칸을 날짜로 읽지 못했어요.');
    }
  }

  return fields;
}

/** 옛 러너의 세대 내 설치 품목 줄: 품목 칸 이름으로만 이름을 읽는다(첫 비숫자 칸을 추정하지 않는다). */
function legacyUnitItemLabel(row: SujainRawRow, scheduledAmount: string | null, note: Note): string | null {
  const nameIdx = headerIndex(row.headers, [/품목/u, /항목/u, /명칭/u, /이름/u]);
  const name = nameIdx >= 0 ? cellAt(row.cells, nameIdx) : '';
  const label = name ? name.slice(0, OPTION_LABEL_MAX) : null;
  if (!label && scheduledAmount === null) {
    note(
      'label',
      nameIdx < 0
        ? '옵션 이름 칸 이름을 확인하지 못했어요.'
        : '옵션 이름과 금액을 모두 읽지 못했어요.',
    );
  } else if (!label) {
    note(
      'label',
      nameIdx < 0
        ? '옵션 이름 칸 이름을 확인하지 못했어요.'
        : '옵션 이름 칸을 확인하지 못했어요. 합계만 둘 수 있어요.',
    );
  }
  return label;
}

/** 러너 행(합성 HTML·테스트 포함)을 확인 목록 항목으로 바꾼다. */
export function parseSujainRows(rows: SujainRawRow[]): SujainParseResult {
  const items: HousingBrandFetchedItem[] = [];
  const unreadReasons: string[] = [];
  let unreadCount = 0;
  let eligibleRowCount = 0;

  for (const row of rows.slice(0, 100)) {
    // Skip member-profile / contact / misc tables before kind detection so they
    // neither become options nor dominate unreadCount with kind notes.
    if (!isEligibleSujainRow(row)) continue;
    eligibleRowCount += 1;

    const unread: HousingBrandFetchedItem['unreadFields'] = [];
    const note: Note = (field, reason) => {
      unread.push({ field, reason });
      unreadCount += 1;
      unreadReasons.push(reason);
    };
    const push = (
      kind: ManualHousingPaymentKind,
      installment: number | null,
      label: string | null,
      money: MoneyFields,
    ) => {
      items.push({
        key: randomUUID(),
        kind,
        installment,
        label,
        ...money,
        matchedPaymentId: null,
        changedFields: [],
        unreadFields: unread,
      });
    };

    // 옛 러너: 세대 내 설치 품목 화면의 줄은 모두 옵션이다(호환 유지).
    if (row.sourcePage === 'unit-items') {
      const money = readMoneyFields(row, 'option', note);
      const label = legacyUnitItemLabel(row, money.scheduledAmount, note);
      push('option', null, label, money);
      continue;
    }

    const rowName = normalizeSpaces(row.cells[0] ?? '');
    if (TOTAL_ROW_NAME.test(rowName.replace(/\s+/gu, ''))) continue;

    // 별도 계약 품목: 줄 이름이 계약금·중도금·잔금이어도 아파트 일정이 아니라 옵션 대금이다.
    if (row.section === 'option') {
      const money = readMoneyFields(row, 'option', note);
      const { label, titled } = optionLabel(row.itemLabel, rowName);
      if (!titled) note('label', '별도 계약 품목 이름을 읽지 못했어요.');
      push('option', null, label, money);
      continue;
    }

    const kind = kindFromRowName(rowName);
    if (kind === null) {
      note('kind', '표에서 계약금·중도금·잔금·옵션 구분을 읽지 못했어요.');
      continue;
    }
    const money = readMoneyFields(row, kind, note);

    let installment: number | null = null;
    let label: string | null = null;
    if (kind === 'option') {
      label = legacyUnitItemLabel(row, money.scheduledAmount, note);
    } else {
      installment = installmentFromName(rowName);
      if (installment === null) {
        // 옛 모양: 회차 칸이 첫 칸이 아닌 따로 있는 표('2회').
        const installmentIdx = headerIndex(row.headers, [/회차/u, /차수/u]);
        if (installmentIdx > 0) installment = installmentFromColumn(cellAt(row.cells, installmentIdx));
      }
      if (kind === 'interim' && installment === null) note('installment', '중도금 회차를 읽지 못했어요.');
    }

    push(kind, installment, label, money);
  }

  return {
    items,
    unreadCount,
    unreadReasons: [...new Set(unreadReasons)].slice(0, 50),
    eligibleRowCount,
  };
}

/** 맞추기는 브랜드 무관이라 housing-brand-match.ts 로 옮겼다. 기존 import 경로를 지키려고 다시 내보낸다. */
export { matchFetchedItems } from './housing-brand-match';
