import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
import { currentDuoPose, duoDisplayLit, poseFromLitDisplays, setDuoPose } from '../lib/ios-duo-hinge';

let diagnostics: string;
beforeEach(() => {
  diagnostics = mkdtempSync(join(tmpdir(), 'duo-probes-test-'));
  vi.stubEnv('SCREENSHOT_DEBUG_DIR', diagnostics);
  spawnSyncMock.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(diagnostics, { recursive: true, force: true });
});

function diagnosticFile(name: string): string {
  return join(diagnostics, readdirSync(diagnostics)[0], name);
}

describe('Duo pose capture diagnostics', () => {
  it('keeps screenshot failures unknown and records command errors', () => {
    spawnSyncMock.mockReturnValue({ status: null, stderr: 'simulator unavailable', error: new Error('timed out') });
    expect(duoDisplayLit('test-device', 'primary')).toBeNull();
    const probe = JSON.parse(readFileSync(diagnosticFile('probes.jsonl'), 'utf8'));
    expect(probe).toMatchObject({ display: 'primary', lit: null, captureSucceeded: false });
    expect(probe.error).toContain('simulator unavailable');
    expect(probe.error).toContain('timed out');
    expect(poseFromLitDisplays(true, null)).toBeNull();
    expect(poseFromLitDisplays(null, true)).toBeNull();
  });

  it('retains the display image when conversion fails instead of reporting darkness', () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'xcrun') {
        writeFileSync(args.at(-1)!, 'captured image');
        return { status: 0 };
      }
      return { status: 1, stderr: 'unsupported image' };
    });
    expect(currentDuoPose('test-device')).toBeNull();
    expect(readFileSync(diagnosticFile('primary-latest.png'), 'utf8')).toBe('captured image');
    expect(readFileSync(diagnosticFile('primary-1-latest.png'), 'utf8')).toBe('captured image');
    const probes = readFileSync(diagnosticFile('probes.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(probes).toHaveLength(2);
    expect(probes[0]).toMatchObject({ captureSucceeded: true, lit: null });
    expect(probes[0].error).toContain('unsupported image');
  });

  it('never toggles an unknown pose after probe failures', () => {
    vi.useFakeTimers();
    spawnSyncMock.mockImplementation((command: string) => {
      if (command === 'sleep') vi.advanceTimersByTime(10_000);
      return { status: 1, stderr: 'capture failed' };
    });
    expect(() => setDuoPose('test-device', 'closed', join(diagnostics, 'hinge.log'))).toThrow(
      'refusing a blind toggle',
    );
    expect(spawnSyncMock.mock.calls.some(([, args]) => args.includes('notifyutil'))).toBe(false);
  });
});
