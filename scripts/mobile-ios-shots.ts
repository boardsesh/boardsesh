/// <reference types="node" />

/**
 * Quick iOS-simulator screenshots of the live RN app (packages/mobile/).
 *
 * The iOS twin of scripts/mobile-android-shots.ts. Boots an iPhone simulator,
 * installs a cached Debug dev-client .app, starts Metro, launches the app (which
 * auto-connects to Metro via the baked DEV_CLIENT_DEFAULT_LAUNCHER_URL), and
 * captures screens with `xcrun simctl io screenshot`. The .app carries no JS — it
 * loads from Metro — so JS changes show up without a rebuild.
 *
 * Usage:
 *   vp run mobile:ios-shots                        # boot + install + Metro + launch, then hold Metro
 *   vp run mobile:ios-shots -- --to climbs --label climbs --shutdown   # one-shot: boot, shoot, tear down
 *   vp run mobile:ios-shots -- screenshot --to board-view --label board   # shoot a running simulator
 *   vp run mobile:ios-shots -- navigate --to discover                  # deep-link only
 *   vp run mobile:ios-shots -- --flow app-store                        # run the Maestro flow
 *   vp run mobile:ios-shots -- shutdown                                # stop simulator + Metro
 *
 * Screenshots land in .boardsesh/ios-screenshots/NN-<label>.png (absolute paths
 * printed). Auto-login (prod test account) is on by default via EXPO_PUBLIC_SCREENSHOT_MODE;
 * pass --no-screenshot-mode for the plain app, and set SCREENSHOT_USER_PASSWORD for the
 * prod test account (the seeded test/test pair only exists on --backend local).
 *
 * macOS only (xcrun simctl); the Linux/KVM-friendly counterpart is mobile:android-shots.
 *
 * iOS-specific: navigation deep links go through Maestro, not bare `simctl openurl`,
 * because iOS pops an undismissable-from-the-CLI "Open in 'Boardsesh'?" confirmation
 * for the custom scheme. `run` primes that dialog away once (after a fresh install),
 * so subsequent navigations land cleanly. Metro must run on port 8081: the cached
 * .app bakes its launcher URL to localhost:8081 (there's no `adb reverse` on iOS).
 *
 * Recommended agent flow: run the bare command in the background (it holds Metro),
 * then use the `screenshot`/`navigate` subcommands in the foreground to grab shots.
 */

import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandExists, runCapture, runInherit, sleepSeconds } from './lib/exec';
import {
  DEFAULT_USER_EMAIL,
  DEFAULT_USER_PASSWORD,
  type DeviceInfo,
  METRO_PORT,
  type ScreenshotOptions,
  applyCleanStatusBar,
  bootDevice,
  buildScreenshotEnv,
  clearStatusBar,
  deviceSlug,
  findOrCreateIosDevice,
  homeReadyMarkerCount,
  metroDevClientUrl,
  portInUse,
  prewarmMetroBundle,
  resolveAppPath,
  resolveBootedIosDevice,
  resolveIosScreenshotDevices,
  startMetro,
  stopMetro,
  waitForHomeReady,
  waitForMetro,
} from './mobile-screenshots';

const LOG = '[mobile:ios-shots]';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAESTRO_DIR = join(ROOT_DIR, 'packages', 'mobile', '.maestro');
const DEFAULT_OUT_DIR = join(ROOT_DIR, '.boardsesh', 'ios-screenshots');
const APP_ID = 'com.boardsesh.app';
const APP_SCHEME = 'com.boardsesh.app';
const DEFAULT_DEVICE = 'iPhone 16 Pro Max';
// The .app's DEV_CLIENT_DEFAULT_LAUNCHER_URL is baked to this port at build time
// (packages/mobile/plugins/with-screenshot-dev-menu.js), so a `simctl launch`
// auto-loads Metro only when Metro is on 8081. iOS has no `adb reverse` to remap it.
const REQUIRED_METRO_PORT = 8081;
const MAESTRO_INSTALL_HINT = 'install it (https://maestro.mobile.dev)';

