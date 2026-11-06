/**
 * 수자인 분양대금·옵션 표 해석. 칸 이름은 로그인 전이라 단정하지 않는다.
 * 모르는 칸은 비우고 이유를 남긴다. 없는 숫자는 추정하지 않는다.
 */
import { randomUUID } from 'node:crypto';
import type { HousingBrandFetchedItem, ManualHousingPaymentKind } from '@family/contracts';

export type SujainRawRow = {
  cells: string[];
  headers?: string[];
  sourcePage: 'payment' | 'unit-items';
};

export type SujainParseResult = {
  items: HousingBrandFetchedItem[];
  unreadCount: number;
  unreadReasons: string[];
};

const KIND_HINTS: Array<{ kind: ManualHousingPaymentKind; patterns: RegExp[] }> = [
  { kind: 'contract', patterns: [/계약금/u] },
  { kind: 'interim', patterns: [/중도금/u] },
  { kind: 'balance', patterns: [/잔금/u] },
  { kind: 'option', patterns: [/옵션/u, /설치\s*품목/u, /유상/u] },
];

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

function parseInstallment(value: string): number | null {
  const matched = /(\d{1,4})\s*회/u.exec(value) ?? /^(\d{1,4})$/u.exec(value.trim());
  if (!matched) return null;
  const n = Number(matched[1]);
  return n >= 1 && n <= 1000 ? n : null;
}

