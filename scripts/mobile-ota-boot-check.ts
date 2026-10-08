/// <reference types="node" />

/**
 * Boot check: prove that the update a branch is serving for one commit starts
 * on a release build of the app.
 *
 *   node --experimental-strip-types scripts/mobile-ota-boot-check.ts \
 *     --platform ios --app-path <Boardsesh.app> --branch pr-staging \
 *     --expect-commit <sha> --receipt <receipt.json>
 *
 *   node --experimental-strip-types scripts/mobile-ota-boot-check.ts \
 *     pin-android-project --branch pr-staging --android-dir packages/mobile/android
 *
 * What a run does, in order:
 *
 *   1. Reads the receipt for the commit and asks the server, with no
 *      credentials, what the branch serves a binary of that runtime version.
 *      If that is not the commit's update the run fails here.
 *   2. Checks the binary is one a phone could hold: same runtime version, and
 *      an embedded bundle older than the update.
 *   3. Installs it fresh on a booted simulator or emulator, pinned to the branch.
 *   4. Launch 1: waits for expo-updates to download the update.
 *   5. Launch 2: watches for expo-updates to launch that update and count a
 *      successful launch, which it does when React draws its first content.
 *   6. Prints the verdict and the evidence, and exits 0 only on a pass.
 *
 * The evidence is what expo-updates itself wrote: its `updates` table and its
 * log file, copied off the device. Nothing reads the screen.
 *
 * Node built-ins only, so the job that runs it needs no install. It shells out
 * to `xcrun simctl` or `adb`, and to the `sqlite3` CLI.
 *
 * See docs/mobile-ota-updates.md ("Boot check").
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { lookup } from 'node:dns/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ANDROID_EAS_PREFS_FILE,
  APP_BUNDLE_ID,
  BOOT_CHECK_CLIENT_IDS,
  BOOT_PLATFORMS,
  IOS_EAS_CLIENT_ID_KEY,
  OTA_APP_ID,
  SINKHOLE_ADDRESS,
  TELEMETRY_HOSTS,
  UPDATES_QUERY,
  androidEasClientPrefsXml,
  androidLaunchCommand,
  assertBranchName,
  checkBinary,
  evidenceFromCapture,
  ensureAndroidRoot,
  expectationFromReceipt,
  findFatalLogLines,
  formatVerdict,
  judgeBoot,
  parseUpdateRows,
  pinAndroidManifest,
  readEmbeddedManifest,
  readServedHead,
  resolveExpectedUpdate,
  updatesLogSince,
} from './lib/ota-boot-check.ts';
import type { BinaryDescription, BootCapture, BootPlatform } from './lib/ota-boot-check.ts';
import { classifyServedManifest, requestManifest, requireSuccess } from './lib/ota-publish-protocol.ts';

const LOG = '[mobile:ota-boot-check]';
const DEFAULT_MANIFEST_URL = 'https://updates.boardsesh.com/manifest';
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

export interface BootCheckOptions {
  platform: BootPlatform;
  appPath: string;
  branch: string;
  expectCommit: string;
  receiptPath: string;
  manifestUrl: string;
  /** Simulator UDID or emulator serial. Empty means the one booted device. */
  device: string;
  /** Where the raw evidence is written, for the run's artifact. */
  evidenceDir: string | null;
  /** Longest the first launch may take to download the update. */
  downloadTimeoutSeconds: number;
  /** How long the second launch is watched. */
  watchSeconds: number;
  /** Run even though the update's analytics hosts are reachable from the device. */
  allowTelemetry: boolean;
}

function flagValues(argv: readonly string[], valueFlags: readonly string[], switchFlags: readonly string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (switchFlags.includes(flag)) {
      switches.add(flag);
      continue;
    }
    if (!valueFlags.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    values.set(flag, value);
    index++;
  }
  return { values, switches };
}

function seconds(input: string | undefined, fallback: number, flag: string): number {
  if (input === undefined) return fallback;
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_600) throw new Error(`${flag} must be 1 to 3600 seconds.`);
  return parsed;
}

