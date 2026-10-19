import { guardSimulatorCommand } from './lib/ios-simulator-lease';
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
 *   vp run mobile:ios-shots -- screenshot --story <id> --theme light    # shoot a dev story (docs/mobile-stories.md)
 *   vp run mobile:ios-shots -- navigate --to discover                  # deep-link only
 *   vp run mobile:ios-shots -- --flow app-store                        # run the Maestro flow
 *   vp run mobile:ios-shots -- shutdown                                # stop simulator + Metro
 *
 * `--story <id>` is `--to dev/stories/<id>` (plus `?theme=`/`?variant=` from
 * `--theme dark|light` and `--variant liquidGlass|material`), labelled with the id.
 * Instead of the fixed settle it waits for the app's `[stories] ready <id>` line
 * in the Metro log, then 0.5 s more.
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
 * so subsequent navigations land cleanly.
 *
 * Any Metro port: the cached .app bakes its launcher URL to localhost:8081 (there's
 * no `adb reverse` on iOS), so with BOARDSESH_METRO_PORT=<n> `run` installs a copy
 * at ~/.cache/boardsesh/ios-shots-apps/<n>/Boardsesh.app with the URL rewritten and
 * re-signed. Set the same BOARDSESH_METRO_PORT on every later subcommand.
 *
 * File watching: the holding `run` starts Metro with its watcher on, so edits
 * hot-reload into the open app. A `--shutdown` one-shot keeps the frozen-bundle
 * `CI=1` Metro. `--watch` / `--no-watch` override either.
 *
 * Recommended agent flow: run the bare command in the background (it holds Metro),
 * then use the `screenshot`/`navigate` subcommands in the foreground to grab shots.
 */

import { type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandExists, runCapture, runInherit, sleepSeconds } from './lib/exec';
import { DEFAULT_SCREENSHOT_FIXTURES_DIR } from './lib/screenshot-fixtures';
import {
  DEFAULT_METRO_PORT,
  METRO_PORT,
  homeReadyMarkerCount,
  isIosBundledLine,
  metroDevClientUrl,
  metroLogOffset,
  metroLogPathForPort,
  portInUse,
  prewarmMetroBundle,
  shotsMetroWatch,
  startMetro,
  stopMetro,
  waitForHomeReady,
  waitForMetro,
  waitForMetroLogLine,
} from './lib/metro-dev-server';
import {
  STORY_THEMES,
  STORY_VARIANTS,
  type StoryTheme,
  type StoryVariant,
  applyStoryOptions,
  assertStoryId,
  resolveMetroLogPath,
  settleAfterStory,
} from './lib/mobile-stories';
import {
  DEFAULT_USER_EMAIL,
  DEFAULT_USER_PASSWORD,
  type DeviceInfo,
  type ScreenshotOptions,
  applyCleanStatusBar,
  bootDevice,
  buildScreenshotEnv,
  clearStatusBar,
  deviceSlug,
  findOrCreateIosDevice,
  resolveAppPath,
  resolveBootedIosDevice,
  resolveIosScreenshotDevices,
} from './mobile-screenshots';

const LOG = '[mobile:ios-shots]';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAESTRO_DIR = join(ROOT_DIR, 'packages', 'mobile', '.maestro');
const DEFAULT_OUT_DIR = join(ROOT_DIR, '.boardsesh', 'ios-screenshots');
const APP_ID = 'com.boardsesh.app';
const APP_SCHEME = 'com.boardsesh.app';
const DEFAULT_DEVICE = 'iPhone 16 Pro Max';
// The .app's DEV_CLIENT_DEFAULT_LAUNCHER_URL is baked at build time
// (packages/mobile/plugins/with-screenshot-dev-menu.js), so a `simctl launch`
// auto-loads Metro only on that port. iOS has no `adb reverse` to remap it, so
// another port gets a rewritten, re-signed copy of the .app here (never /tmp:
// it's a RAM disk on the dev machines).
const PORT_APPS_DIR = join(homedir(), '.cache', 'boardsesh', 'ios-shots-apps');
const LAUNCHER_URL_KEY = 'DEV_CLIENT_DEFAULT_LAUNCHER_URL';
// A freshly installed dev client sometimes shows its launcher list instead of
// auto-connecting. No "iOS Bundled" line this long after launch means that.
const BUNDLE_REQUEST_TIMEOUT_SECONDS = 20;
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
  flow: 'app-store' | 'onboarding' | 'help' | null;
  appPath: string | null;
  backend: 'prod' | 'local';
  device: string;
  settleSeconds: number;
  /** Skip the device-wide `simctl keychain reset` so a manual login survives. */
  keepKeychain: boolean;
  /** Dev story id; sets `to` to its route and waits for its ready line instead of the settle. */
  story: string | null;
  theme: StoryTheme | null;
  variant: StoryVariant | null;
  /** Metro file watching for `run`; null = on while holding Metro, off for `--shutdown`. */
  watch: boolean | null;
  /** Metro log to watch for story lines (default: see resolveMetroLogPath). */
  metroLog: string | null;
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

