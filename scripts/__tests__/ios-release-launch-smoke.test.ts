import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  parseLaunchedPid,
  parseReleaseLaunchArgs,
  reportMatchesReleaseLaunch,
  runReleaseLaunchSmoke,
  workflowWarning,
  type ReleaseLaunchDependencies,
  type ReleaseLaunchSummary,
  type SmokeCommandResult,
} from '../ios-release-launch-smoke';
import type { IosDiagnosticReport } from '../lib/ios-capture-diagnostics';

const device = '11111111-2222-3333-4444-555555555555';
const otherDevice = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const bundleIdentifier = 'com.boardsesh.app';
const pid = 12345;
const roots: string[] = [];

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-release-smoke-test-'));
  roots.push(directory);
  const appPath = join(directory, 'Release', 'Boardsesh.app');
  const evidenceDir = join(directory, 'evidence');
  mkdirSync(appPath, { recursive: true });
  writeFileSync(join(appPath, 'main.jsbundle'), 'embedded release bundle fixture');
  const events: string[] = [];
  const commandCalls: { command: string; args: string[]; timeoutMs: number }[] = [];
  let clock = 0;
  let snapshotCount = 0;
  const controls = {
    deadAt: Number.POSITIVE_INFINITY,
    launchOutput: `${bundleIdentifier}: ${pid}\n`,
    failAction: '',
    timeoutAction: '',
    baseline: [] as IosDiagnosticReport[],
    currentReports: (): IosDiagnosticReport[] => [],
    reportContents: new Map<string, string>(),
    simulatorState: 'Shutdown',
    preserveError: false,
    leaseError: false,
    leaseReleaseError: false,
  };
  const result = (stdout = ''): SmokeCommandResult => ({ status: 0, stdout, stderr: '' });
  const release = vi.fn(() => {
    events.push('release');
    if (controls.leaseReleaseError) throw new Error('lease release fixture failure');
  });
  const dependencies: ReleaseLaunchDependencies = {
    run: vi.fn((command, args, timeoutMs) => {
      commandCalls.push({ command, args, timeoutMs });
      const action = command === 'plutil' ? 'plutil' : args[1];
      events.push(action);
      if (action === 'terminate') {
        // Proves the verdict was preserved before cleanup can destroy process evidence.
        events.push(
          `preserved-${JSON.parse(readFileSync(join(evidenceDir, 'summary.json'), 'utf8')).status as string}`,
        );
      }
      if (action === controls.timeoutAction) return { ...result(), status: 1, error: 'spawnSync ETIMEDOUT' };
      if (action === controls.failAction) return { ...result(), status: 1, stderr: `${action} fixture failure` };
      if (command === 'plutil') return result(bundleIdentifier);
      if (action === 'list')
        return result(JSON.stringify({ devices: { runtime: [{ udid: device, state: controls.simulatorState }] } }));
      if (action === 'launch') return result(controls.launchOutput);
      return result();
    }),
    now: () => clock,
    sleep: vi.fn(async (milliseconds) => {
      clock += milliseconds;
    }),
    isProcessAlive: vi.fn((candidate) => candidate === pid && clock < controls.deadAt),
    acquireLease: vi.fn(() => {
      if (controls.leaseError) throw new Error('simulator already leased');
      return { release };
    }),
    reportDirectories: () => [
      '/host/DiagnosticReports',
      `/Library/Developer/CoreSimulator/Devices/${device}/data/Library/Logs/DiagnosticReports`,
    ],
    snapshotReports: vi.fn(() => (snapshotCount++ === 0 ? controls.baseline : controls.currentReports())),
    readReport: (path) => {
      const contents = controls.reportContents.get(path);
      if (contents === undefined) throw new Error(`Fixture report missing: ${path}`);
      return contents;
    },
    preserveDiagnostics: vi.fn((input) => {
      events.push('preserve');
      if (controls.preserveError) throw new Error('diagnostic fixture failure');
      input.runCommand(['simctl', 'spawn', device, 'launchctl', 'list']);
      return join(evidenceDir, 'native-evidence');
    }),
  };
  const options = { appPath, device, evidenceDir };
  return {
    options,
    controls,
    dependencies,
    events,
    commandCalls,
    release,
    run: () => runReleaseLaunchSmoke(options, dependencies),
    summary: () => JSON.parse(readFileSync(join(evidenceDir, 'summary.json'), 'utf8')) as ReleaseLaunchSummary,
  };
}