export function parseBootCheckArgs(argv: readonly string[], updatesUrl: string | undefined): BootCheckOptions {
  const { values, switches } = flagValues(
    argv,
    [
      '--platform',
      '--app-path',
      '--branch',
      '--expect-commit',
      '--receipt',
      '--manifest-url',
      '--device',
      '--evidence-dir',
      '--download-timeout',
      '--watch-seconds',
    ],
    ['--allow-telemetry'],
  );
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} is required.`);
    return value;
  };
  const platform = required('--platform');
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`--platform must be one of ${BOOT_PLATFORMS.join(', ')}.`);
  }
  const evidenceDir = values.get('--evidence-dir');
  return {
    platform,
    appPath: resolve(required('--app-path')),
    branch: assertBranchName(required('--branch')),
    expectCommit: required('--expect-commit'),
    receiptPath: resolve(required('--receipt')),
    manifestUrl: values.get('--manifest-url') ?? updatesUrl ?? DEFAULT_MANIFEST_URL,
    device: values.get('--device') ?? '',
    evidenceDir: evidenceDir === undefined ? null : resolve(evidenceDir),
    downloadTimeoutSeconds: seconds(values.get('--download-timeout'), 240, '--download-timeout'),
    watchSeconds: seconds(values.get('--watch-seconds'), 30, '--watch-seconds'),
    allowTelemetry: switches.has('--allow-telemetry'),
  };
}

function run(
  command: string,
  args: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  if (result.error) throw new Error(`${command} could not be run: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim().slice(0, 600)}`);
  }
  return result.stdout;
}

/** Reads the `updates` table from a copy of the database, WAL and all, as `sqlite3 -json` prints it. */
function queryUpdates(databasePath: string): string {
  return run('sqlite3', ['-readonly', '-json', databasePath, UPDATES_QUERY]);
}

/** What the check needs from a simulator or an emulator. */
interface BootDevice {
  /** A copy of the binary with whatever this platform edits at test time; the original is never touched. */
  prepareBinary(appPath: string, branch: string, workDir: string): string;
  describeBinary(preparedPath: string): BinaryDescription;
  /** The address `host` resolves to from the device, or null when it does not resolve. */
  resolveHost(host: string): Promise<string | null>;
  installFresh(preparedPath: string): void;
  nowMs(): number;
  launch(): void;
  stop(): void;
  isRunning(): boolean;
  /** The `updates` table as `sqlite3 -json` prints it, empty before expo-updates has created its database. */
  readUpdates(workDir: string): string;
  readUpdatesLog(): string;
  /** Marks the start of the window `readDeviceLog` covers. */
  markDeviceLog(): void;
  readDeviceLog(): string;
}

function iosDevice(device: string): BootDevice {
  const udid = device === '' ? 'booted' : device;
  const simctl = (args: readonly string[], options?: { allowFailure?: boolean }) =>
    run('xcrun', ['simctl', ...args], options);
  const dataContainer = () => simctl(['get_app_container', udid, APP_BUNDLE_ID, 'data']).trim();
  const supportDir = () => join(dataContainer(), 'Library', 'Application Support');
  let logStart = new Date();
  const crashReportsDir = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');

  return {
    prepareBinary(appPath, branch, workDir) {
      const prepared = join(workDir, 'Boardsesh.app');
      cpSync(appPath, prepared, { recursive: true, verbatimSymlinks: true });
      // The one edit: the branch header a phone on this branch would send. The
      // simulator does not check the bundle's seal, so nothing is re-signed.
      run('plutil', [
        '-replace',
        'EXUpdatesRequestHeaders.xprem-branch',
        '-string',
        branch,
        join(prepared, 'Expo.plist'),
      ]);
      return prepared;
    },
    describeBinary(preparedPath) {
      const plist = join(preparedPath, 'Expo.plist');
      const enabled = run('plutil', ['-extract', 'EXUpdatesEnabled', 'raw', '-o', '-', plist]).trim();
      if (enabled !== 'true') throw new Error('This binary has expo-updates switched off (EXUpdatesEnabled).');
      return {
        runtimeVersion: run('plutil', ['-extract', 'EXUpdatesRuntimeVersion', 'raw', '-o', '-', plist]).trim(),
        ...readEmbeddedManifest(readFileSync(join(preparedPath, 'EXUpdates.bundle', 'app.manifest'), 'utf8')),
      };
    },
    // The simulator resolves names through the host.
    async resolveHost(host) {
      try {
        return (await lookup(host)).address;
      } catch {
        return null;
      }
    },
    installFresh(preparedPath) {
      simctl(['terminate', udid, APP_BUNDLE_ID], { allowFailure: true });
      simctl(['uninstall', udid, APP_BUNDLE_ID], { allowFailure: true });
      simctl(['spawn', udid, 'defaults', 'delete', APP_BUNDLE_ID], { allowFailure: true });
      simctl(['install', udid, preparedPath]);
      simctl([
        'spawn',
        udid,
        'defaults',
        'write',
        APP_BUNDLE_ID,
        IOS_EAS_CLIENT_ID_KEY,
        '-string',
        BOOT_CHECK_CLIENT_IDS.ios,
      ]);
    },
    nowMs: () => Date.now(),
    launch() {
      simctl(['launch', udid, APP_BUNDLE_ID]);
    },
    stop() {
      simctl(['terminate', udid, APP_BUNDLE_ID], { allowFailure: true });
    },
    isRunning() {
      return simctl(['spawn', udid, 'launchctl', 'list'])
        .split('\n')
        .some((line) => line.includes(`UIKitApplication:${APP_BUNDLE_ID}`) && /^\d+\s/.test(line));
    },
    readUpdates(workDir) {
      const updatesDir = join(supportDir(), '.expo-internal');
      if (!existsSync(updatesDir)) return '';
      const databaseName = readdirSync(updatesDir).find((name) => /^expo-v\d+\.db$/.test(name));
      if (databaseName === undefined) return '';
      const copyDir = mkdtempSync(join(workDir, 'updates-db-'));
      for (const name of readdirSync(updatesDir)) {
        if (name.startsWith(databaseName)) cpSync(join(updatesDir, name), join(copyDir, name));
      }
      return queryUpdates(join(copyDir, databaseName));
    },
    readUpdatesLog() {
      const directory = supportDir();
      if (!existsSync(directory)) return '';
      const logName = readdirSync(directory).find((name) => name.startsWith('dev.expo.modules.core.logging.'));
      return logName === undefined ? '' : readFileSync(join(directory, logName), 'utf8');
    },
    markDeviceLog() {
      logStart = new Date();
    },
    readDeviceLog() {
      const pad = (part: number) => String(part).padStart(2, '0');
      const start =
        `${logStart.getFullYear()}-${pad(logStart.getMonth() + 1)}-${pad(logStart.getDate())} ` +
        `${pad(logStart.getHours())}:${pad(logStart.getMinutes())}:${pad(logStart.getSeconds())}`;
      const processLog = simctl(
        ['spawn', udid, 'log', 'show', '--start', start, '--style', 'compact', '--predicate', 'process == "Boardsesh"'],
        { allowFailure: true },
      );
      // A simulator process is a host process, so its crash report lands on the host.
      const crashReports = existsSync(crashReportsDir)
        ? readdirSync(crashReportsDir)
            .filter((name) => name.startsWith('Boardsesh') && name.endsWith('.ips'))
            .filter((name) => statSync(join(crashReportsDir, name)).mtimeMs >= logStart.getTime())
            .map((name) => `EXC_CRASH report written: ${name}`)
        : [];
      return [...crashReports, processLog].join('\n');
    },
  };
}

function androidDevice(device: string): BootDevice {
  const adb = (args: readonly string[], options?: { allowFailure?: boolean; timeoutMs?: number }) =>
    run('adb', [...(device === '' ? [] : ['-s', device]), ...args], options);
  const shell = (command: string, options?: { allowFailure?: boolean }) => adb(['shell', command], options);
  const dataDir = `/data/data/${APP_BUNDLE_ID}`;
  const adbBytes = (remotePath: string): Buffer | null => {
    const result = spawnSync('adb', [...(device === '' ? [] : ['-s', device]), 'exec-out', `cat ${remotePath}`], {
      maxBuffer: 256 * 1024 * 1024,
    });
    return result.status === 0 && result.stdout.length > 0 ? result.stdout : null;
  };

  return {
    // An APK's manifest is compiled: the branch is baked before Gradle runs
    // (`pin-android-project`), so there is nothing to edit here.
    prepareBinary: (appPath) => appPath,
    describeBinary(preparedPath) {
      return {
        runtimeVersion: null,
        ...readEmbeddedManifest(run('unzip', ['-p', preparedPath, 'assets/app.manifest'])),
      };
    },
    resolveHost(host) {
      const output = shell(`ping -c 1 -W 1 ${host}`, { allowFailure: true });
      return Promise.resolve(/^PING \S+ \(([^)]+)\)/m.exec(output)?.[1] ?? null);
    },
    installFresh(preparedPath) {
      adb(['uninstall', APP_BUNDLE_ID], { allowFailure: true });
      adb(['install', '-r', preparedPath]);
      // Reading another app's private files needs root, which the `google_apis`
      // emulator images allow and the `google_play` ones do not.
      ensureAndroidRoot((args, timeoutMs) => adb(args, { timeoutMs }));
      const owner = shell(`stat -c %u ${dataDir}`).trim();
      if (!/^\d+$/.test(owner)) throw new Error(`Could not read the app's uid; adb root is required (${owner}).`);
      const seedDir = mkdtempSync(join(tmpdir(), 'boot-check-prefs-'));
      const seedFile = join(seedDir, ANDROID_EAS_PREFS_FILE);
      writeFileSync(seedFile, androidEasClientPrefsXml(BOOT_CHECK_CLIENT_IDS.android));
      adb(['push', seedFile, `/data/local/tmp/${ANDROID_EAS_PREFS_FILE}`]);
      rmSync(seedDir, { recursive: true });
      shell(
        `mkdir -p ${dataDir}/shared_prefs && ` +
          `cp /data/local/tmp/${ANDROID_EAS_PREFS_FILE} ${dataDir}/shared_prefs/${ANDROID_EAS_PREFS_FILE} && ` +
          `chown -R ${owner}:${owner} ${dataDir}/shared_prefs && chmod 771 ${dataDir}/shared_prefs && ` +
          `chmod 660 ${dataDir}/shared_prefs/${ANDROID_EAS_PREFS_FILE} && restorecon -R ${dataDir}/shared_prefs`,
      );
    },
    nowMs: () => Number(shell('date +%s').trim()) * 1_000,
    launch() {
      const resolved = shell(
        `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${APP_BUNDLE_ID}`,
      ).trim();
      shell(androidLaunchCommand(resolved));
    },
    stop() {
      shell(`am force-stop ${APP_BUNDLE_ID}`, { allowFailure: true });
    },
    isRunning() {
      return shell(`pidof ${APP_BUNDLE_ID}`, { allowFailure: true }).trim() !== '';
    },
    readUpdates(workDir) {
      const database = adbBytes(`${dataDir}/databases/updates.db`);
      if (database === null) return '';
      const copyDir = mkdtempSync(join(workDir, 'updates-db-'));
      writeFileSync(join(copyDir, 'updates.db'), database);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = adbBytes(`${dataDir}/databases/updates.db${suffix}`);
        if (sidecar !== null) writeFileSync(join(copyDir, `updates.db${suffix}`), sidecar);
      }
      return queryUpdates(join(copyDir, 'updates.db'));
    },
    readUpdatesLog() {
      return shell(`cat ${dataDir}/files/dev.expo.modules.core.logging.*`, { allowFailure: true });
    },
    markDeviceLog() {
      adb(['logcat', '-c'], { allowFailure: true });
    },
    readDeviceLog() {
      return adb(['logcat', '-d', '-v', 'threadtime'], { allowFailure: true });
    },
  };
}

