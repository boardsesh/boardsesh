/// <reference types="node" />

/**
 * Automated native screenshot capture for packages/mobile.
 *
 * The iOS screenshot app is a Debug *dev-client* that loads its JS from Metro at
 * runtime. The screenshot behaviour (EXPO_PUBLIC_SCREENSHOT_MODE, theme,
 * workout) is baked into the Metro JS bundle, NOT the native binary — so the
 * .app is reusable and only the JS regenerates per run. This is why CI can cache
 * the .app (see scripts/mobile-build-sim-app.ts) keyed on native inputs and skip
 * the ~30-min from-scratch compile on JS-only changes.
 *
 * The Android screenshot app is a standalone APK built by Gradle with those same
 * EXPO_PUBLIC_* values present at JS bundle time. The orchestrator installs that
 * APK on an already-booted emulator and runs a platform-specific Maestro flow.
 *
 * Flow: prepare a simulator/emulator, apply a clean status bar, install the app
 * artifact, run a Maestro flow that deep-links to each screen and captures it.
 * PNGs land in app-stores/<store>/screenshots/<device>/ (ios -> apple, android
 * -> google).
 *
 * Usage:
 *   vp run mobile:screenshots -- [--platform ios] [--flow app-store|onboarding]
 *                                 [--backend local|prod] [--device "iPhone 16 Pro Max"]
 *                                 [--variant material|liquidGlass] [--shutdown]
 *                                 [--app-path <path/to/Boardsesh.app|app.apk>]
 *
 * Requires: Maestro (https://maestro.mobile.dev) plus platform tooling (xcrun for
 * iOS, adb for Android). For --backend local, bring up the seeded dev DB +
 * backend first (`vp run dev`). iOS can build a Debug simulator .app when
 * --app-path is omitted; Android expects --app-path to point at a prebuilt APK.
 * Credentials come from SCREENSHOT_USER_EMAIL / SCREENSHOT_USER_PASSWORD
 * (default test@boardsesh.com / test).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const MAESTRO_DIR = resolve(MOBILE_DIR, '.maestro');
const BUILD_SIM_APP_SCRIPT = resolve(ROOT_DIR, 'scripts', 'mobile-build-sim-app.ts');
const FIXTURE_SCRIPT = resolve(ROOT_DIR, 'scripts', 'screenshot-session-fixture.ts');
const PARTY_FLOW = resolve(MOBILE_DIR, '.maestro', 'app-store-party.yaml');
const APP_CACHE_DIR = resolve(MOBILE_DIR, '.app-cache');
const OUTPUT_ROOT = resolve(ROOT_DIR, 'app-stores');
// Metro dev server port the dev-client loads its JS bundle from. Defaults to
// 8081; override with BOARDSESH_METRO_PORT when it's taken (this repo runs a
// Metro per worktree). The orchestrator passes the matching dev-client URL to
// Maestro via `-e MAESTRO_DEV_CLIENT_URL`, so the flows never hard-code a port.
const METRO_PORT = Number.parseInt(process.env.BOARDSESH_METRO_PORT ?? '', 10) || 8081;
// Output is grouped by store (the directory name), not by platform id.
const STORE_BY_PLATFORM: Record<'ios' | 'android', string> = { ios: 'apple', android: 'google' };
const LOG = '[mobile:screenshots]';

const APP_ID = 'com.boardsesh.app';
const DEFAULT_IOS_DEVICE = 'iPhone 16 Pro Max';
const DEFAULT_ANDROID_DEVICE = 'Pixel 2';
const IOS_DEVICE_TYPE_ID = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max';
const DEFAULT_ANDROID_APK = resolve(
  MOBILE_DIR,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk',
);
// Mirrors packages/mobile/.env.example. iOS simulators reach the host directly,
// so localhost is correct for a sim build pointed at the local dev backend.
const LOCAL_BACKEND_URL = 'http://localhost:8080';
const LOCAL_WEB_URL = 'http://localhost:3000';
// The app's prod backend default (packages/mobile/src/lib/env.ts); the party fixture
// authenticates + creates/ends its session here when --backend prod.
const PROD_BACKEND_URL = 'https://ws.boardsesh.com';
const DEFAULT_USER_EMAIL = 'test@boardsesh.com';
const DEFAULT_USER_PASSWORD = 'test';
const MAESTRO_INSTALL_HINT = 'Install Maestro: curl -Ls "https://get.maestro.mobile.dev" | bash';

export type ScreenshotPlatform = 'ios' | 'android' | 'all';
export type ScreenshotFlow = 'app-store' | 'onboarding';
export type ScreenshotBackend = 'local' | 'prod';

export type ScreenshotTheme = 'light' | 'dark';

export interface ScreenshotOptions {
  platform: ScreenshotPlatform;
  flow: ScreenshotFlow;
  backend: ScreenshotBackend;
  device: string;
  variant: string | null;
  theme: ScreenshotTheme;
  /** Workout type the Record/session screen pre-selects (generator screenshot); null = Off. */
  workout: string | null;
  /** Prebuilt/cached app artifact to install; iOS can build one when null. */
  appPath: string | null;
  shutdown: boolean;
  /** Capture the live multi-user party shot (iOS app-store only): create a backend
   *  fixture session, run the party flow against it, then tear it down. Off by default,
   *  and a no-op unless the backend has SCREENSHOT_FIXTURE_USER_ID enabled. */
  party: boolean;
}

