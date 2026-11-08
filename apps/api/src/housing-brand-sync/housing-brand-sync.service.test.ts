/**
 * 주택 브랜드 연동 서비스 특성 테스트(동작 고정). docs/architecture/housing-brand-adapters.md 0단계.
 * 이후 단계(어댑터·registry 도입)가 바꾸면 안 되는 것만 단언한다:
 * - 금고 AAD(provider 'sujain')·평문 brand·login_fingerprint(sha256('sujain:'+소문자 아이디))
 * - 미리보기 와이어 JSON(source 'sujain_fetch'·items·unreadCount·unreadReasons·status)과 실패 문구·상태
 * - 재연결이 lastPreview 를 비우지 않는 현재 동작
 * DB 는 호출 순서대로 결과를 돌려주는 더블이다(PostgreSQL 잠금은 검증하지 않는다). 값은 모두 합성이다.
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HousingBrandConnectRequest, HousingBrandStoredPreview } from '@family/contracts';
import { schema, type Db } from '@family/database';
import { FinanceVault, type VaultContext } from '../finance-connections/finance-vault';
import { HousingBrandSyncService, publicErrorMessage } from './housing-brand-sync.service';
import { HousingBrandRegistry } from './brand-registry';
import { SujainAdapter } from './sujain-adapter';
import { SujainBrowserClient, SujainBrowserError } from './sujain-browser';
import type { SujainRawRow } from './sujain-parse';

const H = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const M = '55555555-5555-4555-8555-555555555555';
const OTHER_USER = '66666666-6666-4666-8666-666666666666';
const PAY_CONTRACT = '77777777-7777-4777-8777-777777777771';
const PAY_INTERIM = '77777777-7777-4777-8777-777777777772';
const PAY_OPTION = '77777777-7777-4777-8777-777777777773';
const NOW = Date.parse('2026-11-08T03:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
/** 대문자를 섞어 지문이 소문자 아이디로 만들어지는지 본다. */
const LOGIN_ID = 'Synthetic.User';
const PASSWORD = 'x'.repeat(16);
/** sha256('sujain:synthetic.user') — 기존 행의 login_fingerprint 와 같은 공식. 영구 고정. */
const SUJAIN_LOGIN_FINGERPRINT = '0fc9b692946bd675c755c96e33611f20cd578a50e47a8ec2ef0b7127b0111cff';
const VAULT_KEY = 'ab'.repeat(32);
const CAPTURED_AT = '2026-11-08T12:34:56+09:00';
const FETCHED_AT = '2026-11-08T03:34:56.000Z';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 기존 봉투의 AAD 를 만드는 context. 브랜드를 일반화해도 수자인은 이 값 그대로여야 재암호화가 필요 없다. */
const sujainContext = (connectionId: string): VaultContext => ({
  ownerUserId: U, provider: 'sujain', connectionId, purpose: 'credentials',
});

type ConnectionRow = typeof schema.housingBrandConnections.$inferSelect;
type PlanRow = typeof schema.manualHousingPlans.$inferSelect;
type PaymentRow = typeof schema.manualHousingPayments.$inferSelect;

function vault(enabled = true): FinanceVault {
  return new FinanceVault({
    get: (name: string) => (name === 'financeConnections'
      ? { enabled, activeKeyVersion: 1, keyring: { '1': VAULT_KEY } }
      : undefined),
  } as unknown as ConfigService);
}

function planRow(change: Partial<PlanRow> = {}): PlanRow {
  return {
    id: P, householdId: H, ownerUserId: U, label: '합성 신축 주택', visibility: 'private', occupancyYear: 2027,
    contractStage: null, fundingNote: null, version: 5, creationPayloadHash: 'c'.repeat(64),
    createdAt: new Date(NOW - 9_000_000), updatedAt: new Date(NOW - 9_000_000), deletedAt: null, ...change,
  };
}

function connectionRow(change: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: C, planId: P, householdId: H, ownerUserId: U, brand: 'sujain', loginFingerprint: SUJAIN_LOGIN_FINGERPRINT,
    credentials: vault().encrypt({ loginId: LOGIN_ID, password: PASSWORD, brand: 'sujain' }, sujainContext(C)),
    status: 'connected', statusMessage: null, version: 3, lastFetchAt: null, lastSuccessAt: null, lastPreview: null,
    createdAt: new Date(NOW - 5_000_000), updatedAt: new Date(NOW - 5_000_000), disconnectedAt: null, ...change,
  };
}