export async function servedManifest(
  options: Pick<BootCheckOptions, 'manifestUrl' | 'platform' | 'branch'>,
  runtimeVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new Error(`${options.platform} ${options.branch} manifest timed out after 30 seconds.`));
  }, 30_000);
  try {
    // No EAS-Client-ID: an anonymous question registers no device.
    const response = await requestManifest({
      manifestUrl: options.manifestUrl,
      platform: options.platform,
      runtimeVersion,
      appId: OTA_APP_ID,
      branch: options.branch,
      fetchImpl,
      signal: controller.signal,
    });
    await requireSuccess(response, `${options.platform} ${options.branch} manifest`);
    const served = classifyServedManifest(await response.text());
    if (served.kind === 'update') return served.manifest;
    if (served.kind === 'noUpdateAvailable') return null;
    throw new Error(`${options.branch} answered with ${served.kind}, not an update.`);
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/** Reads the table, tolerating the moment a copy catches the database mid-write. */
function readUpdatesSafely(device: BootDevice, workDir: string, previous: string): string {
  try {
    const current = device.readUpdates(workDir);
    parseUpdateRows(current);
    return current;
  } catch {
    return previous;
  }
}

function successfulLaunches(updates: string, updateId: string): number {
  return parseUpdateRows(updates).find((row) => row.id === updateId)?.successfulLaunchCount ?? 0;
}

function report(lines: string): void {
  console.log(lines);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${lines}\n\`\`\`\n`);
}