// Friendly screen names -> deep-link routes (the screenshot-mode params are app
// code; see packages/mobile/src/lib/screenshot-mode.ts and the .maestro flows).
// Kept in sync with scripts/mobile-android-shots.ts.
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

// Routes that push async board art / detail screens with no animation hook for
// `simctl io screenshot` — give them a longer default settle so the capture isn't
// a loading frame. Mirrors the double waitForAnimationToEnd the committed flow uses.
const HEAVY_ROUTES = new Set(['board-view', 'board-sheet', 'session-detail', 'progress']);

type ShotsCommand = 'run' | 'screenshot' | 'navigate' | 'shutdown';

interface ShotsOptions {
  command: ShotsCommand;
  /** Screen name (SCREEN_ROUTES key) or a raw deep-link route. */
  to: string | null;
  label: string | null;
  outDir: string;
  /** Tear down simulator + Metro after the run instead of holding Metro alive. */
  shutdown: boolean;
  /** Inject EXPO_PUBLIC_SCREENSHOT_MODE (auto-login, locked theme) into the Metro bundle. */
  screenshotMode: boolean;
  flow: 'app-store' | 'onboarding' | null;
  appPath: string | null;
  backend: 'prod' | 'local';
  device: string;
  settleSeconds: number;
  /** Skip the device-wide `simctl keychain reset` so a manual login survives. */
  keepKeychain: boolean;
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
    appPath: null,
    backend: 'prod',
    device: DEFAULT_DEVICE,
    settleSeconds: 3,
    keepKeychain: false,
  };

  let index = 0;
  if (args[index] && !args[index].startsWith('--')) {
    const sub = args[index];
    if (sub === 'screenshot' || sub === 'shot') options.command = 'screenshot';
    else if (sub === 'navigate' || sub === 'nav') options.command = 'navigate';
    else if (sub === 'shutdown') options.command = 'shutdown';
    else if (sub === 'run') options.command = 'run';
    else throw new Error(`Unknown subcommand: ${sub} (expected run | screenshot | navigate | shutdown)`);
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
      case '--app-path':
        options.appPath = resolve(expectValue(flag, value));
        index++;
        break;
      case '--device':
        options.device = expectValue(flag, value);
        index++;
        break;
      case '--settle': {
        const seconds = Number(expectValue(flag, value));
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--settle requires a non-negative number');
        options.settleSeconds = seconds;
        index++;
        break;
      }
      case '--shutdown':
        options.shutdown = true;
        break;
      case '--keep-alive':
        options.shutdown = false;
        break;
      case '--no-screenshot-mode':
        options.screenshotMode = false;
        break;
      case '--keep-keychain':
        options.keepKeychain = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return options;
}

function simctl(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number; stdout: string } {
  const result = runCapture('xcrun', ['simctl', ...args], { env });
  return { status: result.status, stdout: result.stdout };
}

// Conservative allowlist of deep-link route characters. The route is inlined into
// a generated Maestro YAML flow (double-quoted), so reject anything that could
// break out of the quotes (a raw `--to` is user-controlled).
const SAFE_ROUTE = /^[A-Za-z0-9?=&_.:/%-]+$/;

function resolveRoute(screen: string): string {
  const route = SCREEN_ROUTES[screen] ?? screen;
  if (!SAFE_ROUTE.test(route)) {
    throw new Error(`Unsafe --to route: ${route} (allowed: ${SAFE_ROUTE.source})`);
  }
  return route;
}

function ensureMaestro(reason: string): void {
  if (!commandExists('maestro')) {
    throw new Error(`Maestro is not on PATH; ${MAESTRO_INSTALL_HINT}. ${reason}`);
  }
}

/**
 * Prime iOS's "Open in 'Boardsesh'?" scheme confirmation away on throwaway /home
 * deep links so later navigations land cleanly. iOS pops it on the first in-session
 * openurl (inconsistently) and blocks until tapped; after one tap it's remembered
 * for the booted session. Mirrors the prime block in .maestro/app-store.yaml.
 * Best-effort: a fresh install guarantees the dialog, but don't fail `run` on a hiccup.
 */
