/**
 * 주택 브랜드 등록표·수자인 어댑터 단위 테스트(docs/architecture/housing-brand-adapters.md 2단계).
 * 브라우저는 띄우지 않는다. 값은 모두 합성이다.
 */
import { describe, expect, it, vi } from 'vitest';
import { HOUSING_BRANDS, type HousingBrand } from '@family/contracts';
import { HousingBrandReadError, type HousingBrandAdapter, type HousingBrandReadResult } from './brand-adapter';
import { HousingBrandRegistry } from './brand-registry';
import { publicErrorMessage } from './housing-brand-sync.service';
import { SujainAdapter } from './sujain-adapter';
import { SujainBrowserClient, SujainBrowserError } from './sujain-browser';
import type { SujainRawRow } from './sujain-parse';

const CAPTURED_AT = '2026-11-08T12:34:56+09:00';
const HEADERS = ['회차', '약정일자', '약정금액', '납부일자', '납부원금', '연체료', '할인료', '실납부금'];

type ReadImpl = (credentials: { loginId: string; password: string }, signal: AbortSignal) => Promise<{
  capturedAt: string;
  rows: SujainRawRow[];
}>;

/** 가짜 수자인 클라이언트. 표 해석은 실제 parseRows 를 쓴다. */
function fakeClient(read: ReadImpl, available = true) {
  return {
    configured: true,
    available,
    read: vi.fn(read),
    parseRows: SujainBrowserClient.prototype.parseRows,
  };
}

const sujainAdapter = (read: ReadImpl, available = true) => {
  const client = fakeClient(read, available);
  return { client, adapter: new SujainAdapter(client as unknown as SujainBrowserClient) };
};

const emptyResult = (): HousingBrandReadResult => ({ capturedAt: CAPTURED_AT, items: [], unreadCount: 0, unreadReasons: [] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function readError(promise: Promise<unknown>): Promise<HousingBrandReadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HousingBrandReadError) return error;
    throw error;
  }
  throw new Error('expected HousingBrandReadError');
}

describe('HousingBrandRegistry: boot check against HOUSING_BRANDS', () => {
  it('registers exactly the brands in HOUSING_BRANDS', () => {
    const { adapter } = sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows: [] }));
    const registry = new HousingBrandRegistry(adapter);
    for (const brand of HOUSING_BRANDS) expect(registry.get(brand).brand).toBe(brand);
    expect(registry.get('sujain')).toBe(adapter);
  });

  it.each([
    ['missing adapter (DI gave nothing)', undefined],
    ['adapter for an unknown brand', { brand: 'synthetic_brand', available: true, read: async () => emptyResult() }],
  ] as Array<[string, unknown]>)('throws in the constructor so the API does not boot: %s', (_name, adapter) => {
    expect(() => new HousingBrandRegistry(adapter as unknown as SujainAdapter)).toThrow(/HOUSING_BRANDS/);
  });
});

describe('HousingBrandRegistry: unknown brand', () => {
  const registry = () => new HousingBrandRegistry(sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows: [] })).adapter);

  it('get → runtime_unavailable', () => {
    let caught: unknown;
    try {
      registry().get('synthetic_brand' as HousingBrand);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HousingBrandReadError);
    expect(caught).toMatchObject({ code: 'runtime_unavailable', reason: null });
  });

  it('run → runtime_unavailable without calling the job or holding the gate', async () => {
    const instance = registry();
    const job = vi.fn(async () => 'never');
    const error = await readError(instance.run('synthetic_brand' as HousingBrand, job));
    expect(error).toMatchObject({ code: 'runtime_unavailable', reason: null });
    expect(job).not.toHaveBeenCalled();
    await expect(instance.run('sujain', async () => 'next')).resolves.toBe('next');
  });
});

describe('HousingBrandRegistry: one browser job per process', () => {
  it('a concurrent second run → runtime_unavailable; the gate opens again after success and after failure', async () => {
    const registry = new HousingBrandRegistry(sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows: [] })).adapter);
    const first = deferred<string>();
    const firstJob = vi.fn((adapter: HousingBrandAdapter) => {
      expect(adapter.brand).toBe('sujain');
      return first.promise;
    });
    const running = registry.run('sujain', firstJob);
    expect(firstJob).toHaveBeenCalledTimes(1);

    const secondJob = vi.fn(async () => 'second');
    const busy = await readError(registry.run('sujain', secondJob));
    expect(busy).toMatchObject({ code: 'runtime_unavailable', reason: null });
    expect(secondJob).not.toHaveBeenCalled();
    // 공개 문구는 클라이언트 자체 게이트(#active)에 막혔을 때와 같다.
    expect(publicErrorMessage(busy.code, busy.reason, 'sujain')).toBe('신축 조회 실행 환경이 준비되지 않았어요.');

    first.resolve('first');
    await expect(running).resolves.toBe('first');
    await expect(registry.run('sujain', async () => 'after success')).resolves.toBe('after success');

    await expect(registry.run('sujain', async () => { throw new Error('synthetic job failure'); }))
      .rejects.toThrow('synthetic job failure');
    await expect(registry.run('sujain', async () => 'after failure')).resolves.toBe('after failure');
  });
});

