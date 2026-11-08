/**
 * 수자인 표 해석 골든(동작 고정). docs/architecture/housing-brand-adapters.md 6장의 모든 단계는
 * 이 파일을 고치지 않고 통과해야 한다 — 옵션 label 이 한 글자라도 바뀌면 이미 확정한 일정과
 * 이름이 어긋나 확인 목록에 중복 줄이 생긴다.
 * 기대값은 key(매번 새 uuid)만 빼고 전부 적는다. 파일 스냅샷은 쓰지 않는다. 값은 모두 합성이다.
 */
import { describe, expect, it } from 'vitest';
import type { HousingBrandFetchedItem } from '@family/contracts';
import { parseSujainRows, type SujainParseResult, type SujainRawRow } from './sujain-parse';

type GoldenResult = Omit<SujainParseResult, 'items'> & { items: Array<Omit<HousingBrandFetchedItem, 'key'>> };

const HEADERS = ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'];
const pay = (cells: string[]): SujainRawRow => ({ sourcePage: 'payment', section: 'payment', headers: HEADERS, cells });
const opt = (itemLabel: string, cells: string[]): SujainRawRow => ({
  sourcePage: 'payment', section: 'option', itemLabel, headers: HEADERS, cells,
});

/** sujain-parse.test.ts 의 liveRows() 와 같은 입력. */
const OPTION_A = '합성 발코니 확장, [합성벽체]-침실2.3 분리형, [합성공기청정기]-미선택';
const OPTION_B = '[합성에어컨]-거실,침실1,2,3(4개소)-합성전자, [합성가전]합성 냉장고';
const optionRows = (label: string, first: string) => [
  opt(label, [first, '2024-01-10', '100,000', '2024-01-10', '100,000', '0', '0', '100,000']),
  opt(label, ['중도금', '2025-01-10', '200,000', '', '0', '0', '0', '0']),
  opt(label, ['잔금', '2027-03-31', '700,000', '', '0', '0', '0', '0']),
  opt(label, ['계', '', '1,000,000', '', '100,000', '0', '0', '100,000']),
];
const liveRows = (): SujainRawRow[] => [
  pay(['계약금1차', '2024-01-10', '1,000,000', '2024-01-10', '1,000,000', '0', '0', '1,000,000']),
  pay(['계약금2차', '2024-02-10', '2,000,000', '2024-02-09', '2,000,000', '0', '0', '2,000,000']),
  ...[1, 2, 3, 4, 5, 6].map((n) => pay([
    `중도금${n}차`, `2024-0${n + 2}-15`, '3,000,000', `2024-0${n + 2}-14`, '3,000,000', '0', '0', '3,000,000',
  ])),
  pay(['잔금', '2027-03-31', '9,000,000', '', '0', '0', '0', '0']),
  pay(['계', '', '30,000,000', '', '21,000,000', '0', '0', '21,000,000']),
  ...optionRows(OPTION_A, '계약금'),
  ...optionRows(OPTION_B, '계약금1차'),
];

/**
 * 실제 분양대금조회 구조를 흉내 낸 표 3개(값은 모두 합성): 아파트 분양대금 1개 +
 * 별도 계약 품목 2개. 일부 납부·할인료·미납(빈 납부일자, 납부원금 0)을 섞는다.
 */
