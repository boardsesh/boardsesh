import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync), copyFileSync: vi.fn(actual.copyFileSync) };
});
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
import {
  currentDuoPose,
  duoDisplayLit,
  duoHingeLogPath,
  installDuoHinge,
  poseFromLitDisplays,
  setDuoPose,
} from '../lib/ios-duo-hinge';

let diagnostics: string;
beforeEach(async () => {
  diagnostics = mkdtempSync(join(tmpdir(), 'duo-probes-test-'));
  vi.stubEnv('SCREENSHOT_DEBUG_DIR', diagnostics);
  spawnSyncMock.mockReset();
  vi.mocked(appendFileSync).mockReset();
  vi.mocked(copyFileSync).mockReset();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(appendFileSync).mockImplementation(actual.appendFileSync);
  vi.mocked(copyFileSync).mockImplementation(actual.copyFileSync);
});
afterEach(() => {
  vi.restoreAllMocks();
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

describe('Duo startup diagnostics', () => {
  it('makes a relative CI debug directory absolute for the injected process', () => {
    vi.stubEnv('SCREENSHOT_DEBUG_DIR', relative(process.cwd(), diagnostics));
    const logPath = duoHingeLogPath('test-device');
    expect(isAbsolute(logPath)).toBe(true);
    expect(logPath).toBe(join(diagnostics, `boardsesh-duo-hinge-test-device-${process.pid}.log`));
  });
  it('retains the hinge log and both cleanup attempts when installation fails', () => {
    const logPath = join(diagnostics, 'source.log');
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('list')) return { status: 0, stdout: '123 0 com.apple.SpringBoard' };
      if (args.includes('setenv')) {
        writeFileSync(logPath, 'installation evidence');
        return { status: 1, stderr: 'failed' };
      }
      return { status: 0 };
    });
    expect(() => installDuoHinge('test-device', '/private-library', logPath)).toThrow('setenv');
    expect(spawnSyncMock.mock.calls.filter(([, args]) => args.includes('unsetenv'))).toHaveLength(2);
    const directory = join(diagnostics, 'duo-test-device-' + process.pid);
    expect(readFileSync(join(directory, 'hinge.log'), 'utf8')).toBe('installation evidence');
    expect(readFileSync(join(directory, 'startup.jsonl'), 'utf8')).not.toContain('/private-library');
  });

  it('diagnostic I/O failures cannot suppress cleanup or mask its original failure', () => {
    const logPath = join(diagnostics, 'source.log');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(appendFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });
    vi.mocked(copyFileSync).mockImplementation(() => {
      throw new Error('copy failed');
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      writeFileSync(logPath, 'coordinator ready');
      return true;
    });
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('list')) return { status: 0, stdout: '123 0 com.apple.SpringBoard' };
      if (args.includes('unsetenv')) return { status: 1, stderr: 'original cleanup failure' };
      return { status: 0 };
    });
    expect(() => installDuoHinge('test-device', '/private-library', logPath)).toThrow('original cleanup failure');
    expect(spawnSyncMock.mock.calls.filter(([, args]) => args.includes('unsetenv'))).toHaveLength(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
    vi.mocked(appendFileSync).mockReset();
    vi.mocked(copyFileSync).mockReset();
  });

  it.each([0, 1, null])('keeps cleanup failure fatal when empty getenv returns %s', (absenceStatus) => {
    const logPath = join(diagnostics, 'source.log');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      writeFileSync(logPath, 'coordinator ready');
      return true;
    });
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('list')) return { status: 0, stdout: '123 0 com.apple.SpringBoard' };
      if (args.includes('unsetenv') && args.includes('DYLD_INSERT_LIBRARIES')) {
        return { status: null, signal: 'SIGKILL', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
      }
      if (args.includes('getenv'))
        return {
          status: absenceStatus,
          stdout: '',
          ...(absenceStatus === null
            ? { signal: 'SIGKILL', error: Object.assign(new Error('readback timeout'), { code: 'ETIMEDOUT' }) }
            : {}),
        };
      return { status: 0 };
    });
    expect(() => installDuoHinge('test-device', '/private-library', logPath)).toThrow('unsetenv DYLD_INSERT_LIBRARIES');
    expect(spawnSyncMock.mock.calls.filter(([, args]) => args.includes('unsetenv'))).toHaveLength(2);
    const reads = spawnSyncMock.mock.calls.filter(([, args]) => args.includes('getenv'));
    expect(reads).toHaveLength(3);
    expect(reads.map(([, args]) => args.at(-1))).toEqual([
      'DYLD_INSERT_LIBRARIES',
      'BOARDSESH_DUO_HINGE_LOG',
      expect.stringMatching(/^BOARDSESH_DUO_NEVER_SET_[a-f0-9]{32}$/),
    ]);
    for (const [, , options] of reads) expect(options).toMatchObject({ timeout: 15_000, killSignal: 'SIGKILL' });
    const events = readFileSync(join(diagnostics, 'duo-test-device-' + process.pid, 'startup.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: 'launchctl unsetenv DYLD_INSERT_LIBRARIES',
        event: 'result',
        status: null,
        signal: 'SIGKILL',
        errorCode: 'ETIMEDOUT',
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ stage: 'wait coordinator ready', ready: true }));
    expect(events.filter((event) => event.event === 'end').every((event) => event.elapsedMs >= 0)).toBe(true);
    expect(
      events
        .filter((event) => event.stage.startsWith('launchctl getenv') && event.event === 'result')
        .every((event) => event.status === absenceStatus && event.stdoutPresent === false),
    ).toBe(true);
  });
});