function modernReport(reportPid = pid, reportDevice?: string): string {
  return `${JSON.stringify({ app_name: 'Boardsesh', bundleID: bundleIdentifier })}\n${JSON.stringify(
    {
      pid: reportPid,
      procName: 'Boardsesh',
      procPath: reportDevice
        ? `/Library/Developer/CoreSimulator/Devices/${reportDevice}/data/Containers/Bundle/Application/Boardsesh.app/Boardsesh`
        : '/Applications/Boardsesh.app/Boardsesh',
      bundleInfo: { CFBundleIdentifier: bundleIdentifier },
    },
    null,
    2,
  )}`;
}

describe('Release launch CLI and PID parsing', () => {
  it('escapes a warning so it stays one GitHub Actions annotation', () => {
    expect(workflowWarning('launchctl list: 100% stuck\r\n::error::forged')).toBe(
      '::warning title=iOS Release launch smoke::launchctl list: 100%25 stuck%0D%0A::error::forged',
    );
  });

  it('requires explicit app, simulator UDID and evidence directory', () => {
    expect(
      parseReleaseLaunchArgs(['--app', '/Release/Boardsesh.app', '--device', device, '--evidence-dir', '/evidence']),
    ).toEqual({ appPath: '/Release/Boardsesh.app', device, evidenceDir: '/evidence' });
    for (const args of [
      [],
      ['--app', '/app'],
      ['--app', '/app', '--device', 'booted', '--evidence-dir', '/evidence'],
      ['--app', '/app', '--device', '-'.repeat(36), '--evidence-dir', '/evidence'],
      ['--app', '/app', '--device', 'a'.repeat(36), '--evidence-dir', '/evidence'],
      ['--app', '/app', '--app', '/other'],
      ['--unknown', 'option'],
    ])
      expect(() => parseReleaseLaunchArgs(args)).toThrow();
  });

  it('only accepts one positive PID belonging to the requested bundle', () => {
    expect(parseLaunchedPid(`${bundleIdentifier}: ${pid}\n`, bundleIdentifier)).toBe(pid);
    for (const output of [
      '',
      `${bundleIdentifier}: 0`,
      `${bundleIdentifier}: -12`,
      `${bundleIdentifier}: 123x`,
      `${bundleIdentifier}: 1.5`,
      `${bundleIdentifier}: 9007199254740992`,
      `other.app: ${pid}`,
      `${bundleIdentifier}: ${pid}\n${bundleIdentifier}: 1`,
    ])
      expect(() => parseLaunchedPid(output, bundleIdentifier)).toThrow();
  });
});

describe('attributing fresh native crash fixtures', () => {
  const attribution = { path: '/host/DiagnosticReports/Boardsesh-new.ips', pid, device, bundleIdentifier };

  it('recognizes modern IPS metadata followed by a report for the original PID', () => {
    expect(reportMatchesReleaseLaunch({ ...attribution, contents: modernReport() })).toBe(true);
  });

  it('recognizes a legacy crash report for the original PID', () => {
    expect(
      reportMatchesReleaseLaunch({
        ...attribution,
        contents: `Process: Boardsesh [${pid}]\nIdentifier: ${bundleIdentifier}\nException Type: EXC_BAD_ACCESS`,
      }),
    ).toBe(true);
  });

  it('recognizes selected-simulator app crashes when the report has no PID', () => {
    const contents = JSON.stringify({
      procName: 'Boardsesh',
      procPath: `/Library/Developer/CoreSimulator/Devices/${device}/data/Boardsesh.app/Boardsesh`,
    });
    expect(reportMatchesReleaseLaunch({ ...attribution, contents })).toBe(true);
    expect(
      reportMatchesReleaseLaunch({
        ...attribution,
        path: `/Library/Developer/CoreSimulator/Devices/${device}/data/Library/Logs/DiagnosticReports/Boardsesh-new.ips`,
        contents: JSON.stringify({ app_name: 'Boardsesh' }),
      }),
    ).toBe(true);
  });

  it('ignores a delayed crash from an earlier PID on this simulator', () => {
    expect(reportMatchesReleaseLaunch({ ...attribution, contents: modernReport(67890, device) })).toBe(false);
    expect(
      reportMatchesReleaseLaunch({
        ...attribution,
        path: `/Library/Developer/CoreSimulator/Devices/${device}/data/Library/Logs/DiagnosticReports/Boardsesh-new.ips`,
        contents: modernReport(67890),
      }),
    ).toBe(false);
  });

  it('rejects host reports for other simulators and unrelated apps or malformed reports', () => {
    expect(reportMatchesReleaseLaunch({ ...attribution, contents: modernReport(67890, otherDevice) })).toBe(false);
    expect(
      reportMatchesReleaseLaunch({ ...attribution, contents: JSON.stringify({ pid, procName: 'OtherApp' }) }),
    ).toBe(false);
    expect(
      reportMatchesReleaseLaunch({
        ...attribution,
        contents: JSON.stringify({
          pid,
          procName: 'Boardsesh',
          bundleInfo: { CFBundleIdentifier: 'com.boardsesh.other' },
        }),
      }),
    ).toBe(false);
    expect(
      reportMatchesReleaseLaunch({ ...attribution, contents: 'Boardsesh report has no attributable PID or device' }),
    ).toBe(false);
  });
});

