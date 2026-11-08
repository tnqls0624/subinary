import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SujainBrowserClient,
  classifySujainRunnerFailure,
  coerceSujainLayoutDiagnostics,
  coerceSujainRunnerRows,
  formatLayoutWarnFragment,
  formatSujainRunnerWarnExtras,
  sanitizeSujainRunnerStderr,
} from './sujain-browser';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ name: 'playwright-core', version: '1.62.0' })),
}));

const credentials = () => ({ loginId: 'synthetic-id', password: 'Synthetic!123' });

function client(enabled = true) {
  return new SujainBrowserClient({
    get: () => ({
      enabled,
      runnerPath: '/synthetic-sujain/run.mjs',
      browserExecutable: '/synthetic-sujain/chromium',
    }),
  } as unknown as ConfigService);
}

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(() => true),
  });
  let input = '';
  process.stdin.on('data', (chunk: Buffer | string) => { input += chunk.toString(); });
  vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
  return {
    process,
    input: () => input,
    close: (code = 0) => { process.exitCode = code; process.emit('close', code); },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('sujain runner diagnostics without credentials', () => {
  it('keeps only chromium launch signals and redacts credential substrings', () => {
    const raw = [
      'Running as root without --no-sandbox is not supported.',
      'login=synthetic-id password=Synthetic!123',
      'unrelated noise line',
    ].join('\n');
    const sanitized = sanitizeSujainRunnerStderr(raw, credentials());
    expect(sanitized).toContain('Running as root without --no-sandbox');
    expect(sanitized).not.toContain('Synthetic!123');
    expect(sanitized).not.toContain('synthetic-id');
    expect(sanitized).not.toContain('unrelated noise');
  });

  it('maps root sandbox stderr to runtime_unavailable when JSON is missing', () => {
    expect(classifySujainRunnerFailure(
      1,
      null,
      'Running as root without --no-sandbox is not supported.\n',
    )).toEqual({
      code: 'runtime_unavailable',
      reason: 'chromium_launch_failed',
      errorName: null,
      stage: null,
      layout: null,
    });
  });

  it('preserves allowlisted runner reason from stdout JSON', () => {
    expect(classifySujainRunnerFailure(
      0,
      { error: 'runtime_unavailable', reason: 'chromium_launch_failed' },
      '',
    )).toEqual({
      code: 'runtime_unavailable',
      reason: 'chromium_launch_failed',
      errorName: null,
      stage: null,
      layout: null,
    });
  });

  it('preserves response_validation_failed and response_too_large reasons', () => {
    expect(classifySujainRunnerFailure(
      0,
      { error: 'operation_unknown', reason: 'response_validation_failed' },
      '',
    )).toEqual({
      code: 'operation_unknown',
      reason: 'response_validation_failed',
      errorName: null,
      stage: null,
      layout: null,
    });
    expect(classifySujainRunnerFailure(
      0,
      { error: 'operation_unknown', reason: 'response_too_large' },
      '',
    )).toEqual({
      code: 'operation_unknown',
      reason: 'response_too_large',
      errorName: null,
      stage: null,
      layout: null,
    });
  });

  it('maps nonzero exit without JSON to runner_exit_nonzero', () => {
    expect(classifySujainRunnerFailure(1, null, '')).toEqual({
      code: 'operation_unknown',
      reason: 'runner_exit_nonzero',
      errorName: null,
      stage: null,
      layout: null,
    });
  });

  it('preserves parent_deadline and playwright_timeout allowlisted reasons', () => {
    expect(classifySujainRunnerFailure(
      0,
      { error: 'operation_unknown', reason: 'parent_deadline' },
      '',
    )).toEqual({
      code: 'operation_unknown',
      reason: 'parent_deadline',
      errorName: null,
      stage: null,
      layout: null,
    });
    expect(classifySujainRunnerFailure(
      0,
      { error: 'operation_unknown', reason: 'playwright_timeout' },
      '',
    )).toEqual({
      code: 'operation_unknown',
      reason: 'playwright_timeout',
      errorName: null,
      stage: null,
      layout: null,
    });
    expect(classifySujainRunnerFailure(
      0,
      { error: 'operation_unknown', reason: 'runner_exception' },
      '',
    )).toEqual({
      code: 'operation_unknown',
      reason: 'runner_exception',
      errorName: null,
      stage: null,
      layout: null,
    });
  });

  it('preserves allowlisted errorName and stage from runner JSON', () => {
    expect(classifySujainRunnerFailure(
      0,
      {
        error: 'operation_unknown',
        reason: 'runner_exception',
        errorName: 'TargetClosedError',
        stage: 'scrape_payment',
      },
      '',
    )).toEqual({
      code: 'operation_unknown',
      reason: 'runner_exception',
      errorName: 'TargetClosedError',
      stage: 'scrape_payment',
      layout: null,
    });
  });

  it('preserves safe layout diagnostics from runner JSON', () => {
    const layout = {
      payment: {
        tableCount: 1,
        tableHeaders: [['항목', '내용']],
        rawRowCount: 2,
        eligibleRowCount: 0,
        tables: [{ rawRowCount: 2, preSkipRowCount: 3, formControlCount: 0 }],
        outsideTableFormControlCount: 0,
        outsideTableFormControls: {
          visibleInput: 0,
          visibleSelect: 0,
          visibleTextarea: 0,
          hidden: 0,
          other: 0,
        },
        iframeCount: 0,
        iframePaths: [],
        pagePath: 'https://www.sujain.co.kr/mypage/payment',
        lookupNonPlaceholderOptionCount: 0,
        lookupClicked: false,
        lookupBodyRowsAppeared: false,
      },
      'unit-items': {
        tableCount: 1,
        tableHeaders: [['품목', '금액']],
        rawRowCount: 1,
        eligibleRowCount: 1,
        tables: [{ rawRowCount: 1, preSkipRowCount: 2, formControlCount: 0 }],
        outsideTableFormControlCount: 1,
        outsideTableFormControls: {
          visibleInput: 0,
          visibleSelect: 1,
          visibleTextarea: 0,
          hidden: 0,
          other: 0,
        },
        iframeCount: 0,
        iframePaths: [],
        pagePath: 'https://www.sujain.co.kr/mypage/unit-items',
        lookupNonPlaceholderOptionCount: 0,
        lookupClicked: false,
        lookupBodyRowsAppeared: false,
      },
    };
    expect(classifySujainRunnerFailure(
      0,
      {
        error: 'unsupported_layout',
        stage: 'scrape_unit_items',
        layout,
      },
      '',
    )).toEqual({
      code: 'unsupported_layout',
      reason: null,
      errorName: null,
      stage: 'scrape_unit_items',
      layout,
    });
  });

  it('formats warn extras from allowlisted tokens only', () => {
    expect(formatSujainRunnerWarnExtras('Error', 'scrape_payment')).toBe(
      'errorName=Error stage=scrape_payment',
    );
    expect(formatSujainRunnerWarnExtras('TargetClosedError', 'login')).toBe(
      'errorName=TargetClosedError stage=login',
    );
    expect(formatSujainRunnerWarnExtras('bad name!', 'scrape_payment')).toBe('stage=scrape_payment');
    expect(formatSujainRunnerWarnExtras('Error', 'https://evil.example')).toBe('errorName=Error');
    expect(formatSujainRunnerWarnExtras(null, null)).toBe('');
  });

  it('formats layout warn fragment with header texts and counts, never cell values', () => {
    const layout = {
      payment: {
        tableCount: 1,
        tableHeaders: [['항목', '내용']],
        rawRowCount: 2,
        eligibleRowCount: 0,
        tables: [{ rawRowCount: 2, preSkipRowCount: 3, formControlCount: 0 }],
        outsideTableFormControlCount: 2,
        outsideTableFormControls: {
          visibleInput: 1,
          visibleSelect: 1,
          visibleTextarea: 0,
          hidden: 0,
          other: 0,
        },
        iframeCount: 1,
        iframePaths: ['https://www.sujain.co.kr/embed'],
        pagePath: 'https://www.sujain.co.kr/mypage/payment',
        lookupNonPlaceholderOptionCount: 0,
        lookupClicked: false,
        lookupBodyRowsAppeared: false,
      },
      'unit-items': {
        tableCount: 0,
        tableHeaders: [],
        rawRowCount: 0,
        eligibleRowCount: 0,
        tables: [],
        outsideTableFormControlCount: 0,
        outsideTableFormControls: {
          visibleInput: 0,
          visibleSelect: 0,
          visibleTextarea: 0,
          hidden: 0,
          other: 0,
        },
        iframeCount: 0,
        iframePaths: [],
        pagePath: 'https://www.sujain.co.kr/mypage/unit-items',
        lookupNonPlaceholderOptionCount: 0,
        lookupClicked: false,
        lookupBodyRowsAppeared: false,
      },
    };
    const fragment = formatLayoutWarnFragment(layout);
    expect(fragment).toContain(
      'layout=payment:t=1;h=[항목|내용];raw=2;eligible=0;tables=[r=2,p=3,i=0];out=2[vi=1,vs=1,vt=0,h=0,o=0];lookup=np=0;click=0;rows=0;ifr=1;path=https://www.sujain.co.kr/mypage/payment',
    );
    expect(fragment).toContain(
      'unit-items:t=0;h=[];raw=0;eligible=0;tables=[];out=0[vi=0,vs=0,vt=0,h=0,o=0];lookup=np=0;click=0;rows=0;ifr=0;path=https://www.sujain.co.kr/mypage/unit-items',
    );
    expect(fragment).not.toContain('합성 회원');
    expect(fragment).not.toContain('000-0000-0000');
    expect(fragment).not.toContain('1,000');
    expect(fragment).not.toContain('?');
    expect(formatSujainRunnerWarnExtras(null, 'scrape_unit_items', layout)).toContain(
      'stage=scrape_unit_items layout=payment:',
    );
    expect(coerceSujainLayoutDiagnostics({
      payment: {
        tableCount: 1,
        tableHeaders: [['금액']],
        rawRowCount: 0,
        eligibleRowCount: 0,
        tables: [],
        outsideTableFormControlCount: 0,
        iframeCount: 0,
        iframePaths: [],
        pagePath: null,
        lookupNonPlaceholderOptionCount: 0,
        lookupClicked: false,
        lookupBodyRowsAppeared: false,
        cells: ['합성 회원'],
      },
    })).toBeNull();
    expect(coerceSujainLayoutDiagnostics(layout)).toEqual(layout);
  });

  it('truncates synthetic overlong cells without inventing values', () => {
    const longCell = `synthetic-cell-${'x'.repeat(250)}`;
    const coerced = coerceSujainRunnerRows([{
      cells: [longCell, '1,000'],
      headers: [`synthetic-header-${'y'.repeat(120)}`, '금액'],
      sourcePage: 'payment',
    }]);
    expect(coerced).toEqual([{
      cells: [longCell.slice(0, 200), '1,000'],
      headers: [`synthetic-header-${'y'.repeat(120)}`.slice(0, 100), '금액'],
      sourcePage: 'payment',
    }]);
    expect(coerceSujainRunnerRows([{ cells: [123], sourcePage: 'payment' }])).toBeNull();
  });
});

describe('sujain child transport with synthetic streams', () => {
  it('pipes stderr and surfaces chromium_launch_failed without echoing secrets', async () => {
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    const call = vi.mocked(spawn).mock.calls[0]!;
    expect(call[2]?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(JSON.stringify(call)).not.toContain('Synthetic!123');
    test.process.stderr.write('Running as root without --no-sandbox is not supported.\n');
    test.process.stdout.write(JSON.stringify({
      ok: false,
      error: 'runtime_unavailable',
      reason: 'chromium_launch_failed',
    }));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'runtime_unavailable',
      reason: 'chromium_launch_failed',
      message: 'Sujain read did not complete',
    });
    expect(test.input()).toContain('synthetic-id');
  });

  it('remaps hard exit with sandbox stderr when stdout is empty', async () => {
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.process.stderr.write('No usable sandbox!\n');
    test.close(1);
    await expect(pending).rejects.toMatchObject({
      code: 'runtime_unavailable',
      reason: 'chromium_launch_failed',
    });
  });

  it('accepts ok:true rows whose synthetic cells exceed schema caps by truncating', async () => {
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    const longCell = `synthetic-cell-${'x'.repeat(250)}`;
    const longHeader = `synthetic-header-${'y'.repeat(120)}`;
    expect(longCell.length).toBeGreaterThan(200);
    expect(longHeader.length).toBeGreaterThan(100);
    test.process.stdout.write(JSON.stringify({
      ok: true,
      capturedAt: '2026-11-07T11:29:47.599+00:00',
      rows: [{
        cells: [longCell, '1,000'],
        headers: [longHeader, '금액'],
        sourcePage: 'payment',
      }],
    }));
    test.close(0);
    const result = await pending;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.cells[0]!.length).toBe(200);
    expect(result.rows[0]!.headers![0]!.length).toBe(100);
    expect(result.rows[0]!.cells[1]).toBe('1,000');
  });

  it('marks oversized stdout as operation_unknown with response_too_large reason', async () => {
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    // Stay under schema row caps but exceed the previous 65_536-byte kill switch.
    const fat = 'z'.repeat(70_000);
    test.process.stdout.write(JSON.stringify({
      ok: true,
      capturedAt: '2026-11-07T11:29:47.599+00:00',
      rows: [{ cells: [fat], headers: ['구분'], sourcePage: 'payment' }],
    }));
    // With the raised cap this still parses; force the kill path via a second huge chunk after open.
    // Emit enough bytes that the transport rejects before close.
    test.process.stdout.write('a'.repeat(1_100_000));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'operation_unknown',
      reason: 'response_too_large',
    });
  });

  it('surfaces response_validation_failed when ok payload cannot be coerced', async () => {
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.process.stdout.write(JSON.stringify({
      ok: true,
      capturedAt: '2026-11-07T11:29:47.599+00:00',
      rows: [{
        cells: [123],
        headers: ['구분'],
        sourcePage: 'payment',
      }],
    }));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'operation_unknown',
      reason: 'response_validation_failed',
    });
  });

  it('keeps typed ok:false error when optional reason is not allowlisted', async () => {
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.process.stdout.write(JSON.stringify({
      ok: false,
      error: 'credentials_invalid',
      reason: 'not-an-allowlisted-token',
    }));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'credentials_invalid',
      reason: null,
    });
  });

  it('marks the 60s parent timer as parent_deadline and warns without stderr', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    const outcome = expect(pending).rejects.toMatchObject({
      code: 'operation_unknown',
      reason: 'parent_deadline',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(test.process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/sujain runner failed code=operation_unknown reason=parent_deadline/),
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain('Synthetic!123');
    warn.mockRestore();
  });

  it('marks stdin transport errors as stdin_error and warns', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    const outcome = expect(pending).rejects.toMatchObject({
      code: 'operation_unknown',
      reason: 'stdin_error',
    });
    test.process.stdin.emit('error', new Error('synthetic-stdin-broken'));
    await outcome;
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/sujain runner failed code=operation_unknown reason=stdin_error/),
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain('synthetic-stdin-broken');
    warn.mockRestore();
  });

  it('surfaces playwright_timeout from runner JSON and warns without stderr', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.process.stdout.write(JSON.stringify({
      ok: false,
      error: 'operation_unknown',
      reason: 'playwright_timeout',
    }));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'operation_unknown',
      reason: 'playwright_timeout',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/sujain runner failed code=operation_unknown reason=playwright_timeout/),
    );
    warn.mockRestore();
  });

  it('warns runner_exception with allowlisted errorName and stage, never message text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.process.stdout.write(JSON.stringify({
      ok: false,
      error: 'operation_unknown',
      reason: 'runner_exception',
      errorName: 'Error',
      stage: 'scrape_payment',
    }));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'operation_unknown',
      reason: 'runner_exception',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /sujain runner failed code=operation_unknown reason=runner_exception errorName=Error stage=scrape_payment/,
      ),
    );
    const joined = warn.mock.calls.flat().join('\n');
    expect(joined).not.toContain('Execution context');
    expect(joined).not.toContain('Synthetic!123');
    expect(joined).not.toContain('synthetic-id');
    warn.mockRestore();
  });

  it('warns unsupported_layout with safe layout headers/counts and never cell values', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.process.stdout.write(JSON.stringify({
      ok: false,
      error: 'unsupported_layout',
      stage: 'scrape_unit_items',
      layout: {
        payment: {
          tableCount: 1,
          tableHeaders: [['항목', '내용']],
          rawRowCount: 2,
          eligibleRowCount: 0,
          tables: [{ rawRowCount: 2, preSkipRowCount: 3, formControlCount: 0 }],
          outsideTableFormControlCount: 0,
          outsideTableFormControls: {
            visibleInput: 0,
            visibleSelect: 0,
            visibleTextarea: 0,
            hidden: 0,
            other: 0,
          },
          iframeCount: 0,
          iframePaths: [],
          pagePath: 'https://www.sujain.co.kr/mypage/payment',
          lookupNonPlaceholderOptionCount: 0,
          lookupClicked: false,
          lookupBodyRowsAppeared: false,
        },
        'unit-items': {
          tableCount: 1,
          tableHeaders: [['항목', '내용']],
          rawRowCount: 2,
          eligibleRowCount: 0,
          tables: [{ rawRowCount: 2, preSkipRowCount: 3, formControlCount: 0 }],
          outsideTableFormControlCount: 0,
          outsideTableFormControls: {
            visibleInput: 0,
            visibleSelect: 0,
            visibleTextarea: 0,
            hidden: 0,
            other: 0,
          },
          iframeCount: 0,
          iframePaths: [],
          pagePath: 'https://www.sujain.co.kr/mypage/unit-items',
          lookupNonPlaceholderOptionCount: 0,
          lookupClicked: false,
          lookupBodyRowsAppeared: false,
        },
      },
    }));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'unsupported_layout',
      reason: null,
    });
    const joined = warn.mock.calls.flat().join('\n');
    expect(joined).toMatch(
      /sujain runner failed code=unsupported_layout reason=none stage=scrape_unit_items layout=/,
    );
    expect(joined).toContain(
      'payment:t=1;h=[항목|내용];raw=2;eligible=0;tables=[r=2,p=3,i=0];out=0[vi=0,vs=0,vt=0,h=0,o=0];lookup=np=0;click=0;rows=0;ifr=0;path=https://www.sujain.co.kr/mypage/payment',
    );
    expect(joined).toContain(
      'unit-items:t=1;h=[항목|내용];raw=2;eligible=0;tables=[r=2,p=3,i=0];out=0[vi=0,vs=0,vt=0,h=0,o=0];lookup=np=0;click=0;rows=0;ifr=0;path=https://www.sujain.co.kr/mypage/unit-items',
    );
    expect(joined).not.toContain('합성 회원');
    expect(joined).not.toContain('000-0000-0000');
    expect(joined).not.toContain('synthetic@example.com');
    expect(joined).not.toContain('Synthetic!123');
    warn.mockRestore();
  });

  it('keeps typed ok:false when optional errorName is not allowlisted', async () => {
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.process.stdout.write(JSON.stringify({
      ok: false,
      error: 'credentials_invalid',
      errorName: 'bad name with spaces',
      stage: 'not-a-real-stage',
    }));
    test.close(0);
    await expect(pending).rejects.toMatchObject({
      code: 'credentials_invalid',
      reason: null,
    });
  });

  it('surfaces runner_exit_nonzero when child exits hard with empty stdout', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const test = child();
    const pending = client().read(credentials(), new AbortController().signal);
    test.close(1);
    await expect(pending).rejects.toMatchObject({
      code: 'operation_unknown',
      reason: 'runner_exit_nonzero',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/sujain runner failed code=operation_unknown reason=runner_exit_nonzero/),
    );
    warn.mockRestore();
  });
});
