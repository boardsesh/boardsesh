import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootIosCaptureDevice } from '../lib/ios-capture-boot';
import { runCapture } from '../mobile-screenshots';

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'ios-boot-test-'));
  directories.push(path);
  return path;
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const success = { status: 0, stdout: 'Boot complete', stderr: '' };
const device = { udid: 'test-device', state: 'Shutdown' };

describe('capture simulator boot', () => {
  it('retains a real process timeout with empty stderr in boot evidence', () => {
    const debugDir = directory();
    expect(() =>
      bootIosCaptureDevice({
        device,
        debugDir,
        run: () => runCapture(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], undefined, 50),
      }),
    ).toThrow('ETIMEDOUT');
    expect(JSON.parse(readFileSync(join(debugDir, readdirSync(debugDir)[0], 'boot.json'), 'utf8'))).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('ETIMEDOUT'),
    });
  });
  it('bounds both commands and records successful readiness', () => {
    const run = vi.fn(() => success);
    const evidence = bootIosCaptureDevice({ device, debugDir: directory(), run });
    expect(run.mock.calls).toEqual([
      [['simctl', 'boot', device.udid], 120_000],
      [['simctl', 'bootstatus', device.udid, '-b'], 600_000],
    ]);
    expect(JSON.parse(readFileSync(join(evidence, 'bootstatus.json'), 'utf8'))).toMatchObject(success);
  });
  for (const operation of ['boot', 'bootstatus']) {
    it(`preserves ${operation} timeout evidence before failing`, () => {
      const debugDir = directory();
      const run = vi.fn((args: string[]) =>
        args[1] === operation
          ? { status: 1, stdout: 'Waiting for device', stderr: 'spawnSync xcrun ETIMEDOUT' }
          : success,
      );
      expect(() => bootIosCaptureDevice({ device, debugDir, run })).toThrow(/ETIMEDOUT/);
      expect(run).toHaveBeenCalledTimes(operation === 'boot' ? 1 : 2);
      const evidence = JSON.parse(readFileSync(join(debugDir, readdirSync(debugDir)[0], `${operation}.json`), 'utf8'));
      expect(evidence).toMatchObject({ status: 1, stdout: 'Waiting for device', stderr: 'spawnSync xcrun ETIMEDOUT' });
    });
  }
  it('rejects a nonzero boot result without attempting readiness', () => {
    const run = vi.fn(() => ({ status: 149, stdout: '', stderr: 'Unable to boot device' }));
    expect(() => bootIosCaptureDevice({ device, debugDir: directory(), run })).toThrow('Unable to boot device');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('checks readiness even for an already booted device', () => {
    const run = vi.fn(() => success);
    bootIosCaptureDevice({ device: { ...device, state: 'Booted' }, debugDir: directory(), run });
    expect(run.mock.calls).toEqual([[['simctl', 'bootstatus', device.udid, '-b'], 600_000]]);
  });
  it('writes command intent before execution and preserves thrown errors', () => {
    const debugDir = directory();
    expect(() =>
      bootIosCaptureDevice({
        device,
        debugDir,
        run: () => {
          const evidence = JSON.parse(readFileSync(join(debugDir, readdirSync(debugDir)[0], 'boot.json'), 'utf8'));
          expect(evidence).toMatchObject({ timeoutMs: 120_000, args: ['simctl', 'boot', device.udid] });
          throw new Error('spawn failed');
        },
      }),
    ).toThrow('spawn failed');
    expect(JSON.parse(readFileSync(join(debugDir, readdirSync(debugDir)[0], 'boot.json'), 'utf8'))).toMatchObject({
      status: 1,
      stderr: 'spawn failed',
    });
  });
});