function detectKind(text: string, page: 'payment' | 'unit-items'): ManualHousingPaymentKind | null {
  if (page === 'unit-items') return 'option';
  for (const entry of KIND_HINTS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) return entry.kind;
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

/** 합성 HTML·테스트용 행을 확인 목록 항목으로 바꾼다. */
export function parseSujainRows(rows: SujainRawRow[]): SujainParseResult {
  const items: HousingBrandFetchedItem[] = [];
  const unreadReasons: string[] = [];
  let unreadCount = 0;

  for (const row of rows.slice(0, 100)) {
    const joined = [...(row.headers ?? []), ...row.cells].join(' ');
    const kind = detectKind(joined, row.sourcePage);
    const unread: HousingBrandFetchedItem['unreadFields'] = [];
    const note = (field: HousingBrandFetchedItem['unreadFields'][number]['field'], reason: string) => {
      unread.push({ field, reason });
      unreadCount += 1;
      unreadReasons.push(reason);
    };

    if (kind === null) {
      note('kind', '표에서 계약금·중도금·잔금·옵션 구분을 읽지 못했어요.');
      continue;
    }

    // `/예정(?!일)/` — 납부예정일 같은 날짜 칸에 `/예정/`이 맞지 않게 한다.
    const amountIdx = headerIndex(row.headers, [/예정(?!일)/u, /금액/u, /분양가/u, /대금/u]);
    const dueIdx = headerIndex(row.headers, [/예정일/u, /납부일/u, /납입일/u, /일자/u]);
    const paidIdx = headerIndex(row.headers, [/납부액/u, /납입액/u, /이미\s*낸/u, /수납/u]);
    const paidDateIdx = headerIndex(row.headers, [/실\s*납/u, /납부\s*완료/u, /수납일/u]);
    const installmentIdx = headerIndex(row.headers, [/회차/u, /차수/u]);
    const nameIdx = headerIndex(row.headers, [/품목/u, /항목/u, /명칭/u, /이름/u]);

    let scheduledAmount: string | null = null;
    let dueDate: string | null = null;
    let paidAmount: string | null = null;
    let paidDate: string | null = null;
    let actualPaidDate: string | null = null;
    let installment: number | null = null;
    let label: string | null = null;

    if (amountIdx >= 0) {
      scheduledAmount = digitsOnly(cellAt(row.cells, amountIdx));
      if (scheduledAmount === null && cellAt(row.cells, amountIdx)) {
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
      dueDate = parseDate(cellAt(row.cells, dueIdx));
      if (dueDate === null && cellAt(row.cells, dueIdx)) note('dueDate', '납부 예정일 칸을 날짜로 읽지 못했어요.');
    } else if (kind !== 'option') {
      note('dueDate', '납부 예정일 칸 이름을 확인하지 못했어요.');
    }

    if (paidIdx >= 0) {
      paidAmount = digitsOnly(cellAt(row.cells, paidIdx));
      if (paidAmount === null && cellAt(row.cells, paidIdx)) note('paidAmount', '이미 낸 금액 칸을 숫자로 읽지 못했어요.');
    } else if (kind !== 'option') {
      note('paidAmount', '이미 낸 금액 칸 이름을 확인하지 못했어요.');
    }

    if (paidDateIdx >= 0) {
      actualPaidDate = parseDate(cellAt(row.cells, paidDateIdx));
      paidDate = actualPaidDate;
      if (actualPaidDate === null && cellAt(row.cells, paidDateIdx)) {
        note('actualPaidDate', '실제 납부일 칸을 날짜로 읽지 못했어요.');
      }
    }

    if (kind === 'interim') {
      if (installmentIdx >= 0) installment = parseInstallment(cellAt(row.cells, installmentIdx));
      if (installment === null) installment = parseInstallment(joined);
      if (installment === null) note('installment', '중도금 회차를 읽지 못했어요.');
    }

    if (kind === 'option') {
      if (nameIdx >= 0) {
        const name = cellAt(row.cells, nameIdx);
        label = name ? name.slice(0, 100) : null;
      } else {
        // 헤더로 열을 알 수 있을 때만 채운다. 첫 비숫자 칸을 이름으로 추정하지 않는다.
        label = null;
      }
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
    }

    items.push({
      key: randomUUID(),
      kind,
      installment,
      label,
      scheduledAmount,
      dueDate,
      paidAmount,
      paidDate,
      actualPaidDate,
      matchedPaymentId: null,
      changedFields: [],
      unreadFields: unread,
    });
  }

  return {
    items,
    unreadCount,
    unreadReasons: [...new Set(unreadReasons)].slice(0, 50),
  };
}

/** 기존 일정과 맞춰 변경 칸만 남긴다. 같으면 목록에서 빼지 않고 changedFields만 비운다. */
export function matchFetchedItems(
  fetched: HousingBrandFetchedItem[],
  existing: Array<{
    id: string;
    kind: ManualHousingPaymentKind;
    installment: number | null;
    label: string | null;
    amount: string | null;
    dueDate: string | null;
    paidAmount: string | null;
    paidDate: string | null;
  }>,
): HousingBrandFetchedItem[] {
  const used = new Set<string>();
  return fetched.map((item) => {
    const match = existing.find((payment) => {
      if (used.has(payment.id)) return false;
      if (payment.kind !== item.kind) return false;
      if (item.kind === 'interim') return payment.installment === item.installment;
      if (item.kind === 'option') {
        if (item.label && payment.label) return payment.label === item.label;
        return payment.label == null && item.label == null && payment.amount === item.scheduledAmount;
      }
      return true;
    });
    if (!match) {
      const changedFields: HousingBrandFetchedItem['changedFields'] = [];
      if (item.scheduledAmount !== null) changedFields.push('scheduledAmount');
      if (item.dueDate !== null) changedFields.push('dueDate');
      if (item.paidAmount !== null) changedFields.push('paidAmount');
      if (item.paidDate !== null) changedFields.push('paidDate');
      if (item.actualPaidDate !== null) changedFields.push('actualPaidDate');
      if (item.label !== null) changedFields.push('label');
      if (item.installment !== null) changedFields.push('installment');
      return { ...item, matchedPaymentId: null, changedFields };
    }
    used.add(match.id);
    const changedFields: HousingBrandFetchedItem['changedFields'] = [];
    if (item.scheduledAmount !== null && item.scheduledAmount !== match.amount) changedFields.push('scheduledAmount');
    if (item.dueDate !== null && item.dueDate !== match.dueDate) changedFields.push('dueDate');
    if (item.paidAmount !== null && item.paidAmount !== match.paidAmount) changedFields.push('paidAmount');
    if (item.paidDate !== null && item.paidDate !== match.paidDate) changedFields.push('paidDate');
    if (item.actualPaidDate !== null && item.actualPaidDate !== match.paidDate) changedFields.push('actualPaidDate');
    if (item.label !== null && item.label !== match.label) changedFields.push('label');
    if (item.installment !== null && item.installment !== match.installment) changedFields.push('installment');
    return { ...item, matchedPaymentId: match.id, changedFields };
  }).filter((item) => item.matchedPaymentId === null || item.changedFields.length > 0);
}
