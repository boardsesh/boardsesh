/// <reference types="node" />

// The CLI's own argv parser: what every flag means, what's required, and the
// two footguns an invocation can hit — the literal `--` `vp run` inserts
// ahead of every flag (scripts/screenshot-backend.ts used to fail on it with
// "unknown argument --"), and a stray unknown flag that must fail loudly
// rather than get silently ignored.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCliArguments } from '../screenshot-backend';

describe('parseCliArguments', () => {
  const originalPortEnv = process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT;

  afterEach(() => {
    if (originalPortEnv === undefined) delete process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT;
    else process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT = originalPortEnv;
    vi.restoreAllMocks();
  });

  /** `fail()` writes one console.error line and calls `process.exit(1)`; both are spied so a rejection is assertable instead of actually exiting the test process. */
  const captureFailure = (argv: string[]): string => {
    const errorLines: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('screenshot-backend CLI called process.exit');
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.map((arg) => String(arg)).join(' '));
    });
    expect(() => parseCliArguments(argv)).toThrow('screenshot-backend CLI called process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    return errorLines.join('\n');
  };

  it('skips the literal `--` vp run inserts ahead of every flag', () => {
    expect(parseCliArguments(['--', '--mode', 'replay'])).toMatchObject({ mode: 'replay' });
    expect(parseCliArguments(['--mode', 'replay', '--'])).toMatchObject({ mode: 'replay' });
  });

  it('parses every flag', () => {
    const options = parseCliArguments([
      '--mode',
      'record',
      '--port',
      '9091',
      '--fixtures',
      'my-fixtures',
      '--upstream',
      'https://example.test',
      '--frozen-now',
      '2026-01-01T00:00:00Z',
      '--flow',
      'onboarding',
      '--fresh',
    ]);
    expect(options.mode).toBe('record');
    expect(options.port).toBe(9091);
    expect(options.fixturesDir.endsWith('my-fixtures')).toBe(true);
    expect(options.upstream).toBe('https://example.test');
    expect(options.frozenNow).toBe('2026-01-01T00:00:00Z');
    expect(options.flow).toBe('onboarding');
    expect(options.fresh).toBe(true);
  });

  it('defaults fixtures, upstream, frozenNow and flow when omitted', () => {
    const options = parseCliArguments(['--mode', 'replay']);
    expect(options.fixturesDir.endsWith('packages/mobile/screenshot-fixtures')).toBe(true);
    expect(options.upstream).toBe('https://ws.boardsesh.com');
    expect(options.frozenNow).toBeNull();
    expect(options.flow).toBeNull();
    expect(options.fresh).toBe(false);
  });

  it('requires --mode', () => {
    expect(captureFailure([])).toContain('--mode is required');
  });

  it('validates --mode is replay or record', () => {
    expect(captureFailure(['--mode', 'bogus'])).toContain('--mode must be replay or record');
  });

  it('defaults --port to BOARDSESH_SCREENSHOT_BACKEND_PORT, else 8090', () => {
    delete process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT;
    expect(parseCliArguments(['--mode', 'replay']).port).toBe(8090);

    process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT = '9500';
    expect(parseCliArguments(['--mode', 'replay']).port).toBe(9500);

    // An explicit --port still wins over the env default.
    expect(parseCliArguments(['--mode', 'replay', '--port', '9600']).port).toBe(9600);
  });

  it('allows --fresh with record but rejects it with replay', () => {
    expect(parseCliArguments(['--mode', 'record', '--fresh']).fresh).toBe(true);
    expect(captureFailure(['--mode', 'replay', '--fresh'])).toContain('--fresh is record-only');
  });

  it('rejects --upstream in replay mode, since replay makes no outbound request', () => {
    expect(captureFailure(['--mode', 'replay', '--upstream', 'https://example.test'])).toContain(
      '--upstream is record-only',
    );
  });

  it('fails loudly on an unknown flag rather than silently ignoring it', () => {
    expect(captureFailure(['--mode', 'replay', '--bogus'])).toContain('unknown argument --bogus');
  });
});