export function parseArgs(argv: readonly string[]): ScreenshotOptions {
  const args = argv.filter((argument) => argument !== '--');
  let deviceProvided = false;
  const options: ScreenshotOptions = {
    platform: 'ios',
    flow: 'app-store',
    backend: 'local',
    device: DEFAULT_IOS_DEVICE,
    variant: null,
    // Dark is the canonical store appearance (the app defaults to dark).
    theme: 'dark',
    // Volume by default so the Record screen captures the workout generator with
    // a visible, selected tile (its shelf is a gesture-handler ScrollView Maestro
    // can't tap/scroll). `--workout off` leaves the generator Off ("Start a session").
    workout: 'volume',
    appPath: null,
    shutdown: false,
    party: false,
  };

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case '--platform':
        options.platform = expectEnum(flag, value, ['ios', 'android', 'all']) as ScreenshotPlatform;
        index++;
        break;
      case '--flow':
        options.flow = expectEnum(flag, value, ['app-store', 'onboarding']) as ScreenshotFlow;
        index++;
        break;
      case '--backend':
        options.backend = expectEnum(flag, value, ['local', 'prod']) as ScreenshotBackend;
        index++;
        break;
      case '--device':
        options.device = expectValue(flag, value);
        deviceProvided = true;
        index++;
        break;
      case '--variant':
        options.variant = expectEnum(flag, value, ['material', 'liquidGlass']);
        index++;
        break;
      case '--theme':
        options.theme = expectEnum(flag, value, ['light', 'dark']) as ScreenshotTheme;
        index++;
        break;
      case '--workout': {
        const workout = expectEnum(flag, value, ['volume', 'pyramid', 'ladder', 'gradeFocus', 'off']);
        options.workout = workout === 'off' ? null : workout;
        index++;
        break;
      }
      case '--app-path':
        options.appPath = resolve(expectValue(flag, value));
        index++;
        break;
      case '--shutdown':
        options.shutdown = true;
        break;
      case '--party':
        options.party = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!deviceProvided && options.platform === 'android') {
    options.device = DEFAULT_ANDROID_DEVICE;
  }

  return options;
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function expectEnum(flag: string, value: string | undefined, allowed: readonly string[]): string {
  const resolved = expectValue(flag, value);
  if (!allowed.includes(resolved)) {
    throw new Error(`${flag} must be one of: ${allowed.join(', ')} (got "${resolved}")`);
  }
  return resolved;
}

