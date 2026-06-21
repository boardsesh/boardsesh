/// <reference types="node" />

/**
 * Quick Android-emulator screenshots of the live RN app (packages/mobile/).
 *
 * Boots an x86_64 emulator (the fast KVM path on Linux/Intel), installs a cached
 * dev-client APK, starts Metro, wires `adb reverse` so the emulator reaches it,
 * launches the app, and captures screens with `adb exec-out screencap`. The cached
 * APK carries no JS — it loads from Metro — so JS changes show up without a rebuild.
 *
 * Usage:
 *   vp run mobile:android-shots                       # boot + install + Metro + launch, then hold Metro
 *   vp run mobile:android-shots -- --to climbs --label climbs --shutdown   # one-shot: boot, shoot, tear down
 *   vp run mobile:android-shots -- screenshot --to board-view --label board   # shoot a running emulator
 *   vp run mobile:android-shots -- navigate --to discover                  # deep-link only
 *   vp run mobile:android-shots -- --flow app-store                        # run the Maestro flow
 *   vp run mobile:android-shots -- shutdown                                # stop emulator + Metro
 *
 * Screenshots land in .boardsesh/android-screenshots/NN-<label>.png (absolute paths
 * printed). Auto-login (prod test account) is on by default via EXPO_PUBLIC_SCREENSHOT_MODE;
 * pass --no-screenshot-mode for the plain app, and set SCREENSHOT_USER_PASSWORD for the
 * prod test account (the seeded test/test pair only exists on --backend local).
 *
 * Recommended agent flow: run the bare command in the background (it holds Metro),
 * then use the `screenshot`/`navigate` subcommands in the foreground to grab shots.
 */

import { type ChildProcess, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandExists, runCapture, runInherit, sleepSeconds } from './lib/exec';
import { adbPath, androidEnv, ensureAndroidSdk, resolveAndroidHome } from './lib/android-sdk';
import { bootEmulator, resolveRunningEmulator, shutdownEmulator } from './lib/android-emulator';
import { ANDROID_DEV_PACKAGE, ANDROID_SCHEME } from './lib/android-app';
import { ensureAndroidApk } from './mobile-android-apk';
import {
  DEFAULT_USER_EMAIL,
  DEFAULT_USER_PASSWORD,
  METRO_PORT,
  type ScreenshotOptions,
  applyCleanAndroidStatusBar,
  buildScreenshotEnv,
  clearAndroidStatusBar,
  deviceSlug,
  homeReadyMarkerCount,
  metroDevClientUrl,
  portInUse,
  prewarmMetroBundle,
  startMetro,
  stopMetro,
  waitForHomeReady,
  waitForMetro,
} from './mobile-screenshots';

const LOG = '[mobile:android-shots]';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAESTRO_DIR = join(ROOT_DIR, 'packages', 'mobile', '.maestro');
const DEFAULT_OUT_DIR = join(ROOT_DIR, '.boardsesh', 'android-screenshots');

// Friendly screen names -> deep-link routes (the screenshot-mode params are app
// code; see packages/mobile/src/lib/screenshot-mode.ts and the .maestro flows).
const SCREEN_ROUTES: Record<string, string> = {
  home: 'home',
  climbs: 'climbs',
  discover: 'discover',
  profile: 'profile',
  record: 'record',
  'board-view': 'climbs?screenshotOpenFirst=1',
  'board-sheet': 'climbs?screenshotOpenBoardSheet=1',
  'session-detail': 'profile?screenshotTab=sessions',
  logbook: 'profile?screenshotTab=logbook',
  progress: 'profile?screenshotTab=progress',
};

type ShotsCommand = 'run' | 'screenshot' | 'navigate' | 'shutdown';