export function parseShotsArgs(argv: readonly string[]): ShotsOptions {
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
    story: null,
    theme: null,
    variant: null,
    watch: null,
    metroLog: null,
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
        options.flow = expectEnum(flag, value, ['app-store', 'onboarding', 'help']) as
          | 'app-store'
          | 'onboarding'
          | 'help';
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
      case '--story':
        options.story = assertStoryId(expectValue(flag, value));
        index++;
        break;
      case '--theme':
        options.theme = expectEnum(flag, value, STORY_THEMES) as StoryTheme;
        index++;
        break;
      case '--variant':
        options.variant = expectEnum(flag, value, STORY_VARIANTS) as StoryVariant;
        index++;
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--no-watch':
        options.watch = false;
        break;
      case '--metro-log':
        options.metroLog = resolve(expectValue(flag, value));
        index++;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  applyStoryOptions(options);
  return options;
}

function simctl(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number; stdout: string } {
  guardSimulatorCommand('xcrun', ['simctl', ...args], ROOT_DIR);
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
    guardSimulatorCommand('maestro', ['--device', udid], ROOT_DIR);
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

/**
 * Navigate to `options.to`, then wait until it's worth capturing: a story's
 * ready line (offset taken before the navigation, which can paint mid-Maestro),
 * or the fixed settle for everything else.
 */
function navigateAndSettle(udid: string, options: ShotsOptions, metroLogPath: string): void {
  if (!options.to) return;
  const offset = metroLogOffset(metroLogPath);
  navigate(udid, options.to, process.env);
  if (options.story) {
    settleAfterStory(options.story, metroLogPath, offset, effectiveSettle(options, null), LOG);
  } else {
    sleepSeconds(effectiveSettle(options, options.to));
  }
}

export function portAppPath(port: number, root: string = PORT_APPS_DIR): string {
  return join(root, String(port), 'Boardsesh.app');
}

interface PortAppStamp {
  source: string;
  sourceMtimeMs: number;
}

/** Reuse the per-port copy only while it was made from this exact build of this source. */
export function portAppIsCurrent(stamp: PortAppStamp | null, source: string, sourceMtimeMs: number): boolean {
  return stamp !== null && stamp.source === source && stamp.sourceMtimeMs === sourceMtimeMs;
}

/** Newest mtime among the files every rebuild or re-export rewrites. */
function appBuildMtimeMs(appPath: string): number {
  return Math.max(
    ...[
      appPath,
      join(appPath, 'Info.plist'),
      join(appPath, 'Boardsesh'),
      join(appPath, '_CodeSignature', 'CodeResources'),
    ]
      .filter((path) => existsSync(path))
      .map((path) => statSync(path).mtimeMs),
  );
}

function readLauncherUrl(appPath: string): string | null {
  const result = runCapture('plutil', ['-extract', LAUNCHER_URL_KEY, 'raw', '-o', '-', join(appPath, 'Info.plist')]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function readPortAppStamp(stampPath: string): PortAppStamp | null {
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8')) as PortAppStamp;
  } catch {
    return null;
  }
}

/**
 * The .app to install for a Metro on `port`: `source` itself when its baked
 * launcher URL already points there, otherwise a copy under PORT_APPS_DIR with
 * the URL rewritten and an ad-hoc re-sign. The re-sign takes NO entitlements
 * file: signing scripts/screenshot-sim.entitlements into the signature makes the
 * simulator refuse to launch it (POSIX 163). Re-copied only when `source` changes.
 */
function ensurePortApp(source: string, port: number): string {
  const launcherUrl = `http://localhost:${port}`;
  if (readLauncherUrl(source) === launcherUrl) return source;

  const target = portAppPath(port);
  const stampPath = join(dirname(target), 'source.json');
  const sourceMtimeMs = appBuildMtimeMs(source);
  if (
    existsSync(target) &&
    portAppIsCurrent(readPortAppStamp(stampPath), source, sourceMtimeMs) &&
    readLauncherUrl(target) === launcherUrl
  ) {
    console.log(`${LOG} Reusing ${target} (launcher URL ${launcherUrl}).`);
    return target;
  }

  console.log(`${LOG} Copying ${source} to ${target} with launcher URL ${launcherUrl}...`);
  // Drop the stamp first: a copy that dies halfway is redone next run.
  rmSync(stampPath, { force: true });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  const copy = runCapture('ditto', [source, target]);
  if (copy.status !== 0) throw new Error(`ditto ${source} -> ${target} exited ${copy.status}: ${copy.stderr.trim()}`);
  const plist = join(target, 'Info.plist');
  let edit = runCapture('/usr/libexec/PlistBuddy', ['-c', `Set :${LAUNCHER_URL_KEY} ${launcherUrl}`, plist]);
  if (edit.status !== 0) {
    edit = runCapture('/usr/libexec/PlistBuddy', ['-c', `Add :${LAUNCHER_URL_KEY} string ${launcherUrl}`, plist]);
  }
  if (edit.status !== 0) throw new Error(`PlistBuddy could not set ${LAUNCHER_URL_KEY}: ${edit.stderr.trim()}`);
  const sign = runCapture('codesign', ['--force', '--sign', '-', target]);
  if (sign.status !== 0) throw new Error(`codesign exited ${sign.status}: ${sign.stderr.trim()}`);
  writeFileSync(stampPath, `${JSON.stringify({ source, sourceMtimeMs } satisfies PortAppStamp)}\n`);
  return target;
}

/**
 * The .app for this run. On the default port that's resolveAppPath's answer
 * (it refuses an --app-path baked for another port). On any other port an
 * --app-path is taken as the source of a per-port copy instead; a fresh build
 * already bakes BOARDSESH_METRO_PORT, so it's used as is.
 */
function resolveShotsAppPath(options: ShotsOptions): string {
  if (METRO_PORT === DEFAULT_METRO_PORT) return resolveAppPath(screenshotEnvOptions(options));
  const source = options.appPath ?? resolveAppPath(screenshotEnvOptions(options));
  if (!existsSync(source)) throw new Error(`--app-path not found: ${source}`);
  return ensurePortApp(source, METRO_PORT);
}

/** The dev-client deep link that points the app at our Metro (the launcher-list escape). */
function devClientOpenUrl(port: number): string {
  return metroDevClientUrl(port, APP_SCHEME);
}

/** Tap "Open" on the scheme confirmation if one is up. Best-effort. */
function confirmSchemeDialog(udid: string, env: NodeJS.ProcessEnv): void {
  if (!commandExists('maestro')) return;
  const flow = [
    `appId: ${APP_ID}`,
    '---',
    '- tapOn:',
    '    text: "Open"',
    '    optional: true',
    '- waitForAnimationToEnd',
    '',
  ].join('\n');
  runMaestroFlowFile(udid, flow, env);
}

function runFlow(udid: string, options: ShotsOptions, env: NodeJS.ProcessEnv): void {
  ensureMaestro('--flow needs it to drive the committed Maestro flow.');
  // Resolve by flow NAME rather than a two-way ternary, so a new flow (`help`)
  // picks up its own YAML instead of silently running the store flow. iOS has
  // no `-ios` variants committed today; the probe keeps the same precedence as
  // the orchestrator's `flowFileForPlatform`.
  const flowName = options.flow ?? 'app-store';
  const iosFlowFile = join(MAESTRO_DIR, `${flowName}-ios.yaml`);
  const flowFile = existsSync(iosFlowFile) ? iosFlowFile : join(MAESTRO_DIR, `${flowName}.yaml`);
  if (!existsSync(flowFile)) throw new Error(`flow not found: ${flowFile}`);
  const email = process.env.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL;
  const password = process.env.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
  const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-ios-flow-'));
  try {
    guardSimulatorCommand('maestro', ['--device', udid], ROOT_DIR);
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
    // null on both: an ad-hoc dev shot gets the same pinned Aura look and store
    // walls a store capture does, straight from screenshot-mode.ts. Point it
    // somewhere else with EXPO_PUBLIC_SCREENSHOT_BOARDS in the environment.
    renderMode: null,
    boards: null,
    appPath: options.appPath,
    // iOS is always a dev-client; the flag is Android-only (see mobile-screenshots.ts).
    devClient: false,
    // Ad-hoc dev shots always talk to a real backend: fixtures exist for the
    // store capture's determinism, and a one-off shot wants live data.
    fixtures: 'off',
    fixturesDir: DEFAULT_SCREENSHOT_FIXTURES_DIR,
    fresh: false,
    pseudonymise: true,
    frozenNow: null,
    shutdown: false,
    orientation: null,
  };
}

function printReadyBanner(device: DeviceInfo, watch: boolean, metroLogPath: string): void {
  const command = `${METRO_PORT === DEFAULT_METRO_PORT ? '' : `BOARDSESH_METRO_PORT=${METRO_PORT} `}vp run mobile:ios-shots --`;
  console.log(`\n${LOG} Ready. Simulator ${device.name} (${device.udid}) | Metro http://localhost:${METRO_PORT}`);
  console.log(`${LOG}   Metro log: ${metroLogPath} (file watching ${watch ? 'on' : 'off'})`);
  console.log(`${LOG}   shot:      ${command} screenshot --to climbs --label climbs`);
  console.log(
    `${LOG}   story:     ${command} screenshot --story <id> [--theme dark|light] [--variant liquidGlass|material]`,
  );
  console.log(`${LOG}   navigate:  ${command} navigate --to board-view`);
  console.log(`${LOG}   stop:      ${command} shutdown`);
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
  const booted = resolveBootedIosDevice(process.env.BOARDSESH_IOS_SIMULATOR_UDID ?? device);
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
    navigateAndSettle(device.udid, options, resolveMetroLogPath(options.metroLog, ROOT_DIR));
  }
  const label = options.label ?? options.to ?? 'shot';
  const file = captureScreenshot(device.udid, label, options.outDir);
  console.log(`${LOG} Saved ${file}`);
  return 0;
}

function runNavigateSubcommand(options: ShotsOptions): number {
  if (!options.to) throw new Error('navigate requires --to <screen> or --story <id>');
  const device = attachToSimulator(options.device);
  if (options.story) {
    // Wait for the story too, so a capture right after this lands on a painted screen.
    navigateAndSettle(device.udid, options, resolveMetroLogPath(options.metroLog, ROOT_DIR));
  } else {
    navigate(device.udid, options.to, process.env);
  }
  return 0;
}

function killMetro(): void {
  // Only the process that spawned Metro owns its ChildProcess handle. Never kill
  // arbitrary listeners discovered by port: they may belong to another checkout.
  console.log(`${LOG} Stop Metro through the process that started it (Ctrl-C).`);
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
        // Node's setTimeout returns a Timeout handle with unref(); the type-check
        // env resolves the DOM overload (number), so reach unref() through a cast.
        const killTimer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }, 5000) as unknown as { unref?: () => void };
        killTimer.unref?.();
      }
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    metro.on('exit', finish);
  });
}