function paymentRow(change: Partial<PaymentRow> & Pick<PaymentRow, 'id' | 'kind'>): PaymentRow {
  return {
    planId: P, position: 0, installment: null, label: null, dueDate: null, amount: null, amountSource: null,
    amountAsOfAt: null, paidAmount: null, paidAmountSource: null, paidAmountAsOfAt: null, paidDate: null, ...change,
  };
}

const member = () => [{ id: M, role: 'owner' as const }];

type Step = unknown[] | ((values: unknown) => unknown[]);
type Recorded = { scope: string; operation: string; table?: string; values?: unknown; where?: SQL };

/**
 * 트랜잭션마다 쿼리 결과를 순서대로 돌려준다. 함수 단계는 insert/update 에 넘긴 값을 받아
 * returning 행을 만든다. markFailure 처럼 트랜잭션 밖 this.db.update 는 direct 순서로 받는다.
 */
function database(transactions: Step[][], direct: Step[] = []) {
  const calls: Recorded[] = [];
  const pendingTransactions = [...transactions];
  const pendingDirect = [...direct];
  function builder(scope: string, steps: Step[], operation: string, table?: Table) {
    const call: Recorded = { scope, operation, table: table ? getTableName(table) : undefined };
    const chain = {
      from(value: Table) { call.table = getTableName(value); return chain; },
      innerJoin() { return chain; },
      where(value: SQL) { call.where = value; return chain; },
      for() { return chain; },
      limit() { return chain; },
      orderBy() { return chain; },
      values(value: unknown) { call.values = value; return chain; },
      set(value: unknown) { call.values = value; return chain; },
      returning() { return chain; },
      then(resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) {
        calls.push(call);
        const step = steps.shift();
        if (step === undefined) {
          return Promise.reject(new Error(`unexpected synthetic ${operation}`)).then(resolve, reject);
        }
        return Promise.resolve(typeof step === 'function' ? step(call.values) : step).then(resolve, reject);
      },
    };
    return chain;
  }
  const executor = (scope: string, steps: Step[]) => ({
    select: () => builder(scope, steps, 'select'),
    insert: (table: Table) => builder(scope, steps, 'insert', table),
    update: (table: Table) => builder(scope, steps, 'update', table),
    delete: (table: Table) => builder(scope, steps, 'delete', table),
  });
  let transactionCount = 0;
  const db = {
    async transaction(run: (tx: unknown) => Promise<unknown>) {
      const steps = pendingTransactions.shift();
      if (!steps) throw new Error('unexpected synthetic transaction');
      transactionCount += 1;
      const result = await run(executor(`tx${transactionCount}`, steps));
      if (steps.length) throw new Error('unused synthetic queries');
      return result;
    },
    ...executor('db', pendingDirect),
  } as unknown as Db;
  return { db, calls, unused: () => pendingTransactions.length + pendingDirect.length };
}

type ReadOutcome = { rows?: SujainRawRow[]; capturedAt?: string; error?: unknown };

/** 가짜 SujainBrowserClient. 표 해석은 실제 클라이언트의 parseRows 를 그대로 쓴다. */
function fakeBrowser(outcome: ReadOutcome) {
  const seen: Array<{ loginId: string; password: string }> = [];
  const passed: Array<{ loginId: string; password: string }> = [];
  const signals: AbortSignal[] = [];
  const browser = {
    configured: true,
    available: true,
    read: vi.fn(async (credentials: { loginId: string; password: string }, signal: AbortSignal) => {
      seen.push({ loginId: credentials.loginId, password: credentials.password });
      passed.push(credentials);
      signals.push(signal);
      if (outcome.error !== undefined) throw outcome.error;
      return { capturedAt: outcome.capturedAt ?? CAPTURED_AT, rows: outcome.rows ?? [] };
    }),
    parseRows: SujainBrowserClient.prototype.parseRows,
  };
  return { browser, seen, passed, signals };
}

/** 서비스 조립은 여기 한 곳에서만 한다. */
function setup(transactions: Step[][], options: { direct?: Step[]; read?: ReadOutcome; vaultEnabled?: boolean } = {}) {
  const database_ = database(transactions, options.direct);
  const instance = vault(options.vaultEnabled ?? true);
  const encrypt = vi.spyOn(instance, 'encrypt');
  const decrypt = vi.spyOn(instance, 'decrypt');
  const fake = fakeBrowser(options.read ?? {});
  // 조립만 등록표 경유로 바꿨다(2단계) — 단언은 0단계 그대로다. 운영 DI 와 같은 경로(등록표 → 수자인 어댑터 → 클라이언트)를 탄다.
  const service = new HousingBrandSyncService(
    database_.db,
    instance,
    new HousingBrandRegistry(new SujainAdapter(fake.browser as unknown as SujainBrowserClient)),
  );
  return { ...database_, ...fake, service, encrypt, decrypt };
}