function primeSchemeDialog(udid: string, env: NodeJS.ProcessEnv): void {
  if (!commandExists('maestro')) {
    console.warn(
      `${LOG} Maestro not found — skipping scheme-dialog prime. ${MAESTRO_INSTALL_HINT} for navigation (--to / navigate / --flow).`,
    );
    return;
  }
  const flow = [
    `appId: ${APP_ID}`,
    '---',
    `- openLink: "${APP_SCHEME}://home"`,
    '- extendedWaitUntil:',
    '    visible: "Open"',
    '    timeout: 12000',
    '- tapOn:',
    '    text: "Open"',
    '- waitForAnimationToEnd',
    '- repeat:',
    '    times: 3',
    '    commands:',
    `      - openLink: "${APP_SCHEME}://home"`,
    '      - waitForAnimationToEnd',
    '      - tapOn:',
    '          text: "Open"',
    '          optional: true',
    '      - waitForAnimationToEnd',
    '',
  ].join('\n');
  console.log(`${LOG} Priming the "Open in 'Boardsesh'?" scheme dialog...`);
  const status = runMaestroFlowFile(udid, flow, env);
  if (status !== 0) {
    console.warn(
      `${LOG} Scheme-dialog prime did not complete (exit ${status}); navigations keep an optional fallback tap.`,
    );
  }
}

/** Navigate the running app to a deep link via Maestro (dismisses the scheme dialog). */
function navigate(udid: string, screen: string, env: NodeJS.ProcessEnv): void {
  const url = `${APP_SCHEME}://${resolveRoute(screen)}`;
  ensureMaestro('iOS navigation needs it to dismiss the "Open in \'Boardsesh\'?" scheme dialog.');
  console.log(`${LOG} Navigating to ${url} (via Maestro)...`);
  const flow = [
    `appId: ${APP_ID}`,
    '---',
    `- openLink: "${url}"`,
    '- tapOn:',
    '    text: "Open"',
    '    optional: true',
    '- waitForAnimationToEnd',
    '- waitForAnimationToEnd',
    '',
  ].join('\n');
  const status = runMaestroFlowFile(udid, flow, env);
  if (status !== 0) throw new Error(`Maestro navigation exited ${status}`);
}

