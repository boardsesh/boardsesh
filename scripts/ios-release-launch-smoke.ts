import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  iosDiagnosticReportDirectories,
  preserveIosCaptureDiagnostics,
  snapshotIosDiagnosticReports,
  type IosDiagnosticReport,
} from './lib/ios-capture-diagnostics';
import { acquireSimulatorLease, processIsAlive } from './lib/ios-simulator-lease';

const survivalWindowMs = 20_000;
const pollIntervalMs = 1_000;
const simulatorUdidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ReleaseLaunchOptions {
  appPath: string;
  device: string;
  evidenceDir: string;
}

export interface SmokeCommandResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ReleaseLaunchDependencies {
  run: (command: string, args: string[], timeoutMs: number) => SmokeCommandResult;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  acquireLease: (device: string) => { release(): void };
  reportDirectories: (device: string) => string[];
  snapshotReports: (directories: readonly string[]) => IosDiagnosticReport[];
  readReport: (path: string) => string;
  preserveDiagnostics: typeof preserveIosCaptureDiagnostics;
}

export interface ReleaseLaunchSummary {
  status: 'passed' | 'failed';
  appPath: string;
  device: string;
  bundleIdentifier?: string;
  pid?: number;
  observations: { elapsedMs: number; alive: boolean }[];
  crashReports: string[];
  diagnosticsDir?: string;
  error?: string;
  cleanupError?: string;
}

const defaultDependencies: ReleaseLaunchDependencies = {
  run(command, args, timeoutMs) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error.message } : {}),
    };
  },
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  isProcessAlive: processIsAlive,
  acquireLease: (device) => acquireSimulatorLease(device, root),
  reportDirectories: iosDiagnosticReportDirectories,
  snapshotReports: snapshotIosDiagnosticReports,
  readReport: (path) => readFileSync(path, 'utf8'),
  preserveDiagnostics: preserveIosCaptureDiagnostics,
};

export function parseReleaseLaunchArgs(args: readonly string[]): ReleaseLaunchOptions {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const argument = args[index + 1];
    if (!['--app', '--device', '--evidence-dir'].includes(flag) || !argument || argument.startsWith('--'))
      throw new Error('Usage: --app <Release .app> --device <UDID> --evidence-dir <directory>');
    if (options.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    options.set(flag, argument);
  }
  const appPath = options.get('--app');
  const device = options.get('--device');
  const evidenceDir = options.get('--evidence-dir');
  if (!appPath || !device || !evidenceDir)
    throw new Error('Usage: --app <Release .app> --device <UDID> --evidence-dir <directory>');
  if (!simulatorUdidPattern.test(device)) throw new Error('--device requires an explicit simulator UDID.');
  return { appPath: resolve(appPath), device, evidenceDir: resolve(evidenceDir) };
}

export function parseLaunchedPid(output: string, bundleIdentifier: string): number {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0].startsWith(`${bundleIdentifier}: `))
    throw new Error(`simctl launch did not return one PID for ${bundleIdentifier}: ${output.trim()}`);
  const pidText = lines[0].slice(bundleIdentifier.length + 2);
  const pid = Number(pidText);
  if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(pid))
    throw new Error(`simctl launch returned an invalid PID: ${output.trim()}`);
  return pid;
}