const connectRequest = (change: Partial<HousingBrandConnectRequest> = {}): HousingBrandConnectRequest => ({
  householdId: H, brand: 'sujain', loginId: LOGIN_ID, password: PASSWORD, expectedPlanVersion: 5, ...change,
});
const syncRequest = { householdId: H, expectedConnectionVersion: 3 };

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected rejection');
}

/** 와이어 JSON 은 키 순서까지 같아야 한다. */
function expectWire(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('connect: brand, fingerprint and vault binding', () => {
  it('fingerprint constant is sha256 of "sujain:" + lowercased login id', () => {
    expect(createHash('sha256').update(`sujain:${LOGIN_ID.toLowerCase()}`).digest('hex')).toBe(SUJAIN_LOGIN_FINGERPRINT);
  });

  it('new connection stores brand sujain, the legacy fingerprint and a sujain-bound envelope', async () => {
    const test = setup([[
      member(), [planRow()], [],
      (values) => [{ lastFetchAt: null, lastSuccessAt: null, lastPreview: null, disconnectedAt: null, ...(values as object) }],
    ]]);
    const response = await test.service.connect(U, P, connectRequest());

    const insert = test.calls.find((call) => call.operation === 'insert')!;
    expect(insert.table).toBe('housing_brand_connections');
    const values = insert.values as ConnectionRow;
    expect(values.id).toMatch(UUID_V4);
    expect(Object.keys(values)).toEqual([
      'id', 'planId', 'householdId', 'ownerUserId', 'brand', 'loginFingerprint', 'credentials', 'status',
      'statusMessage', 'version', 'createdAt', 'updatedAt',
    ]);
    expect(values).toEqual({
      id: values.id, planId: P, householdId: H, ownerUserId: U, brand: 'sujain',
      loginFingerprint: SUJAIN_LOGIN_FINGERPRINT, credentials: values.credentials, status: 'connected',
      statusMessage: null, version: 1, createdAt: new Date(NOW), updatedAt: new Date(NOW),
    });

    // 금고: 평문은 { loginId, password, brand:'sujain' }, context 는 provider 'sujain'.
    expect(test.encrypt).toHaveBeenCalledTimes(1);
    const [plaintext, context] = test.encrypt.mock.calls[0]!;
    expect(Object.keys(plaintext as object)).toEqual(['loginId', 'password', 'brand']);
    expect(plaintext).toEqual({ loginId: LOGIN_ID, password: PASSWORD, brand: 'sujain' });
    expect(context).toEqual(sujainContext(values.id));
    // 따로 만든 금고 + 옛 context 로 열린다(재암호화 없이 읽힌다).
    expect(vault().decrypt(values.credentials!, sujainContext(values.id)))
      .toEqual({ loginId: LOGIN_ID, password: PASSWORD, brand: 'sujain' });
    expect(JSON.stringify(values.credentials)).not.toContain(PASSWORD);
    expect(JSON.stringify(values.credentials)).not.toContain(LOGIN_ID);

    expectWire(response, {
      connection: {
        id: values.id, planId: P, brand: 'sujain', status: 'connected', statusMessage: null, credentialsStored: true,
        version: 1, lastFetchAt: null, lastSuccessAt: null, canManage: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain(PASSWORD);
    expect(test.unused()).toBe(0);
  });

  it('reconnect on the same plan rebinds the existing id and keeps lastPreview (current behavior)', async () => {
    const storedPreview: HousingBrandStoredPreview = { fetchedAt: '2026-11-01T00:00:00.000Z', items: [] };
    const existing = connectionRow({
      status: 'needs_confirmation', statusMessage: '가져온 납부·옵션을 확인한 뒤 반영할 항목을 골라 주세요.',
      lastFetchAt: new Date('2026-11-01T00:00:00.000Z'), lastSuccessAt: new Date('2026-11-01T00:00:00.000Z'),
      lastPreview: storedPreview,
    });
    const test = setup([[member(), [planRow()], [existing], (values) => [{ ...existing, ...(values as object) }]]]);
    const response = await test.service.connect(U, P, connectRequest({ loginId: 'synthetic.user' }));

    const update = test.calls.find((call) => call.operation === 'update')!;
    expect(update.table).toBe('housing_brand_connections');
    const values = update.values as Partial<ConnectionRow>;
    expect(Object.keys(values)).toEqual([
      'brand', 'loginFingerprint', 'credentials', 'status', 'statusMessage', 'version', 'updatedAt', 'disconnectedAt',
    ]);
    expect(values).toEqual({
      brand: 'sujain', loginFingerprint: SUJAIN_LOGIN_FINGERPRINT, credentials: values.credentials,
      status: 'connected', statusMessage: null, version: 4, updatedAt: new Date(NOW), disconnectedAt: null,
    });
    // 지금은 재연결이 미리보기를 비우지 않는다(브랜드 전환 시 비우기는 두 번째 브랜드 때).
    expect(values).not.toHaveProperty('lastPreview');
    expect(test.encrypt.mock.calls[0]![1]).toEqual(sujainContext(C));
    expect(vault().decrypt(values.credentials!, sujainContext(C)))
      .toEqual({ loginId: 'synthetic.user', password: PASSWORD, brand: 'sujain' });

    expectWire(response, {
      connection: {
        id: C, planId: P, brand: 'sujain', status: 'connected', statusMessage: null, credentialsStored: true,
        version: 4, lastFetchAt: '2026-11-01T00:00:00.000Z', lastSuccessAt: '2026-11-01T00:00:00.000Z', canManage: true,
      },
    });
  });

  it('another member\'s active connection on the plan is forbidden before encrypting', async () => {
    const test = setup([[member(), [planRow()], [connectionRow({ ownerUserId: OTHER_USER })]]]);
    await expect(test.service.connect(U, P, connectRequest())).rejects.toBeInstanceOf(ForbiddenException);
    expect(test.encrypt).not.toHaveBeenCalled();
  });

  it('a disabled vault refuses before any query', async () => {
    const test = setup([], { vaultEnabled: false });
    const error = await rejection(test.service.connect(U, P, connectRequest()));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toEqual({ message: '신축 조회 금고가 준비되지 않았어요.', error: 'Bad Request', statusCode: 400 });
    expect(test.calls).toEqual([]);
  });
});

describe('sync: preview, empty result and failure copy', () => {
  const HEADERS = ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'];
  const pay = (cells: string[]): SujainRawRow => ({ sourcePage: 'payment', section: 'payment', headers: HEADERS, cells });
  const opt = (cells: string[]): SujainRawRow => ({
    sourcePage: 'payment', section: 'option', itemLabel: '합성 현관 중문, [합성조명]-거실(2개소)', headers: HEADERS, cells,
  });
  const capturedRows = (): SujainRawRow[] => [
    pay(['계약금1차', '2023-05-20', '10,000,000', '2023-05-20', '10,000,000', '0', '0', '10,000,000']),
    pay(['중도금1차', '2024-01-25', '32,340,000', '2024-01-25', '32,340,000', '0', '0', '32,340,000']),
    pay(['잔금', '2027-02-26', '96,999,000', '', '0', '0', '0', '0']),
    pay(['계', '', '139,339,000', '', '42,340,000', '0', '0', '42,340,000']),
    opt(['계약금', '2023-05-20', '1,230,000', '2023-05-20', '1,230,000', '0', '0', '1,230,000']),
    opt(['잔금', '2027-02-26', '7,380,000', '', '0', '0', '0', '0']),
    opt(['계', '', '8,610,000', '', '1,230,000', '0', '0', '1,230,000']),
  ];
  /** 계약금1차는 같아서 빠지고, 중도금1차는 낸 금액·날짜가 달라 남는다. */
  const existingPayments = () => [
    paymentRow({
      id: PAY_CONTRACT, kind: 'contract', position: 0, installment: 1, dueDate: '2023-05-20', amount: '10000000',
      paidAmount: '10000000', paidDate: '2023-05-20',
    }),
    paymentRow({
      id: PAY_INTERIM, kind: 'interim', position: 1, installment: 1, dueDate: '2024-01-25', amount: '32340000',
      paidAmount: '0',
    }),
  ];
  const keyless = <T extends { key: string }>(items: T[]) => items.map((item) => {
    expect(item.key).toMatch(UUID_V4);
    return { ...item, key: '<key>' };
  });

  it('success returns the sujain_fetch preview and stores it on the connection', async () => {
    const current = connectionRow();
    const test = setup([
      [member(), [planRow()], [current], existingPayments()],
      [(values) => [{ ...current, ...(values as object) }]],
    ], { read: { rows: capturedRows() } });
    const preview = await test.service.sync(U, P, syncRequest);

    // 금고는 provider 'sujain' context 로 연다.
    expect(test.decrypt).toHaveBeenCalledTimes(1);
    expect(test.decrypt.mock.calls[0]).toEqual([current.credentials, sujainContext(C)]);
    expect(test.browser.read).toHaveBeenCalledTimes(1);
    expect(test.seen).toEqual([{ loginId: LOGIN_ID, password: PASSWORD }]);
    expect(test.signals[0]).toBeInstanceOf(AbortSignal);
    expect(test.signals[0]!.aborted).toBe(false);
    // 조회가 끝나면 복호화한 자격 증명을 비운다.
    expect(test.passed[0]).toMatchObject({ loginId: '', password: '' });

    const items = [
      {
        key: '<key>', kind: 'interim', installment: 1, label: null, scheduledAmount: '32340000', dueDate: '2024-01-25',
        paidAmount: '32340000', paidDate: '2024-01-25', actualPaidDate: '2024-01-25', matchedPaymentId: PAY_INTERIM,
        changedFields: ['paidAmount', 'paidDate', 'actualPaidDate'], unreadFields: [],
      },
      {
        key: '<key>', kind: 'balance', installment: null, label: null, scheduledAmount: '96999000', dueDate: '2027-02-26',
        paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: ['scheduledAmount', 'dueDate', 'paidAmount'], unreadFields: [],
      },
      {
        key: '<key>', kind: 'option', installment: null, label: '합성 현관 중문 외 1 · 계약금', scheduledAmount: '1230000',
        dueDate: '2023-05-20', paidAmount: '1230000', paidDate: '2023-05-20', actualPaidDate: '2023-05-20',
        matchedPaymentId: null,
        changedFields: ['scheduledAmount', 'dueDate', 'paidAmount', 'paidDate', 'actualPaidDate', 'label'],
        unreadFields: [],
      },
      {
        key: '<key>', kind: 'option', installment: null, label: '합성 현관 중문 외 1 · 잔금', scheduledAmount: '7380000',
        dueDate: '2027-02-26', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: null,
        changedFields: ['scheduledAmount', 'dueDate', 'paidAmount', 'label'], unreadFields: [],
      },
    ];
    const statusMessage = '가져온 납부·옵션을 확인한 뒤 반영할 항목을 골라 주세요.';
    expectWire({ ...preview, items: keyless(preview.items) }, {
      fetchedAt: FETCHED_AT,
      fetchedAtSeoul: '2026-11-08 12:34',
      source: 'sujain_fetch',
      items,
      unreadCount: 0,
      unreadReasons: [],
      connection: {
        id: C, planId: P, brand: 'sujain', status: 'needs_confirmation', statusMessage, credentialsStored: true,
        version: 4, lastFetchAt: FETCHED_AT, lastSuccessAt: FETCHED_AT, canManage: true,
      },
    });

    const update = test.calls.find((call) => call.operation === 'update')!;
    expect(update.scope).toBe('tx2');
    expect(update.table).toBe('housing_brand_connections');
    const values = update.values as Partial<ConnectionRow>;
    expect(Object.keys(values)).toEqual([
      'status', 'statusMessage', 'lastFetchAt', 'lastSuccessAt', 'lastPreview', 'updatedAt', 'version',
    ]);
    expect(values).toEqual({
      status: 'needs_confirmation', statusMessage, lastFetchAt: new Date(FETCHED_AT), lastSuccessAt: new Date(FETCHED_AT),
      lastPreview: { fetchedAt: FETCHED_AT, items: preview.items }, updatedAt: new Date(NOW), version: 4,
    });
    // 저장한 미리보기와 응답이 같은 key 를 쓴다(반영은 저장본의 key 로 고른다).
    expect(Object.keys(values.lastPreview!)).toEqual(['fetchedAt', 'items']);
    expect(test.unused()).toBe(0);
  });

  it('unread rows: unreadCount, deduped unreadReasons and unread items reach the wire and lastPreview unchanged', async () => {
    // 2단계에서 parseRows·0건 판정이 어댑터로 옮겨 가도 unread 전달(개수·사유 순서·unreadFields 항목)이 같아야 한다.
    // 줄 단위 값은 골든 fixture 'live headers: bare 회차 number is not a kind'·
    // 'option without an item list uses the generic title' 와 같은 입력·같은 결과다.
    // 종류를 못 읽는 줄을 둘 넣어 unreadCount(3) ≠ 중복 제거한 사유 수(2)가 되게 한다.
    const kindReason = '표에서 계약금·중도금·잔금·옵션 구분을 읽지 못했어요.';
    const labelReason = '별도 계약 품목 이름을 읽지 못했어요.';
    const bareInstallment = (installment: string): SujainRawRow => ({
      sourcePage: 'payment', headers: HEADERS,
      cells: [installment, '2026-06-01', '10,000,000', '2026-06-02', '9,000,000', '0', '0', '9,000,000'],
    });
    const rows: SujainRawRow[] = [
      bareInstallment('1'),
      pay(['중도금1차', '2024-01-25', '32,340,000', '2024-01-25', '10,000,000', '0', '0', '10,000,000']),
      { sourcePage: 'payment', section: 'option', headers: HEADERS, cells: ['잔금', '2027-03-31', '700,000', '', '0', '0', '0', '0'] },
      bareInstallment('2'),
    ];
    /** 이름 없는 옵션 줄과 값이 모두 같은 기존 일정 — unreadFields 때문에만 확인 목록에 남는다. */
    const optionPayment = paymentRow({
      id: PAY_OPTION, kind: 'option', position: 2, label: '별도 계약 품목 · 잔금', dueDate: '2027-03-31', amount: '700000',
      paidAmount: '0',
    });
    const current = connectionRow();
    const test = setup([
      [member(), [planRow()], [current], [...existingPayments(), optionPayment]],
      [(values) => [{ ...current, ...(values as object) }]],
    ], { read: { rows } });
    const preview = await test.service.sync(U, P, syncRequest);

    const items = [
      {
        key: '<key>', kind: 'interim', installment: 1, label: null, scheduledAmount: '32340000', dueDate: '2024-01-25',
        paidAmount: '10000000', paidDate: '2024-01-25', actualPaidDate: '2024-01-25', matchedPaymentId: PAY_INTERIM,
        changedFields: ['paidAmount', 'paidDate', 'actualPaidDate'], unreadFields: [],
      },
      {
        key: '<key>', kind: 'option', installment: null, label: '별도 계약 품목 · 잔금', scheduledAmount: '700000',
        dueDate: '2027-03-31', paidAmount: '0', paidDate: null, actualPaidDate: null, matchedPaymentId: PAY_OPTION,
        changedFields: [], unreadFields: [{ field: 'label', reason: labelReason }],
      },
    ];
    const statusMessage = '가져온 납부·옵션을 확인한 뒤 반영할 항목을 골라 주세요.';
    expectWire({ ...preview, items: keyless(preview.items) }, {
      fetchedAt: FETCHED_AT,
      fetchedAtSeoul: '2026-11-08 12:34',
      source: 'sujain_fetch',
      items,
      unreadCount: 3,
      unreadReasons: [kindReason, labelReason],
      connection: {
        id: C, planId: P, brand: 'sujain', status: 'needs_confirmation', statusMessage, credentialsStored: true,
        version: 4, lastFetchAt: FETCHED_AT, lastSuccessAt: FETCHED_AT, canManage: true,
      },
    });

    const update = test.calls.find((call) => call.operation === 'update')!;
    expect(update.scope).toBe('tx2');
    const values = update.values as Partial<ConnectionRow>;
    expect(Object.keys(values)).toEqual([
      'status', 'statusMessage', 'lastFetchAt', 'lastSuccessAt', 'lastPreview', 'updatedAt', 'version',
    ]);
    expect(values).toEqual({
      status: 'needs_confirmation', statusMessage, lastFetchAt: new Date(FETCHED_AT), lastSuccessAt: new Date(FETCHED_AT),
      lastPreview: { fetchedAt: FETCHED_AT, items: preview.items }, updatedAt: new Date(NOW), version: 4,
    });
    // 저장본은 fetchedAt·items 뿐이다(unreadCount·unreadReasons 는 응답에만 실린다). unread 항목도 그대로 저장한다.
    const stored = values.lastPreview as HousingBrandStoredPreview; // jsonb 칸이라 타입만 지정한다
    expectWire({ ...stored, items: keyless(stored.items) }, { fetchedAt: FETCHED_AT, items });
    expect(stored.items.map((item) => item.key)).toEqual(preview.items.map((item) => item.key));
    expect(test.unused()).toBe(0);
  });

  it('nothing changed → connected with an empty list', async () => {
    const current = connectionRow();
    const rows = capturedRows().slice(0, 1);
    const test = setup([
      [member(), [planRow()], [current], existingPayments().slice(0, 1)],
      [(values) => [{ ...current, ...(values as object) }]],
    ], { read: { rows } });
    const preview = await test.service.sync(U, P, syncRequest);
    expectWire(preview, {
      fetchedAt: FETCHED_AT, fetchedAtSeoul: '2026-11-08 12:34', source: 'sujain_fetch', items: [], unreadCount: 0,
      unreadReasons: [],
      connection: {
        id: C, planId: P, brand: 'sujain', status: 'connected', statusMessage: null, credentialsStored: true,
        version: 4, lastFetchAt: FETCHED_AT, lastSuccessAt: FETCHED_AT, canManage: true,
      },
    });
    expect((test.calls.find((call) => call.operation === 'update')!.values as Partial<ConnectionRow>).lastPreview)
      .toEqual({ fetchedAt: FETCHED_AT, items: [] });
  });

  it.each([
    ['contact table only', [
      { sourcePage: 'payment', headers: ['항목', '내용'], cells: ['이름', '합성 회원'] },
      { sourcePage: 'payment', headers: ['항목', '내용'], cells: ['이메일', 'synthetic@example.com'] },
    ]],
    ['payment-like rows without a readable kind', [
      { sourcePage: 'payment', section: 'payment', headers: HEADERS, cells: ['1', '2026-06-01', '1,000', '', '0', '0', '0', '0'] },
    ]],
    ['no rows at all', []],
  ] as Array<[string, SujainRawRow[]]>)('zero readable items (%s) → unsupported_layout, never an empty success', async (_name, rows) => {
    const current = connectionRow();
    const test = setup([[member(), [planRow()], [current], []]], {
      direct: [(values) => [{ ...current, ...(values as object) }]],
      read: { rows },
    });
    const error = await rejection(test.service.sync(U, P, syncRequest));
    const message = '수자인 화면 구성을 읽지 못했어요. 공식 페이지 레이아웃이 바뀌었을 수 있어요.';
    expect(error).toBeInstanceOf(BadRequestException);
    expectWire(error.getResponse(), {
      message,
      connection: {
        id: C, planId: P, brand: 'sujain', status: 'failed', statusMessage: message, credentialsStored: true,
        version: 4, lastFetchAt: NOW_ISO, lastSuccessAt: null, canManage: true,
      },
    });
    const update = test.calls.find((call) => call.operation === 'update')!;
    expect(update.scope).toBe('db');
    expect(Object.keys(update.values as object)).toEqual(['status', 'statusMessage', 'lastFetchAt', 'updatedAt', 'version']);
    expect(update.values).toEqual({
      status: 'failed', statusMessage: message, lastFetchAt: new Date(NOW), updatedAt: new Date(NOW), version: 4,
    });
    expect(test.calls.filter((call) => call.operation === 'update')).toHaveLength(1);
    expect(test.unused()).toBe(0);
  });

  it.each([
    ['credentials_invalid', null, 'failed', '수자인 로그인에 실패했어요. 아이디와 비밀번호를 다시 확인해 주세요.'],
    ['authentication_required', null, 'needs_confirmation', '추가 인증이 필요해요. 공식 수자인 페이지에서 이어서 확인해 주세요.'],
    ['network_error', null, 'failed', '수자인 페이지에 연결하지 못했어요. 잠시 후 다시 눌러 주세요.'],
    ['unsupported_layout', null, 'failed', '수자인 화면 구성을 읽지 못했어요. 공식 페이지 레이아웃이 바뀌었을 수 있어요.'],
    ['unit_not_registered', null, 'failed', '수자인 사이트의 My 분양단지에 등록된 세대가 없어요. 사이트에서 먼저 등록해 주세요.'],
    ['runtime_unavailable', 'chromium_launch_failed', 'failed', '신축 조회 브라우저를 시작하지 못했어요.'],
    ['runtime_unavailable', null, 'failed', '신축 조회 실행 환경이 준비되지 않았어요.'],
    ['operation_unknown', 'parent_deadline', 'failed', '수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.'],
    ['operation_unknown', 'response_validation_failed', 'failed', '수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.'],
  ] as const)('SujainBrowserError(%s, %s) → %s with public copy', async (code, reason, status, message) => {
    const current = connectionRow();
    const test = setup([[member(), [planRow()], [current], []]], {
      direct: [(values) => [{ ...current, ...(values as object) }]],
      read: { error: new SujainBrowserError(code, reason) },
    });
    const error = await rejection(test.service.sync(U, P, syncRequest));
    expect(error).toBeInstanceOf(BadRequestException);
    expectWire(error.getResponse(), {
      message,
      connection: {
        id: C, planId: P, brand: 'sujain', status, statusMessage: message, credentialsStored: true,
        version: 4, lastFetchAt: NOW_ISO, lastSuccessAt: null, canManage: true,
      },
    });
    const update = test.calls.find((call) => call.operation === 'update')!;
    expect(update.scope).toBe('db');
    expect(update.values).toEqual({
      status, statusMessage: message, lastFetchAt: new Date(NOW), updatedAt: new Date(NOW), version: 4,
    });
    // 실패해도 복호화한 자격 증명을 비운다.
    expect(test.passed[0]).toMatchObject({ loginId: '', password: '' });
    expect(JSON.stringify(error.getResponse())).not.toContain(PASSWORD);
  });

  it('an untyped read error is operation_unknown with the generic copy', async () => {
    const current = connectionRow();
    const test = setup([[member(), [planRow()], [current], []]], {
      direct: [(values) => [{ ...current, ...(values as object) }]],
      read: { error: new Error('synthetic untyped failure') },
    });
    const error = await rejection(test.service.sync(U, P, syncRequest));
    expect((error.getResponse() as { message: string }).message).toBe('수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.');
    expect((test.calls.find((call) => call.operation === 'update')!.values as Partial<ConnectionRow>).status).toBe('failed');
  });

  it('a lost version race on markFailure returns the message without a connection', async () => {
    const test = setup([[member(), [planRow()], [connectionRow()], []]], {
      direct: [[]],
      read: { error: new SujainBrowserError('network_error') },
    });
    const error = await rejection(test.service.sync(U, P, syncRequest));
    expectWire(error.getResponse(), { message: '수자인 페이지에 연결하지 못했어요. 잠시 후 다시 눌러 주세요.' });
  });

  it('no active connection → not_connected copy, no browser read', async () => {
    const test = setup([[member(), [planRow()], []]]);
    const error = await rejection(test.service.sync(U, P, syncRequest));
    expect(error.getResponse()).toEqual({ message: '이 주택에 연결된 수자인 계정이 없어요.', error: 'Bad Request', statusCode: 400 });
    expect(test.browser.read).not.toHaveBeenCalled();
  });

  it('an envelope sealed for another provider does not open → generic copy, no browser read', async () => {
    const foreign = vault().encrypt(
      { loginId: LOGIN_ID, password: PASSWORD, brand: 'sujain' },
      { ...sujainContext(C), provider: 'shinhan_bank' },
    );
    const test = setup([[member(), [planRow()], [connectionRow({ credentials: foreign })]]]);
    const error = await rejection(test.service.sync(U, P, syncRequest));
    expect(error.getResponse()).toEqual({
      message: '수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.', error: 'Bad Request', statusCode: 400,
    });
    expect(test.browser.read).not.toHaveBeenCalled();
  });
});

describe('publicErrorMessage copy (every code)', () => {
  it.each([
    ['credentials_invalid', null, '수자인 로그인에 실패했어요. 아이디와 비밀번호를 다시 확인해 주세요.'],
    ['authentication_required', null, '추가 인증이 필요해요. 공식 수자인 페이지에서 이어서 확인해 주세요.'],
    ['network_error', null, '수자인 페이지에 연결하지 못했어요. 잠시 후 다시 눌러 주세요.'],
    ['unsupported_layout', null, '수자인 화면 구성을 읽지 못했어요. 공식 페이지 레이아웃이 바뀌었을 수 있어요.'],
    ['unit_not_registered', null, '수자인 사이트의 My 분양단지에 등록된 세대가 없어요. 사이트에서 먼저 등록해 주세요.'],
    ['runtime_unavailable', 'chromium_launch_failed', '신축 조회 브라우저를 시작하지 못했어요.'],
    ['runtime_unavailable', 'stdin_error', '신축 조회 실행 환경이 준비되지 않았어요.'],
    ['runtime_unavailable', null, '신축 조회 실행 환경이 준비되지 않았어요.'],
    ['not_connected', null, '이 주택에 연결된 수자인 계정이 없어요.'],
    ['operation_unknown', null, '수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.'],
    ['synthetic_unknown_code', null, '수자인 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.'],
  ] as const)('%s (%s)', (code, reason, message) => {
    expect(publicErrorMessage(code, reason)).toBe(message);
    if (reason === null) expect(publicErrorMessage(code)).toBe(message);
  });
});