function fail(options: BootCheckOptions, reason: string): number {
  report(`FAIL: ${options.platform} boot check on ${options.branch}\n  why: ${reason}`);
  return 1;
}

export async function runBootCheck(options: BootCheckOptions): Promise<number> {
  const expectation = expectationFromReceipt(
    JSON.parse(readFileSync(options.receiptPath, 'utf8')) as unknown,
    options.platform,
    options.expectCommit,
  );
  const manifest = await servedManifest(options, expectation.runtimeVersion);
  const expected = resolveExpectedUpdate(
    expectation,
    manifest === null ? null : readServedHead(manifest),
    options.branch,
  );
  if (!expected.ok) return fail(options, expected.reason);
  console.log(
    `${LOG} ${options.branch} serves update ${expected.updateId} (created ${expected.head.createdAt}, ` +
      `${expected.head.assetCount} assets) for commit ${expectation.commit}.`,
  );

  const workDir = mkdtempSync(join(tmpdir(), 'ota-boot-check-'));
  try {
    const device = options.platform === 'ios' ? iosDevice(options.device) : androidDevice(options.device);
    const prepared = device.prepareBinary(options.appPath, options.branch, workDir);
    const binary = device.describeBinary(prepared);
    const binaryProblem = checkBinary(binary, expectation, expected.head);
    if (binaryProblem !== null) return fail(options, binaryProblem);

    if (!options.allowTelemetry) {
      for (const host of TELEMETRY_HOSTS) {
        const address = await device.resolveHost(host);
        if (address !== null && address !== SINKHOLE_ADDRESS) {
          return fail(
            options,
            `${host} resolves to ${address} from the device. The update under test carries the production analytics ` +
              `keys, so the run would report as a real climber. Point the telemetry hosts at ${SINKHOLE_ADDRESS}, or pass ` +
              `--allow-telemetry.`,
          );
        }
      }
    }

    device.installFresh(prepared);

    // Launch 1: the embedded bundle runs and expo-updates downloads the update.
    console.log(`${LOG} Launch 1: waiting up to ${options.downloadTimeoutSeconds}s for the download.`);
    device.launch();
    const downloadDeadline = Date.now() + options.downloadTimeoutSeconds * 1_000;
    let updatesAfterFirstLaunch = '';
    while (Date.now() < downloadDeadline) {
      await sleep(2_000);
      updatesAfterFirstLaunch = readUpdatesSafely(device, workDir, updatesAfterFirstLaunch);
      if (parseUpdateRows(updatesAfterFirstLaunch).some((row) => row.id === expected.updateId && row.ready)) break;
      if (!device.isRunning()) break;
    }
    device.stop();
    await sleep(1_000);
    updatesAfterFirstLaunch = readUpdatesSafely(device, workDir, updatesAfterFirstLaunch);
    const launchesBefore = successfulLaunches(updatesAfterFirstLaunch, expected.updateId);

    // Launch 2: a cold start, which is when a downloaded update is launched.
    console.log(`${LOG} Launch 2: watching for ${options.watchSeconds}s.`);
    device.markDeviceLog();
    const secondLaunchStartedAtMs = device.nowMs();
    const watchStarted = Date.now();
    device.launch();
    let updatesAfterSecondLaunch = updatesAfterFirstLaunch;
    let secondsToFirstScreen: number | null = null;
    while (Date.now() - watchStarted < options.watchSeconds * 1_000) {
      await sleep(1_000);
      updatesAfterSecondLaunch = readUpdatesSafely(device, workDir, updatesAfterSecondLaunch);
      if (
        secondsToFirstScreen === null &&
        successfulLaunches(updatesAfterSecondLaunch, expected.updateId) > launchesBefore
      ) {
        secondsToFirstScreen = (Date.now() - watchStarted) / 1_000;
      }
    }
    const processAliveAtEnd = device.isRunning();
    const updatesLog = device.readUpdatesLog();
    const deviceLog = device.readDeviceLog();
    device.stop();

    const capture: BootCapture = {
      expectedUpdateId: expected.updateId,
      embeddedUpdateId: binary.embeddedUpdateId,
      updatesAfterFirstLaunch,
      updatesAfterSecondLaunch,
      secondLaunchStartedAtMs,
      secondsToFirstScreen,
      processAliveAtEnd,
      watchedSeconds: options.watchSeconds,
      updatesLog: updatesLogSince(updatesLog, secondLaunchStartedAtMs - 1_000),
      fatalLogLines: findFatalLogLines(options.platform, deviceLog),
    };
    const evidence = evidenceFromCapture(capture);
    const verdict = judgeBoot(evidence);
    if (options.evidenceDir !== null) {
      mkdirSync(options.evidenceDir, { recursive: true });
      writeFileSync(
        join(options.evidenceDir, `${options.platform}-capture.json`),
        `${JSON.stringify({ platform: options.platform, branch: options.branch, commit: expectation.commit, capture, verdict }, null, 2)}\n`,
      );
      writeFileSync(join(options.evidenceDir, `${options.platform}-expo-updates.log`), updatesLog);
      writeFileSync(join(options.evidenceDir, `${options.platform}-device.log`), deviceLog);
    }
    report(formatVerdict(options.platform, options.branch, evidence, verdict));
    return verdict.passed ? 0 : 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function pinAndroidProject(argv: readonly string[]): number {
  const { values } = flagValues(argv, ['--branch', '--android-dir'], []);
  const branch = values.get('--branch');
  const androidDir = values.get('--android-dir');
  if (branch === undefined || androidDir === undefined) throw new Error('--branch and --android-dir are required.');
  const manifestPath = join(resolve(androidDir), 'app', 'src', 'main', 'AndroidManifest.xml');
  writeFileSync(manifestPath, pinAndroidManifest(readFileSync(manifestPath, 'utf8'), branch));
  console.log(`${LOG} Pinned ${manifestPath} to ${branch}.`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.filter((argument) => argument !== '--');
  if (args[0] === 'pin-android-project') return pinAndroidProject(args.slice(1));
  const options = parseBootCheckArgs(args, process.env.EXPO_UPDATES_URL);
  let exitCode: number;
  try {
    exitCode = await runBootCheck(options);
  } catch (error) {
    // A check that could not run is a failed check, with its own wording.
    exitCode = fail(
      options,
      `The check could not be completed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `passed=${exitCode === 0}\n`);
  // Also as a file: the Android emulator action runs this as a script line, and
  // a step output written from there does not reach the workflow.
  if (options.evidenceDir !== null) {
    mkdirSync(options.evidenceDir, { recursive: true });
    writeFileSync(join(options.evidenceDir, `${options.platform}-verdict`), `${exitCode === 0}\n`);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