const threeTableRows = (): SujainRawRow[] => [
  pay(['계약금1차', '2023-05-20', '10,000,000', '2023-05-20', '10,000,000', '0', '0', '10,000,000']),
  pay(['계약금2차', '2023-06-20', '22,340,000', '2023-06-19', '22,340,000', '0', '0', '22,340,000']),
  pay(['중도금1차', '2024-01-25', '32,340,000', '2024-01-25', '32,340,000', '0', '0', '32,340,000']),
  pay(['중도금2차', '2024-06-25', '32,340,000', '2024-06-24', '32,340,000', '0', '0', '32,340,000']),
  pay(['중도금3차', '2025-01-27', '32,340,000', '2025-01-27', '32,340,000', '0', '12,000', '32,328,000']),
  pay(['중도금4차', '2025-07-25', '32,340,000', '', '0', '0', '0', '0']),
  pay(['중도금5차', '2026-01-26', '32,340,000', '', '0', '0', '0', '0']),
  pay(['중도금6차', '2026-07-27', '32,340,000', '', '0', '0', '0', '0']),
  pay(['잔금', '2027-02-26', '96,999,000', '', '0', '0', '0', '0']),
  pay(['계', '', '323,379,000', '', '129,360,000', '0', '12,000', '129,348,000']),
  opt('[합성가구]-주방 상판 교체, 합성 현관 중문, [합성조명]-거실(2개소)', ['계약금', '2023-05-20', '1,230,000', '2023-05-20', '1,230,000', '0', '0', '1,230,000']),
  opt('[합성가구]-주방 상판 교체, 합성 현관 중문, [합성조명]-거실(2개소)', ['중도금', '2024-12-20', '3,690,000', '', '0', '0', '0', '0']),
  opt('[합성가구]-주방 상판 교체, 합성 현관 중문, [합성조명]-거실(2개소)', ['잔금', '2027-02-26', '7,380,000', '', '0', '0', '0', '0']),
  opt('[합성가구]-주방 상판 교체, 합성 현관 중문, [합성조명]-거실(2개소)', ['계', '', '12,300,000', '', '1,230,000', '0', '0', '1,230,000']),
  opt('합성 시스템에어컨(3대)', ['계약금', '2023-05-20', '450,000', '2023-05-21', '450,000', '0', '0', '450,000']),
  opt('합성 시스템에어컨(3대)', ['중도금', '2025-05-20', '450,000', '2025-05-20', '450,000', '0', '0', '450,000']),
  opt('합성 시스템에어컨(3대)', ['잔금', '2027-02-26', '3,600,000', '', '0', '0', '0', '0']),
  opt('합성 시스템에어컨(3대)', ['계', '', '4,500,000', '', '900,000', '0', '0', '900,000']),
];

const contactRows = (sourcePage: SujainRawRow['sourcePage']): SujainRawRow[] => [
  { sourcePage, headers: ['항목', '내용'], cells: ['이름', '합성 회원'] },
  { sourcePage, headers: ['항목', '내용'], cells: ['휴대전화', '000-0000-0000'] },
  { sourcePage, headers: ['항목', '내용'], cells: ['주소', '합성 주소'] },
  { sourcePage, headers: ['항목', '내용'], cells: ['이메일', 'synthetic@example.com'] },
];

/**
 * sujain-parse.test.ts 의 parseSujainRows 입력 전부(이름은 원래 it 제목을 줄인 것).
 * liveRows().slice(0, n) 입력은 liveRows 의 앞부분이라 따로 두지 않는다.
 */