/** Write a generated flow to a temp file and run it against the device. */
function runMaestroFlowFile(udid: string, flowYaml: string, env: NodeJS.ProcessEnv): number {
  const dir = mkdtempSync(join(tmpdir(), 'boardsesh-ios-nav-'));
  const flowFile = join(dir, 'flow.yaml');
  try {
    writeFileSync(flowFile, flowYaml, 'utf8');
    return runInherit('maestro', ['--device', udid, 'test', flowFile], { env, cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function nextIndex(outDir: string): number {
  if (!existsSync(outDir)) return 0;
  const indices = readdirSync(outDir)
    .map((file) => /^(\d+)-/.exec(file)?.[1])
    .filter((found): found is string => Boolean(found))
    .map(Number);
  return indices.length > 0 ? Math.max(...indices) + 1 : 0;
}

function captureScreenshot(udid: string, label: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const index = String(nextIndex(outDir)).padStart(2, '0');
  const file = join(outDir, `${index}-${deviceSlug(label)}.png`);
  const result = simctl(['io', udid, 'screenshot', file]);
  if (result.status !== 0) throw new Error(`simctl io screenshot exited ${result.status}`);
  if (!existsSync(file) || statSync(file).size < 1000) throw new Error('simctl screenshot produced an empty image');
  return file;
}

function effectiveSettle(options: ShotsOptions, screen: string | null): number {
  if (screen && HEAVY_ROUTES.has(screen)) return Math.max(options.settleSeconds, 5);
  return options.settleSeconds;
}

function runFlow(udid: string, options: ShotsOptions, env: NodeJS.ProcessEnv): void {
  ensureMaestro('--flow needs it to drive the committed Maestro flow.');
  const flowFile = join(MAESTRO_DIR, options.flow === 'onboarding' ? 'onboarding.yaml' : 'app-store.yaml');
  if (!existsSync(flowFile)) throw new Error(`flow not found: ${flowFile}`);
  const email = process.env.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL;
  const password = process.env.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
  const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-ios-flow-'));
  try {
    console.log(`${LOG} Running Maestro flow ${options.flow} on ${udid}...`);
    const status = runInherit(
      'maestro',
      [
        '--device',
        udid,
        'test',
        flowFile,
        '-e',
        `MAESTRO_DEV_CLIENT_URL=${metroDevClientUrl()}`,
        '-e',
        `SCREENSHOT_USER_EMAIL=${email}`,
        '-e',
        `SCREENSHOT_USER_PASSWORD=${password}`,
      ],
      { env, cwd: captureDir },
    );
    if (status !== 0) throw new Error(`Maestro exited ${status}`);
    mkdirSync(options.outDir, { recursive: true });
    const pngs = readdirSync(captureDir).filter((file) => file.toLowerCase().endsWith('.png'));
    for (const png of pngs) runCapture('cp', [join(captureDir, png), join(options.outDir, png)]);
    console.log(`${LOG} Copied ${pngs.length} flow screenshot(s) to ${options.outDir}`);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
}

/** Minimal ScreenshotOptions for buildScreenshotEnv / resolveAppPath. */
function screenshotEnvOptions(options: ShotsOptions): ScreenshotOptions {
  return {
    platform: 'ios',
    flow: 'app-store',
    backend: options.backend,
    devices: [options.device],
    androidDevice: 'Pixel 6',
    appLocales: [],
    variant: null,
    theme: 'dark',
    workout: null,
    appPath: options.appPath,
    shutdown: false,
  };
}

function printReadyBanner(device: DeviceInfo): void {
  console.log(`\n${LOG} Ready. Simulator ${device.name} (${device.udid}) | Metro http://localhost:${METRO_PORT}`);
  console.log(`${LOG}   shot:      vp run mobile:ios-shots -- screenshot --to climbs --label climbs`);
  console.log(`${LOG}   navigate:  vp run mobile:ios-shots -- navigate --to board-view`);
  console.log(`${LOG}   stop:      vp run mobile:ios-shots -- shutdown`);
  console.log(`${LOG} Holding Metro — stop this process (or run \`shutdown\`) to release it.\n`);
}

function assertDarwinWithSimctl(): void {
  if (process.platform !== 'darwin') {
    throw new Error('iOS simulator screenshots are macOS only. On Linux/CI use: vp run mobile:android-shots.');
  }
  if (!commandExists('xcrun') || simctl(['help']).status !== 0) {
    throw new Error('xcrun simctl is unavailable — install Xcode + Command Line Tools.');
  }
}

function attachToSimulator(device: string): DeviceInfo {
  assertDarwinWithSimctl();
  const booted = resolveBootedIosDevice(device);
  if (!booted) {
    throw new Error('No booted simulator — start one with `vp run mobile:ios-shots` (in the background) first.');
  }
  if (!portInUse(METRO_PORT)) {
    console.warn(`${LOG} Nothing is listening on Metro port ${METRO_PORT}; the app may show a stale bundle.`);
  }
  return booted;
}

function runScreenshotSubcommand(options: ShotsOptions): number {
  const device = attachToSimulator(options.device);
  if (options.to && options.to !== 'home') {
    navigate(device.udid, options.to, process.env);
    sleepSeconds(effectiveSettle(options, options.to));
  }
  const label = options.label ?? options.to ?? 'shot';
  const file = captureScreenshot(device.udid, label, options.outDir);
  console.log(`${LOG} Saved ${file}`);
  return 0;
}

function runNavigateSubcommand(options: ShotsOptions): number {
  if (!options.to) throw new Error('navigate requires --to <screen>');
  const device = attachToSimulator(options.device);
  navigate(device.udid, options.to, process.env);
  return 0;
}

function killMetro(): void {
  const result = runCapture('lsof', ['-nP', `-iTCP:${METRO_PORT}`, '-sTCP:LISTEN', '-t']);
  const pids = result.stdout.split(/\s+/).filter(Boolean);
  for (const pid of pids) runCapture('kill', [pid]);
  if (pids.length > 0) console.log(`${LOG} Stopped Metro on port ${METRO_PORT}.`);
}

function runShutdownSubcommand(options: ShotsOptions): number {
  assertDarwinWithSimctl();
  const device = resolveBootedIosDevice(options.device);
  if (device) {
    clearStatusBar(device.udid);
    console.log(`${LOG} Shutting down ${device.name} (${device.udid})...`);
    simctl(['shutdown', device.udid]);
  } else {
    console.log(`${LOG} No booted simulator.`);
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
  assertDarwinWithSimctl();

  // The cached .app auto-loads Metro from a build-time-baked localhost:8081 URL;
  // a non-8081 port silently loads nothing (no `adb reverse` on iOS).
  if (METRO_PORT !== REQUIRED_METRO_PORT) {
    throw new Error(
      `iOS needs Metro on port ${REQUIRED_METRO_PORT} (the .app bakes its launcher URL); ` +
        `unset BOARDSESH_METRO_PORT (currently ${METRO_PORT}) or rebuild the .app for that port.`,
    );
  }

  const appPath = resolveAppPath(screenshotEnvOptions(options));
  const device = findOrCreateIosDevice(resolveIosScreenshotDevices([options.device])[0]);
  bootDevice(device);
  applyCleanStatusBar(device.udid);

  console.log(`${LOG} Installing ${appPath} on ${device.name}...`);
  simctl(['uninstall', device.udid, APP_ID]); // ignore failure (not installed yet)
  const install = simctl(['install', device.udid, appPath]);
  if (install.status !== 0) throw new Error(`simctl install exited ${install.status}`);
  if (!options.keepKeychain) {
    // The shared keychain group (group.com.boardsesh.app) survives uninstall, so a
    // stale token from a prior --backend local run would auth against the wrong
    // backend. A clean keychain forces a fresh sign-in with the baked creds.
    console.log(`${LOG} Resetting simulator keychain (clears any stale auth token)...`);
    simctl(['keychain', device.udid, 'reset']);
  }

  if (portInUse(METRO_PORT)) {
    throw new Error(`port ${METRO_PORT} is already in use; stop it (another Metro would serve the wrong bundle).`);
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
    prewarmMetroBundle('ios');

    const baseline = homeReadyMarkerCount();
    console.log(`${LOG} Launching the app (auto-loads Metro via DEV_CLIENT_DEFAULT_LAUNCHER_URL)...`);
    const launch = simctl(['launch', device.udid, APP_ID]);
    if (launch.status !== 0) throw new Error(`simctl launch exited ${launch.status}`);

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

    // Prime the scheme dialog now (right after the fresh install) so foreground
    // `navigate`/`screenshot --to` runs land cleanly. Best-effort.
    primeSchemeDialog(device.udid, process.env);

    if (options.flow) runFlow(device.udid, options, process.env);

    if (options.to) {
      if (options.to !== 'home') {
        navigate(device.udid, options.to, process.env);
        sleepSeconds(effectiveSettle(options, options.to));
      }
      const file = captureScreenshot(device.udid, options.label ?? options.to, options.outDir);
      console.log(`${LOG} Saved ${file}`);
    }

    if (options.shutdown) {
      console.log(`${LOG} --shutdown requested; tearing down.`);
    } else {
      printReadyBanner(device);
      await blockUntilExit(metro);
    }
    succeeded = true;
  } finally {
    if (options.shutdown) {
      stopMetro(metro);
      clearStatusBar(device.udid);
      simctl(['shutdown', device.udid]);
    } else if (!succeeded) {
      // A mid-pipeline failure: free the Metro port, but leave the simulator up for
      // debugging and tell the user how to stop it.
      stopMetro(metro);
      console.error(
        `${LOG} Left simulator ${device.name} running for debugging; stop it with: vp run mobile:ios-shots -- shutdown`,
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
        return runShutdownSubcommand(options);
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