describe('SujainAdapter', () => {
  it('passes the same credentials object and signal, parses rows and drops parser-only fields', async () => {
    const rows: SujainRawRow[] = [
      { sourcePage: 'payment', section: 'payment', headers: HEADERS, cells: ['잔금', '2027-02-26', '96,999,000', '', '0', '0', '0', '0'] },
      { sourcePage: 'payment', headers: HEADERS, cells: ['1', '2026-06-01', '10,000,000', '', '0', '0', '0', '0'] },
    ];
    const { client, adapter } = sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows }));
    const credentials = { loginId: 'synthetic.user', password: 'x'.repeat(16) };
    const signal = new AbortController().signal;
    const result = await adapter.read(credentials, signal);

    expect(client.read).toHaveBeenCalledTimes(1);
    expect(client.read.mock.calls[0]![0]).toBe(credentials);
    expect(client.read.mock.calls[0]![1]).toBe(signal);
    expect(Object.keys(result)).toEqual(['capturedAt', 'items', 'unreadCount', 'unreadReasons']);
    expect(result.capturedAt).toBe(CAPTURED_AT);
    expect(result.items.map((item) => [item.kind, item.scheduledAmount, item.matchedPaymentId, item.changedFields]))
      .toEqual([['balance', '96999000', null, []]]);
    expect(result.unreadCount).toBe(1);
    expect(result.unreadReasons).toEqual(['표에서 계약금·중도금·잔금·옵션 구분을 읽지 못했어요.']);
  });

  it.each([
    ['no rows', []],
    ['contact table only', [{ sourcePage: 'payment', headers: ['항목', '내용'], cells: ['이름', '합성 회원'] }]],
  ] as Array<[string, SujainRawRow[]]>)('zero readable items (%s) → unsupported_layout, never an empty success', async (_name, rows) => {
    const { adapter } = sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows }));
    const error = await readError(adapter.read({ loginId: 'synthetic.user', password: 'x'.repeat(16) }, new AbortController().signal));
    expect(error).toMatchObject({ code: 'unsupported_layout', reason: null });
  });

  it('turns SujainBrowserError into HousingBrandReadError with the same code and reason', async () => {
    const { adapter } = sujainAdapter(async () => { throw new SujainBrowserError('runtime_unavailable', 'chromium_launch_failed'); });
    const error = await readError(adapter.read({ loginId: 'synthetic.user', password: 'x'.repeat(16) }, new AbortController().signal));
    expect(error).toMatchObject({ code: 'runtime_unavailable', reason: 'chromium_launch_failed' });
    expect(error.message).toBe('Housing brand read did not complete');
  });

  it('lets untyped errors through so the service maps them to operation_unknown', async () => {
    const original = new Error('synthetic untyped failure');
    const { adapter } = sujainAdapter(async () => { throw original; });
    await expect(adapter.read({ loginId: 'synthetic.user', password: 'x'.repeat(16) }, new AbortController().signal))
      .rejects.toBe(original);
  });

  it('available follows the client', () => {
    expect(sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows: [] }), true).adapter.available).toBe(true);
    expect(sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows: [] }), false).adapter.available).toBe(false);
  });

  it('overrides only unit_not_registered with the site term, matching publicErrorMessage', () => {
    const { adapter } = sujainAdapter(async () => ({ capturedAt: CAPTURED_AT, rows: [] }));
    expect(adapter.publicErrorOverride('unit_not_registered'))
      .toBe('수자인 사이트의 My 분양단지에 등록된 세대가 없어요. 사이트에서 먼저 등록해 주세요.');
    expect(adapter.publicErrorOverride('unit_not_registered')).toBe(publicErrorMessage('unit_not_registered', null, 'sujain'));
    for (const code of ['credentials_invalid', 'authentication_required', 'network_error', 'unsupported_layout',
      'runtime_unavailable', 'operation_unknown', 'not_connected'] as const) {
      expect(adapter.publicErrorOverride(code)).toBeNull();
    }
  });
});
