import { describe, expect, it } from 'vitest';
import {
  assertRuntimeReplacement,
  MAX_RECEIPT_BYTES,
  parseQaOptions,
  parseQaReceipt,
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

describe('offline write QA evidence', () => {
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