function record(candidate: unknown): Record<string, unknown> | null {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function ipsObjects(contents: string): Record<string, unknown>[] {
  // Modern .ips files contain a one-line metadata object followed by a JSON report.
  for (const candidates of [
    [contents],
    [contents.slice(0, contents.indexOf('\n')), contents.slice(contents.indexOf('\n') + 1)],
  ]) {
    try {
      return candidates.map((candidate) => record(JSON.parse(candidate) as unknown)).filter((item) => item !== null);
    } catch {
      // Legacy .crash files are plain text; handled below.
    }
  }
  return [];
}

/** Attribute a fresh report to this launch, never merely to the Boardsesh filename. */
export function reportMatchesReleaseLaunch(input: {
  path: string;
  contents: string;
  pid: number;
  device: string;
  bundleIdentifier: string;
}): boolean {
  const reports = ipsObjects(input.contents);
  const bundle = reports.map((report) => record(report.bundleInfo)?.CFBundleIdentifier ?? report.bundleID);
  const appName = reports.map((report) => report.procName ?? report.app_name);
  const legacyIdentifier = /^Identifier:\s+(\S+)\s*$/m.exec(input.contents)?.[1];
  const knownIdentifiers = [...bundle, legacyIdentifier].filter((identifier) => typeof identifier === 'string');
  if (knownIdentifiers.length > 0 && !knownIdentifiers.includes(input.bundleIdentifier)) return false;
  const namesApp =
    bundle.includes(input.bundleIdentifier) ||
    appName.includes('Boardsesh') ||
    /^Process:\s+Boardsesh\s+\[\d+\]/m.test(input.contents) ||
    legacyIdentifier === input.bundleIdentifier;
  if (!namesApp) return false;
  const reportPids = reports.map((report) => report.pid);
  const legacyPid = /^Process:\s+Boardsesh\s+\[(\d+)\]/m.exec(input.contents)?.[1];
  if (reportPids.includes(input.pid) || Number(legacyPid) === input.pid) return true;
  // A prior process's delayed report can arrive after this launch on the same simulator.
  if (reportPids.some((reportPid) => typeof reportPid === 'number') || legacyPid !== undefined) return false;
  // Simulator paths also appear in procPath/Path; a host report can describe another simulator.
  const devicePath = `/CoreSimulator/Devices/${input.device}/`.toLowerCase();
  return input.path.toLowerCase().includes(devicePath) || input.contents.toLowerCase().includes(devicePath);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Install once, cold-launch once, and keep the original process alive for the entire window. */
export async function runReleaseLaunchSmoke(
  options: ReleaseLaunchOptions,
  overrides: Partial<ReleaseLaunchDependencies> = {},
): Promise<ReleaseLaunchSummary> {
  const dependencies = { ...defaultDependencies, ...overrides };
  mkdirSync(options.evidenceDir, { recursive: true });
  const summary: ReleaseLaunchSummary = {
    status: 'failed',
    appPath: options.appPath,
    device: options.device,
    observations: [],
    crashReports: [],
  };
  const writeSummary = () => {
    try {
      writeFileSync(join(options.evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2));
    } catch (error) {
      summary.status = 'failed';
      summary.error ??= `Could not write launch summary: ${failureMessage(error)}`;
    }
  };
  const run = (command: string, args: string[], timeoutMs: number): SmokeCommandResult => {
    const result = dependencies.run(command, args, timeoutMs);
    appendFileSync(
      join(options.evidenceDir, 'commands.jsonl'),
      `${JSON.stringify({ command, args, timeoutMs, ...result })}\n`,
    );
    return result;
  };
  const checked = (command: string, args: string[], timeoutMs: number): string => {
    const result = run(command, args, timeoutMs);
    if (result.status !== 0 || result.error)
      throw new Error(`${command} ${args.join(' ')} failed: ${result.error ?? result.stderr ?? result.status}`);
    return result.stdout.trim();
  };
  let lease: { release(): void } | undefined;
  let baseline: IosDiagnosticReport[] = [];
  let directories: string[] = [];
  try {
    if (!simulatorUdidPattern.test(options.device))
      throw new Error('A smoke test requires an explicit simulator UDID.');
    if (!existsSync(join(options.appPath, 'main.jsbundle')))
      throw new Error('Release app is missing embedded main.jsbundle.');
    const bundleIdentifier = checked(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(options.appPath, 'Info.plist')],
      15_000,
    );
    summary.bundleIdentifier = bundleIdentifier;
    if (!/^com\.boardsesh\.[A-Za-z0-9.-]+$/.test(bundleIdentifier))
      throw new Error(`Unexpected Boardsesh bundle identifier: ${bundleIdentifier}`);
    lease = dependencies.acquireLease(options.device);
    const listing = JSON.parse(checked('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], 30_000)) as {
      devices: Record<string, { udid: string; state: string }[]>;
    };
    const device = Object.values(listing.devices)
      .flat()
      .find((candidate) => candidate.udid.toUpperCase() === options.device.toUpperCase());
    if (!device) throw new Error(`Selected simulator ${options.device} is unavailable.`);
    if (device.state !== 'Booted') checked('xcrun', ['simctl', 'boot', options.device], 120_000);
    checked('xcrun', ['simctl', 'bootstatus', options.device, '-b'], 180_000);
    checked('xcrun', ['simctl', 'install', options.device, options.appPath], 120_000);
    directories = dependencies.reportDirectories(options.device);
    baseline = dependencies.snapshotReports(directories);
    const launchOutput = checked(
      'xcrun',
      [
        'simctl',
        'launch',
        '--terminate-running-process',
        `--stdout=${join(options.evidenceDir, 'app-stdout.log')}`,
        `--stderr=${join(options.evidenceDir, 'app-stderr.log')}`,
        options.device,
        bundleIdentifier,
      ],
      60_000,
    );
    const launchedPid = parseLaunchedPid(launchOutput, bundleIdentifier);
    summary.pid = launchedPid;
    const launchedAt = dependencies.now();
    const previous = new Map(baseline.map((report) => [report.path, report]));
    for (;;) {
      const elapsedMs = dependencies.now() - launchedAt;
      const alive = dependencies.isProcessAlive(launchedPid);
      summary.observations.push({ elapsedMs, alive });
      summary.crashReports = dependencies
        .snapshotReports(directories)
        .filter((report) => {
          const existing = previous.get(report.path);
          if (existing && existing.modifiedMs === report.modifiedMs && existing.bytes === report.bytes) return false;
          return reportMatchesReleaseLaunch({
            path: report.path,
            contents: dependencies.readReport(report.path),
            pid: launchedPid,
            device: options.device,
            bundleIdentifier,
          });
        })
        .map((report) => report.path);
      if (!alive) throw new Error(`Original app PID ${summary.pid} exited after ${elapsedMs}ms.`);
      if (summary.crashReports.length > 0)
        throw new Error(`Fresh crash report for this launch: ${summary.crashReports.join(', ')}`);
      if (elapsedMs >= survivalWindowMs) break;
      await dependencies.sleep(Math.min(pollIntervalMs, survivalWindowMs - elapsedMs));
    }
    summary.status = 'passed';
  } catch (error) {
    summary.error = failureMessage(error);
  } finally {
    // Gather while the selected device and original process still exist, before terminating anything.
    try {
      if (lease) {
        let diagnosticFailure: string | undefined;
        summary.diagnosticsDir = dependencies.preserveDiagnostics({
          udid: options.device,
          debugDir: options.evidenceDir,
          nativeLogPath: join(options.evidenceDir, 'app-stderr.log'),
          reportDirectories: directories,
          baseline,
          runCommand: (args) => {
            const result = run('xcrun', args, 30_000);
            if (result.status !== 0 || result.error)
              diagnosticFailure = result.error ?? result.stderr ?? 'Process evidence unavailable.';
            return result;
          },
        });
        if (summary.pid !== undefined) {
          const logs = run(
            'xcrun',
            [
              'simctl',
              'spawn',
              options.device,
              'log',
              'show',
              '--style',
              'compact',
              '--last',
              '2m',
              '--predicate',
              `processIdentifier == ${summary.pid}`,
            ],
            30_000,
          );
          writeFileSync(join(options.evidenceDir, 'device.log'), `${logs.stdout}\n${logs.stderr}`);
          if (logs.status !== 0 || logs.error)
            diagnosticFailure = logs.error ?? logs.stderr ?? 'Device logs unavailable.';
        }
        if (diagnosticFailure) {
          summary.status = 'failed';
          summary.error ??= `Diagnostic collection failed: ${diagnosticFailure}`;
        }
      }
    } catch (error) {
      summary.status = 'failed';
      summary.error ??= failureMessage(error);
    }
    writeSummary();
    try {
      if (summary.pid !== undefined && summary.bundleIdentifier && dependencies.isProcessAlive(summary.pid))
        checked('xcrun', ['simctl', 'terminate', options.device, summary.bundleIdentifier], 15_000);
    } catch (error) {
      summary.cleanupError = failureMessage(error);
    } finally {
      try {
        lease?.release();
      } catch (error) {
        summary.cleanupError ??= failureMessage(error);
      }
      writeSummary();
    }
  }
  if (summary.status !== 'passed')
    throw new Error(summary.error ?? summary.cleanupError ?? 'Release launch smoke failed.');
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseLaunchSmoke(parseReleaseLaunchArgs(process.argv.slice(2))).then(
    (summary) => {
      console.log(
        `[ios-release-smoke] ${summary.bundleIdentifier} PID ${summary.pid} survived 20 seconds on ${summary.device}.`,
      );
      if (summary.cleanupError) console.warn(`[ios-release-smoke] Cleanup: ${summary.cleanupError}`);
    },
    (error: unknown) => {
      console.error(`[ios-release-smoke] ${failureMessage(error)}`);
      process.exitCode = 1;
    },
  );
}