interface ShotsOptions {
  command: ShotsCommand;
  /** Screen name (SCREEN_ROUTES key) or a raw deep-link route. */
  to: string | null;
  label: string | null;
  outDir: string;
  /** Tear down emulator + Metro after the run instead of holding Metro alive. */
  shutdown: boolean;
  /** Inject EXPO_PUBLIC_SCREENSHOT_MODE (auto-login, locked theme) into the Metro bundle. */
  screenshotMode: boolean;
  flow: 'app-store' | 'onboarding' | null;
  buildLocal: boolean;
  apkTag: string | null;
  appPath: string | null;
  backend: 'prod' | 'local';
  settleSeconds: number;
  headless: boolean;
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function expectEnum(flag: string, value: string | undefined, allowed: readonly string[]): string {
  const resolved = expectValue(flag, value);
  if (!allowed.includes(resolved)) throw new Error(`${flag} must be one of: ${allowed.join(', ')} (got "${resolved}")`);
  return resolved;
}

function parseShotsArgs(argv: readonly string[]): ShotsOptions {
  const args = argv.filter((argument) => argument !== '--');
  const options: ShotsOptions = {
    command: 'run',
    to: null,
    label: null,
    outDir: DEFAULT_OUT_DIR,
    shutdown: false,
    screenshotMode: true,
    flow: null,
    buildLocal: false,
    apkTag: null,
    appPath: null,
    backend: 'prod',
    settleSeconds: 3,
    headless: true,
  };

  let index = 0;
  if (args[index] && !args[index].startsWith('--')) {
    const sub = args[index];
    if (sub === 'screenshot' || sub === 'shot') options.command = 'screenshot';
    else if (sub === 'navigate' || sub === 'nav') options.command = 'navigate';
    else if (sub === 'shutdown') options.command = 'shutdown';
    else if (sub === 'run') options.command = 'run';
    else throw new Error(`Unknown subcommand: ${sub} (expected screenshot | navigate | shutdown)`);
    index++;
  }

  for (; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case '--to':
        options.to = expectValue(flag, value);
        index++;
        break;
      case '--label':
        options.label = expectValue(flag, value);
        index++;
        break;
      case '--out':
        options.outDir = resolve(expectValue(flag, value));
        index++;
        break;
      case '--flow':
        options.flow = expectEnum(flag, value, ['app-store', 'onboarding']) as 'app-store' | 'onboarding';
        index++;
        break;
      case '--backend':
        options.backend = expectEnum(flag, value, ['prod', 'local']) as 'prod' | 'local';
        index++;
        break;
      case '--apk-tag':
        options.apkTag = expectValue(flag, value);
        index++;
        break;
      case '--app-path':
        options.appPath = resolve(expectValue(flag, value));
        index++;
        break;
      case '--settle': {
        const seconds = Number(expectValue(flag, value));
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--settle requires a non-negative number');
        options.settleSeconds = seconds;
        index++;
        break;
      }
      case '--build-local':
        options.buildLocal = true;
        break;
      case '--shutdown':
        options.shutdown = true;
        break;
      case '--keep-alive':
        options.shutdown = false;
        break;
      case '--no-screenshot-mode':
        options.screenshotMode = false;
        break;
      case '--windowed':
        options.headless = false;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return options;
}

/** Put the cache SDK on PATH so reused helpers that call bare `adb` resolve it. */
function applyAndroidPath(env: NodeJS.ProcessEnv): void {
  process.env.PATH = env.PATH;
  process.env.ANDROID_HOME = env.ANDROID_HOME;
  process.env.ANDROID_SDK_ROOT = env.ANDROID_SDK_ROOT;
  if (env.JAVA_HOME) process.env.JAVA_HOME = env.JAVA_HOME;
}

function adb(serial: string, args: string[], env: NodeJS.ProcessEnv) {
  return runCapture(adbPath(resolveAndroidHome()), ['-s', serial, ...args], { env });
}

// Conservative allowlist of deep-link route characters. The route is single-quoted
// into an `adb shell` command string, so reject anything that could break out of the
// quotes or inject device-shell commands (a raw `--to` is user-controlled).
const SAFE_ROUTE = /^[A-Za-z0-9?=&_.:/%-]+$/;

/** Fire a VIEW intent for a deep link. The URL is single-quoted for the device shell. */
function navigate(serial: string, env: NodeJS.ProcessEnv, screen: string): void {
  const route = SCREEN_ROUTES[screen] ?? screen;
  if (!SAFE_ROUTE.test(route)) {
    throw new Error(`Unsafe --to route: ${route} (allowed: ${SAFE_ROUTE.source})`);
  }
  const url = `${ANDROID_SCHEME}://${route}`;
  console.log(`${LOG} Navigating to ${url}`);
  adb(serial, ['shell', `am start -a android.intent.action.VIEW -d '${url}'`], env);
}

function nextIndex(outDir: string): number {
  if (!existsSync(outDir)) return 0;
  const indices = readdirSync(outDir)
    .map((file) => /^(\d+)-/.exec(file)?.[1])
    .filter((found): found is string => Boolean(found))
    .map(Number);
  return indices.length > 0 ? Math.max(...indices) + 1 : 0;
}

function captureScreenshot(serial: string, env: NodeJS.ProcessEnv, label: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const index = String(nextIndex(outDir)).padStart(2, '0');
  const file = join(outDir, `${index}-${deviceSlug(label)}.png`);
  // exec-out streams raw PNG bytes (no on-device file, no CRLF mangling) — correct
  // on a headless `-no-window` emulator. Write straight to the file descriptor.
  const fd = openSync(file, 'w');
  try {
    const result = spawnSync(adbPath(resolveAndroidHome()), ['-s', serial, 'exec-out', 'screencap', '-p'], {
      stdio: ['ignore', fd, 'inherit'],
      env,
    });
    if (result.status !== 0) throw new Error(`adb screencap exited ${result.status ?? 'null'}`);
  } finally {
    closeSync(fd);
  }
  if (!existsSync(file) || statSync(file).size < 1000) throw new Error('screencap produced an empty image');
  return file;
}

function runMaestroFlow(serial: string, options: ShotsOptions, env: NodeJS.ProcessEnv): void {
  if (!commandExists('maestro')) {
    throw new Error('Maestro is not on PATH; install it (https://maestro.mobile.dev) to use --flow.');
  }
  const flowFile = join(
    MAESTRO_DIR,
    options.flow === 'onboarding' ? 'onboarding-android.yaml' : 'app-store-android.yaml',
  );
  if (!existsSync(flowFile)) throw new Error(`flow not found: ${flowFile}`);
  const email = process.env.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL;
  const password = process.env.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
  const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-android-flow-'));
  try {
    console.log(`${LOG} Running Maestro flow ${options.flow} on ${serial}...`);
    const status = runInherit(
      'maestro',
      [
        '--device',
        serial,
        'test',
        flowFile,
        '-e',
        `APP_ID=${ANDROID_DEV_PACKAGE}`,
        '-e',
        `SCREENSHOT_USER_EMAIL=${email}`,
        '-e',
        `SCREENSHOT_USER_PASSWORD=${password}`,
      ],
      { env, cwd: captureDir },
    );
    if (status !== 0) throw new Error(`Maestro exited ${status}`);
    mkdirSync(options.outDir, { recursive: true });
    const pngs = readdirSync(captureDir).filter((file) => file.endsWith('.png'));
    for (const png of pngs) cpSync(join(captureDir, png), join(options.outDir, png));
    console.log(`${LOG} Copied ${pngs.length} flow screenshot(s) to ${options.outDir}`);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
}

/** Minimal ScreenshotOptions for buildScreenshotEnv (it reads theme/variant/workout/backend). */
function screenshotEnvOptions(options: ShotsOptions): ScreenshotOptions {
  return {
    platform: 'android',
    flow: 'app-store',
    backend: options.backend,
    devices: [],
    androidDevice: 'Pixel 6',
    appLocales: [],
    variant: null,
    theme: 'dark',
    workout: null,
    appPath: null,
    shutdown: false,
  };
}

function printReadyBanner(serial: string): void {
  console.log(`\n${LOG} Ready. Emulator ${serial} | Metro http://localhost:${METRO_PORT}`);
  console.log(`${LOG}   shot:      vp run mobile:android-shots -- screenshot --to climbs --label climbs`);
  console.log(`${LOG}   navigate:  vp run mobile:android-shots -- navigate --to board-view`);
  console.log(`${LOG}   stop:      vp run mobile:android-shots -- shutdown`);
  console.log(`${LOG} Holding Metro — stop this process (or run \`shutdown\`) to release it.\n`);
}

function attachToEmulator(): { serial: string; env: NodeJS.ProcessEnv } {
  const env = androidEnv();
  applyAndroidPath(env);
  if (!existsSync(adbPath(resolveAndroidHome()))) {
    throw new Error('Android SDK not bootstrapped — run `vp run mobile:android-doctor` first.');
  }
  const serial = resolveRunningEmulator(env);
  if (!serial) {
    throw new Error('No running emulator — start one with `vp run mobile:android-shots` (in the background) first.');
  }
  return { serial, env };
}

function runScreenshotSubcommand(options: ShotsOptions): number {
  const { serial, env } = attachToEmulator();
  if (options.to) {
    navigate(serial, env, options.to);
    sleepSeconds(options.settleSeconds);
  }
  const label = options.label ?? options.to ?? 'shot';
  const file = captureScreenshot(serial, env, label, options.outDir);
  console.log(`${LOG} Saved ${file}`);
  return 0;
}

function runNavigateSubcommand(options: ShotsOptions): number {
  if (!options.to) throw new Error('navigate requires --to <screen>');
  const { serial, env } = attachToEmulator();
  navigate(serial, env, options.to);
  return 0;
}

function killMetro(): void {
  const result = runCapture('lsof', ['-nP', `-iTCP:${METRO_PORT}`, '-sTCP:LISTEN', '-t']);
  const pids = result.stdout.split(/\s+/).filter(Boolean);
  for (const pid of pids) runCapture('kill', [pid]);
  if (pids.length > 0) console.log(`${LOG} Stopped Metro on port ${METRO_PORT}.`);
}

function runShutdownSubcommand(): number {
  const env = androidEnv();
  applyAndroidPath(env);
  const serial = resolveRunningEmulator(env);
  if (serial) {
    clearAndroidStatusBar(serial);
    shutdownEmulator(serial, env);
  } else {
    console.log(`${LOG} No running emulator.`);
  }
  killMetro();
  return 0;
}

/**
 * Hold the process alive while Metro runs (keep-alive). On Ctrl-C / SIGTERM, ask
 * Metro's process group to stop, escalate to SIGKILL after a grace period so an
 * unresponsive bundler doesn't orphan and hold the port, and resolve only once it
 * has actually exited.
 */
function blockUntilExit(metro: ChildProcess): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolvePromise();
    };
    const onSignal = (): void => {
      stopMetro(metro);
      if (metro.pid !== undefined) {
        const pid = metro.pid;
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }, 5000).unref();
      }
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    metro.on('exit', finish);
  });
}