async function runFullPipeline(options: ShotsOptions): Promise<number> {
  assertDarwinWithSimctl();

  const appPath = resolveShotsAppPath(options);
  const device = findOrCreateIosDevice(resolveIosScreenshotDevices([options.device])[0]);
  bootDevice(device);
  applyCleanStatusBar(device.udid);

  console.log(`${LOG} Installing ${appPath} on ${device.name}...`);
  const install = simctl(['install', device.udid, appPath]);
  if (install.status !== 0) throw new Error(`simctl install exited ${install.status}`);

  if (portInUse(METRO_PORT)) {
    throw new Error(`port ${METRO_PORT} is already in use; stop it (another Metro would serve the wrong bundle).`);
  }
  const metroEnv = options.screenshotMode
    ? buildScreenshotEnv(screenshotEnvOptions(options), process.env, null)
    : { ...process.env };
  const watch = shotsMetroWatch(options);
  const metroLogPath = options.metroLog ?? metroLogPathForPort(METRO_PORT);
  console.log(
    `${LOG} Starting Metro on ${METRO_PORT} (screenshotMode=${options.screenshotMode}, backend=${options.backend}, ` +
      `watch=${watch}, log ${metroLogPath})...`,
  );
  const metro = startMetro(metroEnv, { watch, logPath: metroLogPath });

  let succeeded = false;
  try {
    if (!waitForMetro()) throw new Error(`Metro did not become ready on port ${METRO_PORT}`);
    prewarmMetroBundle('ios');

    const baseline = homeReadyMarkerCount(metroLogPath);
    // After the pre-warm, whose own request logs an "iOS Bundled" line.
    const bundleOffset = metroLogOffset(metroLogPath);
    console.log(`${LOG} Launching the app (auto-loads Metro via ${LAUNCHER_URL_KEY})...`);
    const launch = simctl(['launch', device.udid, APP_ID]);
    if (launch.status !== 0) throw new Error(`simctl launch exited ${launch.status}`);
    if (!waitForMetroLogLine(isIosBundledLine, bundleOffset, BUNDLE_REQUEST_TIMEOUT_SECONDS, metroLogPath)) {
      const url = devClientOpenUrl(METRO_PORT);
      console.warn(
        `${LOG} The app hasn't asked Metro for its bundle after ${BUNDLE_REQUEST_TIMEOUT_SECONDS}s ` +
          `(probably stuck on the dev-launcher list); opening ${url}...`,
      );
      simctl(['openurl', device.udid, url]);
      confirmSchemeDialog(device.udid, process.env);
    }

    if (options.screenshotMode) {
      if (waitForHomeReady(baseline, 0, 240, undefined, metroLogPath)) {
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
      if (options.to !== 'home') navigateAndSettle(device.udid, options, metroLogPath);
      const file = captureScreenshot(device.udid, options.label ?? options.to, options.outDir);
      console.log(`${LOG} Saved ${file}`);
    }

    if (options.shutdown) {
      console.log(`${LOG} --shutdown requested; tearing down.`);
    } else {
      printReadyBanner(device, watch, metroLogPath);
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
