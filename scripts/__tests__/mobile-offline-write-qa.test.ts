import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRuntimeReplacement,
  MAX_RECEIPT_BYTES,
  parseQaOptions,
  parseQaReceipt,
  waitForQaReceipt,
  type QaReceipt,
} from '../mobile-offline-write-qa';

const runId = '7985-test';
const holding: QaReceipt = {
  runId,
  phase: 'prepare-reload',
  status: 'holding',
  runtimeId: 'old-runtime',
  databaseName: 'qa-7985-test.db',
};
const verified: QaReceipt = {
  ...holding,
  phase: 'verify-reload',
  status: 'passed',
  runtimeId: 'new-runtime',
};

afterEach(() => vi.useRealTimers());

describe('offline write QA evidence', () => {
  it('re-delivers the first command when inspector readiness precedes JS linking listeners', async () => {
    vi.useFakeTimers();
    const receipts: QaReceipt[] = [];
    const completed: QaReceipt = { ...verified, phase: 'contention' };
    const open = vi.fn(() => {
      if (open.mock.calls.length === 2) receipts.push(completed);
    });
    const waiting = waitForQaReceipt(receipts, 'contention', 'passed', 9000, open);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(waiting).resolves.toEqual(completed);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('re-delivers preparation when the first link reaches the old runtime', async () => {
    vi.useFakeTimers();
    const receipts: QaReceipt[] = [holding];
    const reloaded: QaReceipt = { ...holding, status: 'reloaded', runtimeId: 'replacement-runtime' };
    const reopen = vi.fn(() => {
      if (reopen.mock.calls.length === 2) receipts.push(reloaded);
    });
    const waiting = waitForQaReceipt(receipts, 'prepare-reload', 'reloaded', 9000, reopen);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(waiting).resolves.toEqual(reloaded);
    expect(reopen).toHaveBeenCalledTimes(2);
  });

  it('keeps the original deadline when repeated links receive no acknowledgement', async () => {
    vi.useFakeTimers();
    const reopen = vi.fn();
    const waiting = waitForQaReceipt([holding], 'prepare-reload', 'reloaded', 1000, reopen);
    const rejection = expect(waiting).rejects.toThrow('Timed out after 1000ms');
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('accepts both full-fixture traces while keeping receipt payloads bounded', () => {
    const trace = Array.from({ length: 500 }, (_, index) => ({
      site: 'reconcile-foreground',
      stage: 'transaction-settled',
      elapsedMs: index,
    }));
    const encoded = JSON.stringify({ ...verified, details: { fresh: { trace }, partial: { trace } } });
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(64 * 1024);
    expect(parseQaReceipt(encoded, runId).status).toBe('passed');
    expect(() =>
      parseQaReceipt(JSON.stringify({ ...verified, details: 'x'.repeat(MAX_RECEIPT_BYTES) }), runId),
    ).toThrow('Receipt too large');
  });
  it('accepts only a replacement JS runtime in the same native process and database', () => {
    expect(() => assertRuntimeReplacement(holding, verified, '1234', '1234')).not.toThrow();
    expect(() => assertRuntimeReplacement(holding, verified, '1234', '5678')).toThrow('Native process changed');
    expect(() =>
      assertRuntimeReplacement(holding, { ...verified, runtimeId: holding.runtimeId }, '1234', '1234'),
    ).toThrow('JavaScript runtime did not change');
    expect(() =>
      assertRuntimeReplacement(holding, { ...verified, databaseName: 'another.db' }, '1234', '1234'),
    ).toThrow('different database');
  });

  it('refuses foreign runs, unsuccessful verification, or missing process identity', () => {
    expect(() => assertRuntimeReplacement(holding, { ...verified, runId: 'other' }, '1234', '1234')).toThrow();
    expect(() => assertRuntimeReplacement(holding, { ...verified, status: 'failed' }, '1234', '1234')).toThrow();
    expect(() => assertRuntimeReplacement(holding, verified, '', '')).toThrow();
  });

  it('does not accept an unrelated or malformed receipt as completion', () => {
    expect(parseQaReceipt(JSON.stringify(verified), runId)).toEqual(verified);
    for (const receipt of [
      null,
      { ...verified, runId: 'other' },
      { ...verified, runtimeId: '' },
      { ...verified, phase: 'unexpected' },
    ]) {
      expect(() => parseQaReceipt(JSON.stringify(receipt), runId)).toThrow();
    }
  });

  it('requires explicit simulators and a bounded timeout before installing anything', () => {
    const args = [
      '--platform',
      'android',
      '--device',
      'emulator-5554',
      '--app-path',
      'test.apk',
      '--output-dir',
      'evidence',
    ];
    expect(parseQaOptions(args)).toMatchObject({ platform: 'android', device: 'emulator-5554', timeoutMs: 600000 });
    expect(() => parseQaOptions([...args, '--timeout-ms', '0'])).toThrow('Invalid timeout');
    expect(() => parseQaOptions([...args, '--metro-port', '70000'])).toThrow('Invalid Metro port');
    expect(() =>
      parseQaOptions(args.map((argument) => (argument === 'emulator-5554' ? 'physical-phone' : argument))),
    ).toThrow('explicit');
    expect(() =>
      parseQaOptions(['--platform', 'ios', '--device', 'booted', '--app-path', 'test.app', '--output-dir', 'evidence']),
    ).toThrow('explicit');
  });
});