/** Slug used in the output path, e.g. "iPhone 16 Pro Max" -> "iphone-16-pro-max". */
export function deviceSlug(deviceName: string): string {
  return deviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the env Metro bundles with (EXPO_PUBLIC_* are inlined into the JS bundle
 * at bundle time, so these shape the dev-client's JS, not the native compile).
 * Always sets screenshot mode; for --backend local it points the app at the
 * local dev backend unless the caller already exported an override. --backend
 * prod leaves the URLs unset so the app's production defaults apply.
 */
export function buildScreenshotEnv(
  options: ScreenshotOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    EXPO_PUBLIC_SCREENSHOT_MODE: '1',
    // Baked at JS-bundle time; theme-provider locks to it in screenshot mode.
    EXPO_PUBLIC_SCREENSHOT_THEME: options.theme,
  };
  if (options.variant) {
    env.EXPO_PUBLIC_SCREENSHOT_VARIANT = options.variant;
  }
  if (options.workout) {
    env.EXPO_PUBLIC_SCREENSHOT_WORKOUT = options.workout;
  }
  if (options.backend === 'local') {
    env.EXPO_PUBLIC_BACKEND_URL = env.EXPO_PUBLIC_BACKEND_URL ?? LOCAL_BACKEND_URL;
    env.EXPO_PUBLIC_WEB_URL = env.EXPO_PUBLIC_WEB_URL ?? LOCAL_WEB_URL;
  }
  return env;
}

interface DeviceInfo {
  udid: string;
  name: string;
  state: string;
}

function runInherit(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string = ROOT_DIR): number {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  return result.status ?? 1;
}

function runCapture(command: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

function commandExists(command: string): boolean {
  return spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' }).status === 0;
}

/** All simulator devices, flattened across runtimes. */
function listSimulatorDevices(): DeviceInfo[] {
  const { status, stdout } = runCapture('xcrun', ['simctl', 'list', 'devices', '--json']);
  if (status !== 0) return [];
  // simctl can emit partial/empty JSON while Xcode is installing or updating
  // components; treat unparseable output as "no devices" rather than throwing a
  // SyntaxError that surfaces as a confusing stack in main()'s catch.
  let parsed: { devices: Record<string, Array<DeviceInfo & { isAvailable?: boolean }>> };
  try {
    parsed = JSON.parse(stdout) as { devices: Record<string, Array<DeviceInfo & { isAvailable?: boolean }>> };
  } catch {
    return [];
  }
  const devices: DeviceInfo[] = [];
  for (const runtimeDevices of Object.values(parsed.devices)) {
    for (const device of runtimeDevices) {
      if (device.isAvailable === false) continue;
      devices.push({ udid: device.udid, name: device.name, state: device.state });
    }
  }
  return devices;
}

/** Newest available iOS runtime identifier (for creating a missing device). */
function newestIosRuntime(): string | null {
  const { status, stdout } = runCapture('xcrun', ['simctl', 'list', 'runtimes', '--json']);
  if (status !== 0) return null;
  // Same defensive parse as listSimulatorDevices: partial JSON during a Xcode
  // component install shouldn't crash the run.
  let parsed: {
    runtimes: Array<{ identifier: string; isAvailable?: boolean; platform?: string; version?: string }>;
  };
  try {
    parsed = JSON.parse(stdout) as {
      runtimes: Array<{ identifier: string; isAvailable?: boolean; platform?: string; version?: string }>;
    };
  } catch {
    return null;
  }
  const ios = parsed.runtimes
    .filter((runtime) => runtime.isAvailable !== false && /iOS/i.test(runtime.identifier))
    .sort((a, b) => (a.version ?? '').localeCompare(b.version ?? '', undefined, { numeric: true }));
  return ios.length > 0 ? ios[ios.length - 1].identifier : null;
}

function findOrCreateIosDevice(deviceName: string): DeviceInfo {
  const devices = listSimulatorDevices();
  const booted = devices.find((device) => device.name === deviceName && device.state === 'Booted');
  if (booted) return booted;
  const existing = devices.find((device) => device.name === deviceName);
  if (existing) return existing;

  const runtime = newestIosRuntime();
  if (!runtime) {
    throw new Error(
      `No "${deviceName}" simulator found and no iOS runtime available to create one. Open Xcode > Settings > Components to install a simulator runtime, or create the device in Xcode.`,
    );
  }
  console.log(`${LOG} Creating simulator "${deviceName}" (${runtime})...`);
  const { status } = runCapture('xcrun', ['simctl', 'create', deviceName, IOS_DEVICE_TYPE_ID, runtime]);
  if (status !== 0) {
    throw new Error(`Failed to create simulator "${deviceName}". Create it manually in Xcode and rerun.`);
  }
  const created = listSimulatorDevices().find((device) => device.name === deviceName);
  if (!created) throw new Error(`Created "${deviceName}" but could not locate it afterwards.`);
  return created;
}

function bootDevice(device: DeviceInfo): void {
  if (device.state !== 'Booted') {
    console.log(`${LOG} Booting ${device.name} (${device.udid})...`);
    // `boot` errors if already booted; ignore that specific case.
    runCapture('xcrun', ['simctl', 'boot', device.udid]);
  }
  runCapture('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
  // Bring up the Simulator window so Maestro's iOS driver has a foreground app.
  spawnSync('open', ['-a', 'Simulator'], { stdio: 'ignore' });
}

function applyCleanStatusBar(udid: string): void {
  runCapture('xcrun', [
    'simctl',
    'status_bar',
    udid,
    'override',
    '--time',
    '9:41',
    '--batteryState',
    'charged',
    '--batteryLevel',
    '100',
    '--cellularBars',
    '4',
    '--wifiBars',
    '3',
    '--dataNetwork',
    'wifi',
  ]);
}

function clearStatusBar(udid: string): void {
  runCapture('xcrun', ['simctl', 'status_bar', udid, 'clear']);
}

function collectScreenshots(captureDir: string, platform: 'ios' | 'android', deviceName: string): string[] {
  const outputDir = join(OUTPUT_ROOT, STORE_BY_PLATFORM[platform], 'screenshots', deviceSlug(deviceName));
  mkdirSync(outputDir, { recursive: true });
  const pngs = readdirSync(captureDir).filter((file) => file.toLowerCase().endsWith('.png'));
  for (const png of pngs) {
    cpSync(join(captureDir, png), join(outputDir, png));
  }
  return pngs.map((png) => join(outputDir, png));
}

function flowFileForPlatform(options: ScreenshotOptions, platform: 'ios' | 'android'): string {
  const platformFlowFile = join(MAESTRO_DIR, `${options.flow}-${platform}.yaml`);
  if (existsSync(platformFlowFile)) return platformFlowFile;
  return join(MAESTRO_DIR, `${options.flow}.yaml`);
}

function runIos(options: ScreenshotOptions): number {
  if (!commandExists('xcrun') || runCapture('xcrun', ['simctl', 'help']).status !== 0) {
    console.log(`${LOG} Skipped: iOS simulator tooling (xcrun simctl) not available.`);
    return 0;
  }
  if (!commandExists('maestro')) {
    console.error(`${LOG} FAILED: Maestro not found on PATH. ${MAESTRO_INSTALL_HINT}`);
    return 1;
  }

  const device = findOrCreateIosDevice(options.device);
  bootDevice(device);
  applyCleanStatusBar(device.udid);

  // Resolve the dev-client .app: a cached/prebuilt one (--app-path, the CI common
  // path) or build one now (slow; local convenience). The .app loads its JS from
  // Metro, so it's reusable across JS changes.
  const appPath = resolveAppPath(options);
  console.log(`${LOG} Installing ${appPath} on ${device.name}...`);
  // Uninstall first so the run starts from a clean container (fresh AsyncStorage,
  // so no stale active board). The dev-client + Metro path drops Maestro's
  // `clearState`, which can't run before the bundle has loaded — the uninstall +
  // install gives the same fresh-data guarantee.
  runCapture('xcrun', ['simctl', 'uninstall', device.udid, APP_ID]);
  const install = runCapture('xcrun', ['simctl', 'install', device.udid, appPath]);
  if (install.status !== 0) {
    console.error(`${LOG} FAILED: simctl install exited ${install.status}.`);
    return install.status;
  }

  // Reset the simulator keychain so the app launches signed out and login runs
  // against the target backend. The auth token lives in a shared keychain access
  // group (group.com.boardsesh.app) that survives both an app uninstall and the
  // fresh install above — so without this a stale token (e.g. from a previous
  // --backend local run) makes login skip and the app talk to the wrong backend
  // with an invalid session. The login subflow re-authenticates from a clean slate.
  console.log(`${LOG} Resetting simulator keychain (clears any stale auth token)...`);
  runCapture('xcrun', ['simctl', 'keychain', device.udid, 'reset']);

  // Start Metro so the dev-client can load its JS bundle. EXPO_PUBLIC_SCREENSHOT_*
  // + the backend URLs are inlined here, at bundle time — that's what makes the
  // native .app reusable. Killed in the finally below.
  // Abort if the port is already taken: expo would silently skip starting our
  // dev server (non-interactive), and the flow would then load whatever foreign
  // Metro is on the port — capturing the wrong app's bundle. Fail loud instead.
  if (portInUse(METRO_PORT)) {
    console.error(
      `${LOG} FAILED: port ${METRO_PORT} is already in use; another Metro would serve the wrong bundle. ` +
        `Stop it, or set BOARDSESH_METRO_PORT to a free port.`,
    );
    return 1;
  }

  const metroEnv = buildScreenshotEnv(options);
  console.log(
    `${LOG} Starting Metro on ${METRO_PORT} (backend=${options.backend}, theme=${options.theme}, flow=${options.flow}${options.variant ? `, variant=${options.variant}` : ''})...`,
  );
  const metro = startMetro(metroEnv);
  const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-shots-'));
  try {
    if (!waitForMetro()) {
      console.error(`${LOG} FAILED: Metro did not become ready on port ${METRO_PORT}.`);
      return 1;
    }

    // Compile the bundle now so the dev-client load below isn't a cold bundle on
    // Maestro's auth-screen wait (the slow-CI-runner timeout this guards against).
    prewarmMetroBundle();

    // Just launch the app — no `simctl openurl`. The screenshots build bakes
    // DEV_CLIENT_DEFAULT_LAUNCHER_URL=http://localhost:8081 into Info.plist (see
    // ./plugins/with-screenshot-dev-menu), so the dev-client auto-connects to
    // Metro on a plain launch and lands on the auth screen — without ever opening
    // the custom-scheme URL. That matters because a fresh CI sim raises an "Open
    // in Boardsesh?" confirmation for ANY openurl of the scheme, and Maestro can't
    // dismiss it reliably (it can queue two, occluding the form). Avoiding openurl
    // sidesteps the whole class. Dev-menu chrome is suppressed via the same plugin.
    console.log(`${LOG} Launching the app (auto-loads Metro via DEV_CLIENT_DEFAULT_LAUNCHER_URL)...`);
    runCapture('xcrun', ['simctl', 'launch', device.udid, APP_ID]);

    const flowFile = flowFileForPlatform(options, 'ios');
    if (!existsSync(flowFile)) {
      console.error(`${LOG} FAILED: flow not found: ${flowFile}`);
      return 1;
    }
    const email = process.env.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL;
    const password = process.env.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
    console.log(`${LOG} Running Maestro flow ${options.flow} on ${device.udid}...`);
    // Credentials are passed via `-e`, which is the ONLY mechanism Maestro 2.6.1
    // offers: `maestro test` has no `--env-file` and does not read `${VAR}` from
    // the shell environment (verified — env-only resolves to empty and login
    // fails). The value is therefore briefly visible in the process arg list
    // (`ps aux`) for the run's duration. This is acceptable here: CI runs on an
    // ephemeral, single-tenant runner, and locally it's the developer's own
    // machine. Revisit with `--env-file` if/when we bump to a Maestro that has it.
    const maestroStatus = runInherit(
      'maestro',
      [
        '--device',
        device.udid,
        'test',
        flowFile,
        // The flows load their JS via this dev-client deep link (port-agnostic).
        '-e',
        `MAESTRO_DEV_CLIENT_URL=${metroDevClientUrl()}`,
        '-e',
        `SCREENSHOT_USER_EMAIL=${email}`,
        '-e',
        `SCREENSHOT_USER_PASSWORD=${password}`,
      ],
      process.env,
      captureDir,
    );
    if (maestroStatus !== 0) {
      console.error(`${LOG} FAILED: Maestro exited with ${maestroStatus}.`);
      return maestroStatus;
    }

    if (options.party && options.flow === 'app-store') {
      runPartyShot(options, device.udid, captureDir, email, password);
    }

    const saved = collectScreenshots(captureDir, 'ios', device.name);
    if (saved.length === 0) {
      console.error(`${LOG} WARNING: flow completed but no PNGs were captured.`);
      return 1;
    }
    console.log(
      `${LOG} Saved ${saved.length} screenshot(s) to app-stores/${STORE_BY_PLATFORM.ios}/screenshots/${deviceSlug(device.name)}/`,
    );
    for (const file of saved) console.log(`${LOG}   ${file}`);
  } finally {
    stopMetro(metro);
    rmSync(captureDir, { force: true, recursive: true });
    clearStatusBar(device.udid);
    if (options.shutdown) {
      runCapture('xcrun', ['simctl', 'shutdown', device.udid]);
    }
  }

  return 0;
}

/**
 * Capture the live multi-user party shot (iOS app-store slot 03). Creates a backend
 * fixture session (createScreenshotSession), runs the party flow against the still-
 * running app, then tears the session down. Best-effort: if the fixture can't be
 * created — e.g. the backend hasn't enabled SCREENSHOT_FIXTURE_USER_ID — it logs and
 * skips, leaving the 9-shot set intact. The party PNG lands in the same capture dir,
 * so the caller's single collectScreenshots() picks it up.
 */
function runPartyShot(
  options: ScreenshotOptions,
  deviceUdid: string,
  captureDir: string,
  email: string,
  password: string,
): void {
  const backendUrl =
    process.env.EXPO_PUBLIC_BACKEND_URL ?? (options.backend === 'local' ? LOCAL_BACKEND_URL : PROD_BACKEND_URL);
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SCREENSHOT_BACKEND_URL: backendUrl,
    SCREENSHOT_USER_EMAIL: email,
    SCREENSHOT_USER_PASSWORD: password,
  };

  console.log(`${LOG} Party shot: creating fixture session on ${backendUrl}...`);
  const created = spawnSync('bunx', ['tsx', FIXTURE_SCRIPT, 'create'], { encoding: 'utf8', env: fixtureEnv });
  const sessionId = (created.stdout ?? '').trim();
  if (created.status !== 0 || sessionId.length === 0) {
    console.warn(
      `${LOG} Party shot skipped: could not create the fixture session ` +
        `(the backend may not have SCREENSHOT_FIXTURE_USER_ID enabled). The 9-shot set is unaffected.`,
    );
    return;
  }

  try {
    console.log(`${LOG} Party shot: joining ${sessionId} and capturing...`);
    const partyStatus = runInherit(
      'maestro',
      [
        '--device',
        deviceUdid,
        'test',
        PARTY_FLOW,
        '-e',
        `MAESTRO_DEV_CLIENT_URL=${metroDevClientUrl()}`,
        '-e',
        `SCREENSHOT_SESSION_ID=${sessionId}`,
        '-e',
        `SCREENSHOT_USER_EMAIL=${email}`,
        '-e',
        `SCREENSHOT_USER_PASSWORD=${password}`,
      ],
      process.env,
      captureDir,
    );
    if (partyStatus !== 0) {
      console.warn(`${LOG} Party shot: Maestro exited with ${partyStatus}; the 9-shot set is still saved.`);
    }
  } finally {
    console.log(`${LOG} Party shot: tearing down fixture session ${sessionId}...`);
    const ended = spawnSync('bunx', ['tsx', FIXTURE_SCRIPT, 'end', sessionId], { encoding: 'utf8', env: fixtureEnv });
    if (ended.status !== 0) {
      console.warn(`${LOG} Party shot: teardown of ${sessionId} failed; remove it manually if it lingers.`);
    }
  }
}

function runAndroid(options: ScreenshotOptions): number {
  if (!commandExists('adb') || runCapture('adb', ['version']).status !== 0) {
    console.error(`${LOG} FAILED: Android platform tooling (adb) is not available.`);
    return 1;
  }
  if (!commandExists('maestro')) {
    console.error(`${LOG} FAILED: Maestro not found on PATH. ${MAESTRO_INSTALL_HINT}`);
    return 1;
  }

  const deviceId = resolveAndroidDeviceId();
  if (!deviceId) {
    console.error(`${LOG} FAILED: no ready Android device/emulator found in \`adb devices\`.`);
    return 1;
  }

  const appPath = resolveAndroidAppPath(options);
  const deviceName = androidDeviceName(options);
  console.log(`${LOG} Installing ${appPath} on ${deviceId} (${deviceName})...`);
  runCapture('adb', ['-s', deviceId, 'uninstall', APP_ID]);
  const installStatus = runInherit('adb', ['-s', deviceId, 'install', '-r', appPath], process.env);
  if (installStatus !== 0) {
    console.error(`${LOG} FAILED: adb install exited ${installStatus}.`);
    return installStatus;
  }
  // The uninstall should leave a fresh data directory. Clear again after install
  // so reruns against an already-installed, same-signature APK also start signed
  // out with no stale active board.
  runCapture('adb', ['-s', deviceId, 'shell', 'pm', 'clear', APP_ID]);
  applyCleanAndroidStatusBar(deviceId);

  const flowFile = flowFileForPlatform(options, 'android');
  if (!existsSync(flowFile)) {
    console.error(`${LOG} FAILED: flow not found: ${flowFile}`);
    return 1;
  }

  const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-android-shots-'));
  try {
    const email = process.env.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL;
    const password = process.env.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
    console.log(`${LOG} Running Maestro flow ${options.flow} on ${deviceId}...`);
    const maestroStatus = runInherit(
      'maestro',
      [
        '--device',
        deviceId,
        'test',
        flowFile,
        '-e',
        `SCREENSHOT_USER_EMAIL=${email}`,
        '-e',
        `SCREENSHOT_USER_PASSWORD=${password}`,
      ],
      process.env,
      captureDir,
    );
    if (maestroStatus !== 0) {
      console.error(`${LOG} FAILED: Maestro exited with ${maestroStatus}.`);
      return maestroStatus;
    }

    const saved = collectScreenshots(captureDir, 'android', deviceName);
    if (saved.length === 0) {
      console.error(`${LOG} WARNING: flow completed but no PNGs were captured.`);
      return 1;
    }
    console.log(
      `${LOG} Saved ${saved.length} screenshot(s) to app-stores/${STORE_BY_PLATFORM.android}/screenshots/${deviceSlug(deviceName)}/`,
    );
    for (const file of saved) console.log(`${LOG}   ${file}`);
  } finally {
    clearAndroidStatusBar(deviceId);
    rmSync(captureDir, { force: true, recursive: true });
    if (options.shutdown && deviceId.startsWith('emulator-')) {
      runCapture('adb', ['-s', deviceId, 'emu', 'kill']);
    }
  }

  return 0;
}

function resolveAndroidDeviceId(): string | null {
  const explicitSerial = process.env.ANDROID_SERIAL;
  if (explicitSerial && explicitSerial.length > 0) return explicitSerial;

  const { status, stdout } = runCapture('adb', ['devices']);
  if (status !== 0) return null;
  const readyDevices = stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === 'device')
    .map((parts) => parts[0]);
  return readyDevices[0] ?? null;
}

function androidDeviceName(options: ScreenshotOptions): string {
  return options.device === DEFAULT_IOS_DEVICE ? DEFAULT_ANDROID_DEVICE : options.device;
}

function resolveAndroidAppPath(options: ScreenshotOptions): string {
  if (options.appPath) {
    if (!existsSync(options.appPath)) {
      throw new Error(`--app-path not found: ${options.appPath}`);
    }
    return options.appPath;
  }
  if (existsSync(DEFAULT_ANDROID_APK)) {
    return DEFAULT_ANDROID_APK;
  }
  throw new Error(
    `Android capture requires --app-path <path/to/app.apk>. Build the screenshot APK first, or place one at ${DEFAULT_ANDROID_APK}.`,
  );
}

function applyCleanAndroidStatusBar(deviceId: string): void {
  runCapture('adb', ['-s', deviceId, 'shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
  runCapture('adb', [
    '-s',
    deviceId,
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    '-e',
    'command',
    'enter',
  ]);
  runCapture('adb', [
    '-s',
    deviceId,
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    '-e',
    'command',
    'clock',
    '-e',
    'hhmm',
    '0941',
  ]);
  runCapture('adb', [
    '-s',
    deviceId,
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    '-e',
    'command',
    'battery',
    '-e',
    'level',
    '100',
    '-e',
    'plugged',
    'true',
  ]);
  runCapture('adb', [
    '-s',
    deviceId,
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    '-e',
    'command',
    'network',
    '-e',
    'wifi',
    'show',
    '-e',
    'level',
    '4',
    '-e',
    'mobile',
    'show',
    '-e',
    'datatype',
    'lte',
    '-e',
    'sims',
    '1',
    '-e',
    'nosim',
    'false',
  ]);
  runCapture('adb', ['-s', deviceId, 'shell', 'cmd', 'notification', 'dismiss-all']);
}

function clearAndroidStatusBar(deviceId: string): void {
  runCapture('adb', [
    '-s',
    deviceId,
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    '-e',
    'command',
    'exit',
  ]);
}

/**
 * Resolve the Boardsesh.app to install: a prebuilt/cached one (--app-path, the CI
 * common path) or a freshly built Debug simulator app (local one-command DX).
 */
function resolveAppPath(options: ScreenshotOptions): string {
  if (options.appPath) {
    if (!existsSync(options.appPath)) {
      throw new Error(`--app-path not found: ${options.appPath}`);
    }
    return options.appPath;
  }
  console.log(`${LOG} No --app-path given; building a Debug simulator app (slow — CI passes a cached .app)...`);
  const status = runInherit('bunx', ['tsx', BUILD_SIM_APP_SCRIPT, '--', '--app-out', APP_CACHE_DIR], process.env);
  if (status !== 0) {
    throw new Error(`simulator app build failed (exit ${status})`);
  }
  const built = join(APP_CACHE_DIR, 'Boardsesh.app');
  if (!existsSync(built)) {
    throw new Error(`build reported success but ${built} is missing`);
  }
  return built;
}

/** expo-development-client deep link that loads the JS bundle from our Metro. */
function metroDevClientUrl(): string {
  return `${APP_ID}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${METRO_PORT}`)}`;
}

/** True if anything is already listening on the port (a foreign Metro). */
function portInUse(port: number): boolean {
  return spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).status === 0;
}

/**
 * Start Metro in the background. `detached` so cleanup can kill the whole process
 * group; `CI=1` keeps expo non-interactive (no keypress menu / TTY expectations).
 */
function startMetro(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn('bunx', ['expo', 'start', '--port', String(METRO_PORT)], {
    cwd: MOBILE_DIR,
    env: { ...env, CI: '1' },
    stdio: 'inherit',
    detached: true,
  });
}

/**
 * Compile the JS bundle the dev-client will request, so its load in Maestro is a
 * Metro transform-cache hit instead of a cold bundle (3900+ modules, ~100s+ on a
 * fresh CI runner with no on-disk Metro cache) on the auth-screen wait's critical
 * path — which has timed out there. We fetch the manifest the dev-client would
 * and request its exact launchAsset URL (same hermes/bytecode transform params),
 * so Metro caches the right variant. Best-effort: a miss just falls back to
 * Maestro cold-loading the bundle (its wait is generous).
 */
function prewarmMetroBundle(): void {
  const manifest = runCapture('curl', [
    '-fsS',
    '--max-time',
    '30',
    `http://localhost:${METRO_PORT}/`,
    '-H',
    'expo-platform: ios',
    '-H',
    'Accept: application/expo+json,application/json',
  ]);
  let bundleUrl: string | undefined;
  if (manifest.status === 0) {
    try {
      bundleUrl = (JSON.parse(manifest.stdout) as { launchAsset?: { url?: string } }).launchAsset?.url;
    } catch {
      // Non-JSON manifest — fall through to skip.
    }
  }
  if (!bundleUrl) {
    console.log(`${LOG} Metro pre-warm skipped (no bundle URL); Maestro will cold-load the bundle.`);
    return;
  }
  console.log(`${LOG} Pre-warming the Metro bundle...`);
  const warmed = runCapture('curl', ['-fsS', '-o', '/dev/null', '--max-time', '300', bundleUrl]);
  console.log(
    warmed.status === 0
      ? `${LOG} Metro bundle pre-warmed.`
      : `${LOG} Metro pre-warm did not finish (non-fatal); Maestro will load the bundle.`,
  );
}

/** Poll Metro's /status until it answers (or ~120s elapse). */
function waitForMetro(): boolean {
  const statusUrl = `http://localhost:${METRO_PORT}/status`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (runCapture('curl', ['-fsS', '-o', '/dev/null', statusUrl]).status === 0) {
      console.log(`${LOG} Metro is ready on port ${METRO_PORT}.`);
      return true;
    }
    sleepSeconds(2);
  }
  return false;
}

function stopMetro(metro: ChildProcess | null): void {
  if (!metro || metro.pid === undefined) return;
  console.log(`${LOG} Stopping Metro...`);
  try {
    // Negative PID targets the detached process group, so Metro's node children
    // die with it.
    process.kill(-metro.pid, 'SIGTERM');
  } catch {
    try {
      metro.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

function sleepSeconds(seconds: number): void {
  spawnSync('sleep', [String(seconds)]);
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  let options: ScreenshotOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const platforms: Array<'ios' | 'android'> = options.platform === 'all' ? ['ios', 'android'] : [options.platform];

  for (const platform of platforms) {
    try {
      const status = platform === 'ios' ? runIos(options) : runAndroid(options);
      if (status !== 0) return status;
    } catch (error) {
      console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