const FIXTURES: Array<{ name: string; rows: () => SujainRawRow[] }> = [
  {
    name: 'old runner: payment + unit-items rows together',
    rows: () => [
      { sourcePage: 'payment', headers: ['구분', '회차', '예정금액', '납부예정일', '납부액', '수납일'], cells: ['중도금', '2회', '10,000,000', '2026-12-01', '0', ''] },
      { sourcePage: 'payment', headers: ['구분', '회차', '예정금액', '납부예정일', '납부액', '수납일'], cells: ['잔금', '', '50,000,000', '2028-03-01', '', ''] },
      { sourcePage: 'unit-items', headers: ['품목', '금액'], cells: ['합성 옵션 A', '1,200,000'] },
    ],
  },
  { name: 'unknown payment columns stay empty with reasons', rows: () => [{ sourcePage: 'payment', headers: ['항목'], cells: ['계약금'] }] },
  { name: 'no headers: numeric-looking cells are not guessed', rows: () => [{ sourcePage: 'payment', cells: ['계약금', '12,000,000', '2026-05-01'] }] },
  { name: 'unit-items without a name header: label is not guessed', rows: () => [{ sourcePage: 'unit-items', headers: ['비고', '금액'], cells: ['합성 추정 금지 품목', '900,000'] }] },
  { name: 'more specific amount header wins', rows: () => [{ sourcePage: 'payment', headers: ['구분', '금액', '예정금액', '납부예정일'], cells: ['계약금', '1', '12,000,000', '2026-06-01'] }] },
  { name: 'date header before the amount header', rows: () => [{ sourcePage: 'payment', headers: ['구분', '납부예정일', '예정금액'], cells: ['계약금', '2026-06-01', '12,000,000'] }] },
  { name: 'old shape: installment column 1회', rows: () => [{ sourcePage: 'payment', headers: ['구분', '회차', '예정금액', '납부예정일', '납부액'], cells: ['중도금', '1회', '20,000,000', '2027-01-15', '5,000,000'] }] },
  { name: 'old shape: contract without installment', rows: () => [{ sourcePage: 'payment', headers: ['구분', '예정금액', '납부예정일', '납부액'], cells: ['계약금', '1000', '2026-01-01', '1000'] }] },
  { name: 'unit-items option with an unreadable amount', rows: () => [{ sourcePage: 'unit-items', headers: ['품목', '비고'], cells: ['합성 옵션 라벨', ''] }] },
  { name: 'unit-items contact table is skipped', rows: () => contactRows('unit-items') },
  { name: 'unit-items option table 품목·금액', rows: () => [{ sourcePage: 'unit-items', headers: ['품목', '금액'], cells: ['합성 항목 A', '500,000'] }] },
  { name: 'payment contact table is skipped', rows: () => contactRows('payment') },
  {
    name: 'junk-only rows (unsupported layout)',
    rows: () => [
      { sourcePage: 'payment', headers: ['이름'], cells: ['합성 회원'] },
      { sourcePage: 'unit-items', headers: ['항목', '내용'], cells: ['이메일', 'synthetic@example.com'] },
    ],
  },
  { name: 'readable option scrape', rows: () => [{ sourcePage: 'unit-items', headers: ['품목', '금액'], cells: ['합성 항목 A', '1'] }] },
  { name: 'live headers without section: 계약금', rows: () => [{ sourcePage: 'payment', headers: HEADERS, cells: ['계약금', '2026-06-01', '10,000,000', '2026-06-02', '9,000,000', '0', '0', '9,000,000'] }] },
  { name: 'live headers: bare 회차 number is not a kind', rows: () => [{ sourcePage: 'payment', headers: HEADERS, cells: ['1', '2026-06-01', '10,000,000', '2026-06-02', '9,000,000', '0', '0', '9,000,000'] }] },
  { name: '이름* contact row is ineligible', rows: () => [{ sourcePage: 'payment', headers: ['이름*'], cells: ['합성 회원'] }] },
  { name: 'confirmed tables: liveRows()', rows: liveRows },
  { name: 'option label capped at 100 characters', rows: () => [opt(`${'가'.repeat(150)}, 합성 둘째`, ['계약금', '2024-01-10', '100,000', '', '0', '0', '0', '0'])] },
  { name: 'option without an item list uses the generic title', rows: () => [{ sourcePage: 'payment', section: 'option', headers: HEADERS, cells: ['잔금', '2027-03-31', '700,000', '', '0', '0', '0', '0'] }] },
  { name: 'old runner mixed a row name into the headers', rows: () => [{ sourcePage: 'payment', headers: [...HEADERS, '계약금1차'], cells: ['중도금3차', '2024-05-15', '3,000,000', '2024-05-14', '3,000,000', '0', '0', '3,000,000'] }] },
  { name: 'row without section is an apartment payment', rows: () => [{ sourcePage: 'payment', headers: HEADERS, cells: ['잔금', '2027-03-31', '9,000,000', '', '0', '0', '0', '0'] }] },
  { name: 'synthetic three tables: apartment + two 별도 계약 품목', rows: threeTableRows },
];