describe('Release simulator launch smoke', () => {
  it('checks the same PID from zero through the final 20-second boundary, preserving evidence before cleanup', async () => {
    const smoke = fixture();
    const summary = await smoke.run();
    expect(summary.status).toBe('passed');
    expect(summary.pid).toBe(pid);
    expect(summary.observations).toEqual(
      Array.from({ length: 21 }, (_, second) => ({ elapsedMs: second * 1000, alive: true })),
    );
    expect(smoke.dependencies.sleep).toHaveBeenCalledTimes(20);
    expect(smoke.dependencies.isProcessAlive).toHaveBeenCalledTimes(22);
    expect(smoke.commandCalls.filter((call) => call.args[1] === 'launch')).toHaveLength(1);
    const launch = smoke.commandCalls.find((call) => call.args[1] === 'launch');
    expect(launch?.args).toEqual([
      'simctl',
      'launch',
      '--terminate-running-process',
      `--stdout=${join(smoke.options.evidenceDir, 'app-stdout.log')}`,
      `--stderr=${join(smoke.options.evidenceDir, 'app-stderr.log')}`,
      device,
      bundleIdentifier,
    ]);
    expect(smoke.events.slice(-6)).toEqual(['preserve', 'spawn', 'spawn', 'terminate', 'preserved-passed', 'release']);
    expect(smoke.commandCalls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 300_000)).toBe(true);
    expect(smoke.summary().diagnosticWarnings).toBeUndefined();
    expect(smoke.commandCalls.find((call) => call.args[1] === 'install')?.args).toEqual([
      'simctl',
      'install',
      device,
      smoke.options.appPath,
    ]);
    expect(
      smoke.commandCalls.some(
        (call) => call.args.includes('booted') || call.args.includes('shutdown') || call.args.includes('delete'),
      ),
    ).toBe(false);
  });

  it('does not boot a simulator already booted', async () => {
    const smoke = fixture();
    smoke.controls.simulatorState = 'Booted';
    await smoke.run();
    expect(smoke.events).not.toContain('boot');
    expect(smoke.events).toContain('bootstatus');
  });

  for (const deathAt of [0, 19_000, 19_999, 20_000]) {
    it(`rejects a deliberately broken launch fixture dying at ${deathAt}ms without relaunching`, async () => {
      const smoke = fixture();
      smoke.controls.deadAt = deathAt;
      await expect(smoke.run()).rejects.toThrow(/Original app PID 12345 exited/);
      expect(smoke.summary().status).toBe('failed');
      expect(smoke.summary().observations.at(-1)).toEqual({
        elapsedMs: Math.ceil(deathAt / 1000) * 1000,
        alive: false,
      });
      expect(smoke.commandCalls.filter((call) => call.args[1] === 'launch')).toHaveLength(1);
      expect(smoke.events).toContain('preserve');
      expect(smoke.events).not.toContain('terminate');
      expect(smoke.release).toHaveBeenCalledOnce();
    });
  }

  it('rejects a fresh attributable crash while the original PID remains alive', async () => {
    const smoke = fixture();
    const report = { path: '/host/DiagnosticReports/Boardsesh-new.ips', modifiedMs: 1, bytes: 100 };
    smoke.controls.currentReports = () => [report];
    smoke.controls.reportContents.set(report.path, modernReport());
    await expect(smoke.run()).rejects.toThrow(/Fresh crash report/);
    expect(smoke.summary().crashReports).toEqual([report.path]);
    expect(smoke.events.slice(-3)).toEqual(['terminate', 'preserved-failed', 'release']);
  });

  it('checks for a newly written crash report at the final 20-second boundary', async () => {
    const smoke = fixture();
    const report = { path: '/host/DiagnosticReports/Boardsesh-final.ips', modifiedMs: 1, bytes: 100 };
    smoke.controls.currentReports = () => (smoke.dependencies.now() >= 20_000 ? [report] : []);
    smoke.controls.reportContents.set(report.path, modernReport());
    await expect(smoke.run()).rejects.toThrow(/Fresh crash report/);
    expect(smoke.summary().observations.at(-1)).toEqual({ elapsedMs: 20_000, alive: true });
  });

  it('ignores unchanged stale reports and fresh crashes from unrelated simulators', async () => {
    const smoke = fixture();
    const stale = { path: '/host/DiagnosticReports/Boardsesh-stale.ips', modifiedMs: 1, bytes: 100 };
    const unrelated = { path: '/host/DiagnosticReports/Boardsesh-unrelated.ips', modifiedMs: 2, bytes: 100 };
    smoke.controls.baseline = [stale];
    smoke.controls.currentReports = () => [stale, unrelated];
    smoke.controls.reportContents.set(stale.path, modernReport());
    smoke.controls.reportContents.set(unrelated.path, modernReport(67890, otherDevice));
    await expect(smoke.run()).resolves.toMatchObject({ status: 'passed', crashReports: [] });
  });

  it('detects a report overwritten since the prelaunch baseline', async () => {
    const smoke = fixture();
    const stale = { path: '/host/DiagnosticReports/Boardsesh-overwritten.ips', modifiedMs: 1, bytes: 100 };
    smoke.controls.baseline = [stale];
    smoke.controls.currentReports = () => [{ ...stale, modifiedMs: 2 }];
    smoke.controls.reportContents.set(stale.path, modernReport());
    await expect(smoke.run()).rejects.toThrow(/Fresh crash report/);
  });

  for (const action of ['boot', 'bootstatus', 'install', 'launch']) {
    it(`fails a broken ${action} fixture and preserves evidence without retry`, async () => {
      const smoke = fixture();
      smoke.controls.failAction = action;
      await expect(smoke.run()).rejects.toThrow(`${action} fixture failure`);
      expect(smoke.events.filter((event) => event === action)).toHaveLength(1);
      expect(smoke.events).toContain('preserve');
      expect(smoke.release).toHaveBeenCalledOnce();
    });
  }

  it('fails a bounded command timeout', async () => {
    const smoke = fixture();
    smoke.controls.timeoutAction = 'launch';
    await expect(smoke.run()).rejects.toThrow(/ETIMEDOUT/);
    expect(smoke.release).toHaveBeenCalledOnce();
  });

  it('rejects malformed launch output without guessing a PID to terminate', async () => {
    const smoke = fixture();
    smoke.controls.launchOutput = 'launch appeared successful';
    await expect(smoke.run()).rejects.toThrow(/did not return one PID/);
    expect(smoke.events).not.toContain('terminate');
    expect(smoke.release).toHaveBeenCalledOnce();
  });

  it('requires an embedded release bundle before touching the simulator', async () => {
    const smoke = fixture();
    rmSync(join(smoke.options.appPath, 'main.jsbundle'));
    await expect(smoke.run()).rejects.toThrow(/missing embedded main.jsbundle/);
    expect(smoke.dependencies.acquireLease).not.toHaveBeenCalled();
    expect(smoke.commandCalls).toEqual([]);
  });

  it('does not steal a simulator lease', async () => {
    const smoke = fixture();
    smoke.controls.leaseError = true;
    await expect(smoke.run()).rejects.toThrow(/already leased/);
    expect(smoke.events).toEqual(['plutil']);
  });

  it('releases its lease even when diagnostic preservation fails', async () => {
    const smoke = fixture();
    smoke.controls.preserveError = true;
    await expect(smoke.run()).rejects.toThrow(/diagnostic fixture failure/);
    expect(smoke.events.slice(-3)).toEqual(['terminate', 'preserved-failed', 'release']);
    expect(smoke.summary().status).toBe('failed');
  });

  it('keeps a measured pass when process/log evidence times out, and records a warning', async () => {
    // Runs 40105247401 and 40116242780: the PID lived 20 s with no crash report, then
    // `launchctl list` hit its limit and that alone failed the job.
    const smoke = fixture();
    smoke.controls.timeoutAction = 'spawn';
    const warnings = [
      'Diagnostic collection failed: launchctl list: spawnSync ETIMEDOUT',
      'Diagnostic collection failed: log show: spawnSync ETIMEDOUT',
    ];
    await expect(smoke.run()).resolves.toMatchObject({ status: 'passed', diagnosticWarnings: warnings });
    expect(smoke.summary()).toMatchObject({ status: 'passed', crashReports: [], diagnosticWarnings: warnings });
    expect(smoke.summary().error).toBeUndefined();
    expect(smoke.events.slice(-3)).toEqual(['terminate', 'preserved-passed', 'release']);
    expect(smoke.release).toHaveBeenCalledOnce();
  });

  it('names a failed diagnostic by its stderr or exit status', async () => {
    const smoke = fixture();
    smoke.controls.failAction = 'spawn';
    await expect(smoke.run()).resolves.toMatchObject({
      status: 'passed',
      diagnosticWarnings: [
        'Diagnostic collection failed: launchctl list: spawn fixture failure',
        'Diagnostic collection failed: log show: spawn fixture failure',
      ],
    });
    const silent = fixture();
    const { run } = silent.dependencies;
    silent.dependencies.run = (command, args, timeoutMs) =>
      args[1] === 'spawn' ? { status: 3, stdout: '', stderr: '' } : run(command, args, timeoutMs);
    await expect(silent.run()).resolves.toMatchObject({
      diagnosticWarnings: expect.arrayContaining([expect.stringMatching(/launchctl list: exit status 3$/)]),
    });
    const noisy = fixture();
    const noisyRun = noisy.dependencies.run;
    noisy.dependencies.run = (command, args, timeoutMs) =>
      args[1] === 'spawn' ? { status: 1, stdout: '', stderr: 'x'.repeat(5_000) } : noisyRun(command, args, timeoutMs);
    const { diagnosticWarnings } = await noisy.run();
    expect(diagnosticWarnings?.[0]).toBe(`Diagnostic collection failed: launchctl list: ${'x'.repeat(300)}…`);
  });

  it('gives each diagnostic 60 s and the install 300 s', async () => {
    const smoke = fixture();
    await smoke.run();
    const timeouts = new Map(
      smoke.commandCalls.map((call) => [
        call.args.slice(call.args[1] === 'spawn' ? 3 : 1, 5).join(' '),
        call.timeoutMs,
      ]),
    );
    expect(timeouts.get('launchctl list')).toBe(60_000);
    expect(timeouts.get('log show')).toBe(60_000);
    expect(timeouts.get(`install ${device} ${smoke.options.appPath}`)).toBe(300_000);
  });

  it('fits every command bound and the survival window inside the workflow step timeout', async () => {
    const smoke = fixture();
    await smoke.run();
    const workflow = parse(
      readFileSync(join(import.meta.dirname, '../../.github/workflows/ios-rn-ci.yml'), 'utf8'),
    ) as { jobs: Record<string, { steps: { name?: string; 'timeout-minutes'?: number }[] }> };
    const step = workflow.jobs['build-and-test'].steps.find(
      (candidate) => candidate.name === 'Launch the Release app and watch for crashes',
    );
    const worstCaseMs = smoke.commandCalls.reduce((total, call) => total + call.timeoutMs, 20_000);
    // A cancelled step loses its summary, so keep a few minutes for tsx startup and polling overhead.
    expect(worstCaseMs + 3 * 60_000).toBeLessThanOrEqual((step?.['timeout-minutes'] ?? 0) * 60_000);
  });

  it.each([
    ['exits', { deadAt: 5_000 }, /Original app PID 12345 exited after 5000ms/],
    ['writes a fresh crash report', { crash: true }, /Fresh crash report/],
  ] as const)('still fails when the PID %s and diagnostics also time out', async (_label, failure, message) => {
    const smoke = fixture();
    smoke.controls.timeoutAction = 'spawn';
    if ('deadAt' in failure) smoke.controls.deadAt = failure.deadAt;
    if ('crash' in failure) {
      const report = { path: '/host/DiagnosticReports/Boardsesh-new.ips', modifiedMs: 1, bytes: 100 };
      smoke.controls.currentReports = () => [report];
      smoke.controls.reportContents.set(report.path, modernReport());
    }
    await expect(smoke.run()).rejects.toThrow(message);
    expect(smoke.summary().status).toBe('failed');
    expect(smoke.summary().error).toMatch(message);
    expect(smoke.summary().diagnosticWarnings).toHaveLength(2);
    expect(smoke.release).toHaveBeenCalledOnce();
  });

  it('records how long each simulator command took', async () => {
    const smoke = fixture();
    const { now, run } = smoke.dependencies;
    let commandTimeMs = 0;
    smoke.dependencies.now = () => now() + commandTimeMs;
    smoke.dependencies.run = (command, args, timeoutMs) => {
      if (args[1] === 'install') commandTimeMs += 90_000;
      if (args[3] === 'launchctl') commandTimeMs += 45_000;
      return run(command, args, timeoutMs);
    };
    await smoke.run();
    const commands = readFileSync(join(smoke.options.evidenceDir, 'commands.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; durationMs: number });
    expect(commands.find((entry) => entry.args[1] === 'install')?.durationMs).toBe(90_000);
    expect(commands.find((entry) => entry.args[3] === 'launchctl')?.durationMs).toBe(45_000);
    expect(commands.find((entry) => entry.args[1] === 'launch')?.durationMs).toBe(0);
  });

  it('keeps the original launch failure when cleanup also fails', async () => {
    const smoke = fixture();
    smoke.controls.currentReports = () => [
      { path: '/host/DiagnosticReports/Boardsesh-new.ips', modifiedMs: 1, bytes: 100 },
    ];
    smoke.controls.reportContents.set('/host/DiagnosticReports/Boardsesh-new.ips', modernReport());
    smoke.controls.failAction = 'terminate';
    await expect(smoke.run()).rejects.toThrow(/Fresh crash report/);
    expect(smoke.summary().cleanupError).toMatch(/terminate fixture failure/);
    expect(smoke.release).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'preserves the launch error if the final summary write fails (prior failure: %s)',
    async (priorFailure) => {
      const smoke = fixture();
      if (priorFailure) {
        const crashPath = '/host/DiagnosticReports/Boardsesh-new.ips';
        smoke.controls.currentReports = () => [{ path: crashPath, modifiedMs: 1, bytes: 100 }];
        smoke.controls.reportContents.set(crashPath, modernReport());
      }
      const runCommand = smoke.dependencies.run;
      smoke.dependencies.run = (command, args, timeoutMs) => {
        const commandResult = runCommand(command, args, timeoutMs);
        if (args[1] === 'terminate') {
          const summaryPath = join(smoke.options.evidenceDir, 'summary.json');
          rmSync(summaryPath);
          mkdirSync(summaryPath);
        }
        return commandResult;
      };
      await expect(smoke.run()).rejects.toThrow(priorFailure ? /Fresh crash report/ : /Could not write launch summary/);
      expect(smoke.release).toHaveBeenCalledOnce();
    },
  );

  it('retains the measured passing verdict and records cleanup or lease release failures', async () => {
    for (const failLease of [false, true]) {
      const smoke = fixture();
      smoke.controls.failAction = failLease ? '' : 'terminate';
      smoke.controls.leaseReleaseError = failLease;
      await expect(smoke.run()).resolves.toMatchObject({
        status: 'passed',
        cleanupError: expect.stringMatching(/fixture failure/),
      });
      expect(smoke.summary().status).toBe('passed');
      expect(smoke.release).toHaveBeenCalledOnce();
    }
  });
});