async function runFullPipeline(options: ShotsOptions): Promise<number> {
  const toolchain = ensureAndroidSdk();
  applyAndroidPath(toolchain.env);
  const env = process.env;

  const serial = bootEmulator(env, { headless: options.headless });

  const apk = ensureAndroidApk({
    buildLocal: options.buildLocal,
    apkTag: options.apkTag ?? undefined,
    appPath: options.appPath ?? undefined,
  });

  console.log(`${LOG} Installing ${apk} as ${ANDROID_DEV_PACKAGE}...`);
  adb(serial, ['uninstall', ANDROID_DEV_PACKAGE], env); // ignore failure (not installed yet)
  const install = runInherit(adbPath(resolveAndroidHome()), ['-s', serial, 'install', '-r', apk], { env });
  if (install !== 0) throw new Error(`adb install failed (exit ${install})`);
  adb(serial, ['shell', 'pm', 'clear', ANDROID_DEV_PACKAGE], env); // fresh: signed out, no stale board
  applyCleanAndroidStatusBar(serial);

  if (portInUse(METRO_PORT)) {
    throw new Error(`port ${METRO_PORT} is already in use; stop it or set BOARDSESH_METRO_PORT to a free port.`);
  }
  const metroEnv = options.screenshotMode
    ? buildScreenshotEnv(screenshotEnvOptions(options), process.env, null)
    : { ...process.env };
  console.log(
    `${LOG} Starting Metro on ${METRO_PORT} (screenshotMode=${options.screenshotMode}, backend=${options.backend})...`,
  );
  const metro = startMetro(metroEnv);

  let succeeded = false;
  try {
    if (!waitForMetro()) throw new Error(`Metro did not become ready on port ${METRO_PORT}`);
    prewarmMetroBundle('android');
    adb(serial, ['reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`], env);

    const baseline = homeReadyMarkerCount();
    console.log(`${LOG} Launching dev-client against Metro...`);
    adb(serial, ['shell', `am start -a android.intent.action.VIEW -d '${metroDevClientUrl()}'`], env);

    if (options.screenshotMode) {
      if (waitForHomeReady(baseline, 240)) {
        console.log(`${LOG} App reached home.`);
      } else {
        console.warn(
          `${LOG} Did not see the '$screen /home' marker — the app may be on the login screen ` +
            `(set SCREENSHOT_USER_PASSWORD for the prod test account, or use --backend local).`,
        );
      }
    } else {
      const settle = Math.max(options.settleSeconds, 20);
      console.log(`${LOG} Waiting ${settle}s for the JS bundle to load...`);
      sleepSeconds(settle);
    }

    if (options.flow) runMaestroFlow(serial, options, env);

    if (options.to) {
      navigate(serial, env, options.to);
      sleepSeconds(options.settleSeconds);
      const file = captureScreenshot(serial, env, options.label ?? options.to, options.outDir);
      console.log(`${LOG} Saved ${file}`);
    }

    if (options.shutdown) {
      console.log(`${LOG} --shutdown requested; tearing down.`);
    } else {
      printReadyBanner(serial);
      await blockUntilExit(metro);
    }
    succeeded = true;
  } finally {
    if (options.shutdown) {
      stopMetro(metro);
      clearAndroidStatusBar(serial);
      shutdownEmulator(serial, env);
    } else if (!succeeded) {
      // A mid-pipeline failure: free the Metro port, but leave the emulator up for
      // debugging and tell the user how to stop it.
      stopMetro(metro);
      console.error(
        `${LOG} Left emulator ${serial} running for debugging; stop it with: vp run mobile:android-shots -- shutdown`,
      );
    }
  }

  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: ShotsOptions;
  try {
    options = parseShotsArgs(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    switch (options.command) {
      case 'screenshot':
        return runScreenshotSubcommand(options);
      case 'navigate':
        return runNavigateSubcommand(options);
      case 'shutdown':
        return runShutdownSubcommand();
      default:
        return await runFullPipeline(options);
    }
  } catch (error) {
    console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