const EXPECTED: Record<string, GoldenResult> = {
  'old runner: payment + unit-items rows together': {
    items: [
      {
        kind: 'interim', installment: 2, label: null, scheduledAmount: '10000000', dueDate: '2026-12-01',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
      {
        kind: 'balance', installment: null, label: null, scheduledAmount: '50000000', dueDate: '2028-03-01',
        paidAmount: null, paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '합성 옵션 A', scheduledAmount: '1200000', dueDate: null,
        paidAmount: null, paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 3,
  },
  'unknown payment columns stay empty with reasons': {
    items: [
      {
        kind: 'contract', installment: null, label: null, scheduledAmount: null, dueDate: null, paidAmount: null,
        paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [
          { field: 'scheduledAmount', reason: '분양대금조회 표에서 예정 금액 칸 이름을 확인하지 못했어요.' },
          { field: 'dueDate', reason: '납부 예정일 칸 이름을 확인하지 못했어요.' },
          { field: 'paidAmount', reason: '이미 낸 금액 칸 이름을 확인하지 못했어요.' },
        ],
      },
    ],
    unreadCount: 3,
    unreadReasons: ['분양대금조회 표에서 예정 금액 칸 이름을 확인하지 못했어요.', '납부 예정일 칸 이름을 확인하지 못했어요.', '이미 낸 금액 칸 이름을 확인하지 못했어요.'],
    eligibleRowCount: 1,
  },
  'no headers: numeric-looking cells are not guessed': {
    items: [
      {
        kind: 'contract', installment: null, label: null, scheduledAmount: null, dueDate: null, paidAmount: null,
        paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [
          { field: 'scheduledAmount', reason: '분양대금조회 표에서 예정 금액 칸 이름을 확인하지 못했어요.' },
          { field: 'dueDate', reason: '납부 예정일 칸 이름을 확인하지 못했어요.' },
          { field: 'paidAmount', reason: '이미 낸 금액 칸 이름을 확인하지 못했어요.' },
        ],
      },
    ],
    unreadCount: 3,
    unreadReasons: ['분양대금조회 표에서 예정 금액 칸 이름을 확인하지 못했어요.', '납부 예정일 칸 이름을 확인하지 못했어요.', '이미 낸 금액 칸 이름을 확인하지 못했어요.'],
    eligibleRowCount: 1,
  },
  'unit-items without a name header: label is not guessed': {
    items: [
      {
        kind: 'option', installment: null, label: null, scheduledAmount: '900000', dueDate: null, paidAmount: null,
        paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [{ field: 'label', reason: '옵션 이름 칸 이름을 확인하지 못했어요.' }],
      },
    ],
    unreadCount: 1, unreadReasons: ['옵션 이름 칸 이름을 확인하지 못했어요.'], eligibleRowCount: 1,
  },
  'more specific amount header wins': {
    items: [
      {
        kind: 'contract', installment: null, label: null, scheduledAmount: '12000000', dueDate: '2026-06-01',
        paidAmount: null, paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [{ field: 'paidAmount', reason: '이미 낸 금액 칸 이름을 확인하지 못했어요.' }],
      },
    ],
    unreadCount: 1, unreadReasons: ['이미 낸 금액 칸 이름을 확인하지 못했어요.'], eligibleRowCount: 1,
  },
  'date header before the amount header': {
    items: [
      {
        kind: 'contract', installment: null, label: null, scheduledAmount: '12000000', dueDate: '2026-06-01',
        paidAmount: null, paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [{ field: 'paidAmount', reason: '이미 낸 금액 칸 이름을 확인하지 못했어요.' }],
      },
    ],
    unreadCount: 1, unreadReasons: ['이미 낸 금액 칸 이름을 확인하지 못했어요.'], eligibleRowCount: 1,
  },
  'old shape: installment column 1회': {
    items: [
      {
        kind: 'interim', installment: 1, label: null, scheduledAmount: '20000000', dueDate: '2027-01-15',
        paidAmount: '5000000', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'old shape: contract without installment': {
    items: [
      {
        kind: 'contract', installment: null, label: null, scheduledAmount: '1000', dueDate: '2026-01-01',
        paidAmount: '1000', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'unit-items option with an unreadable amount': {
    items: [
      {
        kind: 'option', installment: null, label: '합성 옵션 라벨', scheduledAmount: null, dueDate: null, paidAmount: null,
        paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [{ field: 'scheduledAmount', reason: '세대 내 설치 품목에서 금액 칸 이름을 확인하지 못했어요.' }],
      },
    ],
    unreadCount: 1, unreadReasons: ['세대 내 설치 품목에서 금액 칸 이름을 확인하지 못했어요.'], eligibleRowCount: 1,
  },
  'unit-items contact table is skipped': { items: [], unreadCount: 0, unreadReasons: [], eligibleRowCount: 0 },
  'unit-items option table 품목·금액': {
    items: [
      {
        kind: 'option', installment: null, label: '합성 항목 A', scheduledAmount: '500000', dueDate: null,
        paidAmount: null, paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'payment contact table is skipped': { items: [], unreadCount: 0, unreadReasons: [], eligibleRowCount: 0 },
  'junk-only rows (unsupported layout)': { items: [], unreadCount: 0, unreadReasons: [], eligibleRowCount: 0 },
  'readable option scrape': {
    items: [
      {
        kind: 'option', installment: null, label: '합성 항목 A', scheduledAmount: '1', dueDate: null, paidAmount: null,
        paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [], unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'live headers without section: 계약금': {
    items: [
      {
        kind: 'contract', installment: null, label: null, scheduledAmount: '10000000', dueDate: '2026-06-01',
        paidAmount: '9000000', paidDate: '2026-06-02', actualPaidDate: '2026-06-02', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'live headers: bare 회차 number is not a kind': { items: [], unreadCount: 1, unreadReasons: ['표에서 계약금·중도금·잔금·옵션 구분을 읽지 못했어요.'], eligibleRowCount: 1 },
  '이름* contact row is ineligible': { items: [], unreadCount: 0, unreadReasons: [], eligibleRowCount: 0 },
  'confirmed tables: liveRows()': {
    items: [
      {
        kind: 'contract', installment: 1, label: null, scheduledAmount: '1000000', dueDate: '2024-01-10',
        paidAmount: '1000000', paidDate: '2024-01-10', actualPaidDate: '2024-01-10', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'contract', installment: 2, label: null, scheduledAmount: '2000000', dueDate: '2024-02-10',
        paidAmount: '2000000', paidDate: '2024-02-09', actualPaidDate: '2024-02-09', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 1, label: null, scheduledAmount: '3000000', dueDate: '2024-03-15',
        paidAmount: '3000000', paidDate: '2024-03-14', actualPaidDate: '2024-03-14', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 2, label: null, scheduledAmount: '3000000', dueDate: '2024-04-15',
        paidAmount: '3000000', paidDate: '2024-04-14', actualPaidDate: '2024-04-14', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 3, label: null, scheduledAmount: '3000000', dueDate: '2024-05-15',
        paidAmount: '3000000', paidDate: '2024-05-14', actualPaidDate: '2024-05-14', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 4, label: null, scheduledAmount: '3000000', dueDate: '2024-06-15',
        paidAmount: '3000000', paidDate: '2024-06-14', actualPaidDate: '2024-06-14', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 5, label: null, scheduledAmount: '3000000', dueDate: '2024-07-15',
        paidAmount: '3000000', paidDate: '2024-07-14', actualPaidDate: '2024-07-14', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 6, label: null, scheduledAmount: '3000000', dueDate: '2024-08-15',
        paidAmount: '3000000', paidDate: '2024-08-14', actualPaidDate: '2024-08-14', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'balance', installment: null, label: null, scheduledAmount: '9000000', dueDate: '2027-03-31',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '합성 발코니 확장 외 2 · 계약금', scheduledAmount: '100000',
        dueDate: '2024-01-10', paidAmount: '100000', paidDate: '2024-01-10', actualPaidDate: '2024-01-10',
        matchedPaymentId: null, changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '합성 발코니 확장 외 2 · 중도금', scheduledAmount: '200000',
        dueDate: '2025-01-10', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '합성 발코니 확장 외 2 · 잔금', scheduledAmount: '700000',
        dueDate: '2027-03-31', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '[합성에어컨]-거실,침실1,2,3(4개소)-합성전자 외 1 · 계약금1차',
        scheduledAmount: '100000', dueDate: '2024-01-10', paidAmount: '100000', paidDate: '2024-01-10',
        actualPaidDate: '2024-01-10', matchedPaymentId: null, changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '[합성에어컨]-거실,침실1,2,3(4개소)-합성전자 외 1 · 중도금', scheduledAmount: '200000',
        dueDate: '2025-01-10', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '[합성에어컨]-거실,침실1,2,3(4개소)-합성전자 외 1 · 잔금', scheduledAmount: '700000',
        dueDate: '2027-03-31', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 18,
  },
  'option label capped at 100 characters': {
    items: [
      {
        kind: 'option', installment: null, label: `${'가'.repeat(90)} 외 1 · 계약금`, scheduledAmount: '100000',
        dueDate: '2024-01-10', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'option without an item list uses the generic title': {
    items: [
      {
        kind: 'option', installment: null, label: '별도 계약 품목 · 잔금', scheduledAmount: '700000', dueDate: '2027-03-31',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [{ field: 'label', reason: '별도 계약 품목 이름을 읽지 못했어요.' }],
      },
    ],
    unreadCount: 1, unreadReasons: ['별도 계약 품목 이름을 읽지 못했어요.'], eligibleRowCount: 1,
  },
  'old runner mixed a row name into the headers': {
    items: [
      {
        kind: 'interim', installment: 3, label: null, scheduledAmount: '3000000', dueDate: '2024-05-15',
        paidAmount: '3000000', paidDate: '2024-05-14', actualPaidDate: '2024-05-14', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'row without section is an apartment payment': {
    items: [
      {
        kind: 'balance', installment: null, label: null, scheduledAmount: '9000000', dueDate: '2027-03-31',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 1,
  },
  'synthetic three tables: apartment + two 별도 계약 품목': {
    items: [
      {
        kind: 'contract', installment: 1, label: null, scheduledAmount: '10000000', dueDate: '2023-05-20',
        paidAmount: '10000000', paidDate: '2023-05-20', actualPaidDate: '2023-05-20', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'contract', installment: 2, label: null, scheduledAmount: '22340000', dueDate: '2023-06-20',
        paidAmount: '22340000', paidDate: '2023-06-19', actualPaidDate: '2023-06-19', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 1, label: null, scheduledAmount: '32340000', dueDate: '2024-01-25',
        paidAmount: '32340000', paidDate: '2024-01-25', actualPaidDate: '2024-01-25', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 2, label: null, scheduledAmount: '32340000', dueDate: '2024-06-25',
        paidAmount: '32340000', paidDate: '2024-06-24', actualPaidDate: '2024-06-24', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 3, label: null, scheduledAmount: '32340000', dueDate: '2025-01-27',
        paidAmount: '32340000', paidDate: '2025-01-27', actualPaidDate: '2025-01-27', matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'interim', installment: 4, label: null, scheduledAmount: '32340000', dueDate: '2025-07-25',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
      {
        kind: 'interim', installment: 5, label: null, scheduledAmount: '32340000', dueDate: '2026-01-26',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
      {
        kind: 'interim', installment: 6, label: null, scheduledAmount: '32340000', dueDate: '2026-07-27',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
      {
        kind: 'balance', installment: null, label: null, scheduledAmount: '96999000', dueDate: '2027-02-26',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null, changedFields: [],
        unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '[합성가구]-주방 상판 교체 외 2 · 계약금', scheduledAmount: '1230000',
        dueDate: '2023-05-20', paidAmount: '1230000', paidDate: '2023-05-20', actualPaidDate: '2023-05-20',
        matchedPaymentId: null, changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '[합성가구]-주방 상판 교체 외 2 · 중도금', scheduledAmount: '3690000',
        dueDate: '2024-12-20', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '[합성가구]-주방 상판 교체 외 2 · 잔금', scheduledAmount: '7380000',
        dueDate: '2027-02-26', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '합성 시스템에어컨(3대) · 계약금', scheduledAmount: '450000',
        dueDate: '2023-05-20', paidAmount: '450000', paidDate: '2023-05-21', actualPaidDate: '2023-05-21',
        matchedPaymentId: null, changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '합성 시스템에어컨(3대) · 중도금', scheduledAmount: '450000',
        dueDate: '2025-05-20', paidAmount: '450000', paidDate: '2025-05-20', actualPaidDate: '2025-05-20',
        matchedPaymentId: null, changedFields: [], unreadFields: [],
      },
      {
        kind: 'option', installment: null, label: '합성 시스템에어컨(3대) · 잔금', scheduledAmount: '3600000',
        dueDate: '2027-02-26', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: [], unreadFields: [],
      },
    ],
    unreadCount: 0, unreadReasons: [], eligibleRowCount: 18,
  },
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ITEM_KEY_ORDER = [
  'key', 'kind', 'installment', 'label', 'scheduledAmount', 'dueDate', 'paidAmount', 'paidDate', 'actualPaidDate',
  'matchedPaymentId', 'changedFields', 'unreadFields',
];

function withoutKeys(result: SujainParseResult): GoldenResult {
  return {
    ...result,
    items: result.items.map(({ key, ...rest }) => {
      expect(key).toMatch(UUID_V4);
      return rest;
    }),
  };
}

describe('sujain parse golden (synthetic only)', () => {
  it('has exactly one expected result per fixture', () => {
    expect(Object.keys(EXPECTED)).toEqual(FIXTURES.map((fixture) => fixture.name));
  });

  it.each(FIXTURES)('$name', ({ name, rows }) => {
    const input = rows();
    const before = JSON.stringify(input);
    const actual = withoutKeys(parseSujainRows(input));
    expect(actual).toEqual(EXPECTED[name]);
    // 키 순서까지 같아야 미리보기 와이어 JSON 이 바이트 단위로 같다.
    expect(JSON.stringify(actual)).toBe(JSON.stringify(EXPECTED[name]));
    // 입력 행을 고치지 않는다.
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps the item key order and issues a fresh key per item and per call', () => {
    const first = parseSujainRows(threeTableRows()).items;
    const second = parseSujainRows(threeTableRows()).items;
    for (const item of first) expect(Object.keys(item)).toEqual(ITEM_KEY_ORDER);
    const keys = [...first, ...second].map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
