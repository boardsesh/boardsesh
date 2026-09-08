import { guardSimulatorCommand } from './lib/ios-simulator-lease';
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
 * iOS PNGs land in app-stores/apple/screenshots/<app-store-locale>/<device>/;
 * Android PNGs land in app-stores/google/screenshots/<device>/.
 *
 * Usage:
 *   vp run mobile:screenshots -- [--platform ios] [--flow app-store|onboarding]
 *                                 [--backend local|prod] [--devices common|phones|ipads|<comma-list>]
 *                                 [--locales all|<comma-list>] [--device "iPhone 16 Pro Max"]
 *                                 [--variant material|liquidGlass] [--shutdown]
 *                                 [--app-path <path/to/Boardsesh.app|app.apk>]
 *                                 [--orientation portrait|landscape] [--dev-client]
 *                                 [--fixtures off|record|replay] [--fixtures-dir <path>] [--fresh]
 *
 * --fixtures points the app at the local record/replay backend
 * (scripts/screenshot-backend.ts) instead of a live one, so the screenshots stop
 * moving whenever PROD's data does. `record` proxies `--backend` and writes down
 * every answer; `replay` serves those bytes and never leaves the machine. See
 * docs/mobile-screenshot-fixtures.md.
 *
 * --dev-client makes the Android capture work the way iOS always has: install the
 * dev-client APK (com.boardsesh.app.dev) and load its JS from a Metro this script
 * starts, instead of installing a standalone APK with JS baked in. iOS is always a
 * dev-client, so the flag is Android-only.
 *
 * Requires: Maestro (https://maestro.mobile.dev) plus platform tooling (xcrun for
 * iOS, adb for Android). For --backend local, bring up the seeded dev DB +
 * backend first (`vp run dev`). iOS can build a Debug simulator .app when
 * --app-path is omitted; Android expects --app-path to point at a prebuilt APK
 * (or resolves a dev-client APK itself with --dev-client).
 * Credentials come from SCREENSHOT_USER_EMAIL / SCREENSHOT_USER_PASSWORD
 * (default test@boardsesh.com / test).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUPPORTED_LOCALES, isSupportedLocale, type Locale } from '../packages/shared/i18n/src/config';
import {
  METRO_LOG_PATH,
  METRO_PORT,
  SCREENSHOT_READY_PORT,
  dumpMetroLogTail,
  homeReadyMarkerCount,
  metroDevClientUrl,
  portInUse,
  prewarmMetroBundle,
  readinessServerReachable,
  screenshotReadinessCount,
  startMetro,
  startReadinessServer,
  stopMetro,
  stopReadinessServer,
  waitForHomeReady,
  waitForMetro,
  waitForPortToClose,
} from './lib/metro-dev-server';
import {
  connectDevClient,
  installDevClient,
  launchDevClientToHome,
  startMetroForDevClient,
  stopDevClientSession,
  type DevClientSession,
} from './lib/android-dev-client';
import { ANDROID_DEV_PACKAGE } from './lib/android-app';
import { readScreenshotFixtureManifest } from './lib/screenshot-backend';
import {
  DEFAULT_SCREENSHOT_FIXTURES_DIR,
  RE_RECORD_COMMAND,
  findScreenshotBackendProblems,
  parseScreenshotBackendLogLine,
  resolveScreenshotBackendPort,
  startOfSecondIso,
  type ScreenshotBackendMode,
} from './lib/screenshot-fixtures';
// Orchestrator-to-orchestrator import (mobile-android-shots.ts already does the
// same): resolving a dev-client APK is one behaviour with one cache, and the lib
// layer can't own it because it shells out to gh/gradle.
import { ensureAndroidApk } from './mobile-android-apk';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const MAESTRO_DIR = resolve(MOBILE_DIR, '.maestro');
const BUILD_SIM_APP_SCRIPT = resolve(ROOT_DIR, 'scripts', 'mobile-build-sim-app.ts');
const APP_CACHE_DIR = resolve(MOBILE_DIR, '.app-cache');
const OUTPUT_ROOT = resolve(ROOT_DIR, 'app-stores');
/**
 * Android's answer to the Metro tee: the device log, streamed to a file for the
 * whole capture.
 *
 * `adb logcat -d` after the fact is not equivalent and was the bug — it dumps the
 * ring buffer as it stands, and a capture run pushes ~64k lines through a buffer
 * that holds a fraction of that, so the app's own markers had already rotated out
 * by the time the gate looked. A reader open from before the app launches sees
 * every line regardless of how much follows it.
 */
export const LOGCAT_LOG_PATH = join(tmpdir(), 'boardsesh-screenshot-logcat.log');
/**
 * The screenshot backend's own stdout+stderr, for the whole capture.
 *
 * Truncated when the backend starts, so the miss gate reads only this run. The
 * gate additionally slices from a per-capture baseline line count, because one
 * backend serves every device (and, on iOS, every locale) in a run — without
 * the slice, device 2 would fail on device 1's misses.
 */
export const SCREENSHOT_BACKEND_LOG_PATH = join(tmpdir(), 'boardsesh-screenshot-backend.log');
const SCREENSHOT_BACKEND_SCRIPT = resolve(ROOT_DIR, 'scripts', 'screenshot-backend.ts');
/** How long `startScreenshotBackend` waits for `/health` to answer before failing the run. */
const SCREENSHOT_BACKEND_READY_TIMEOUT_SECONDS = 10;
// Output is grouped by store (the directory name), not by platform id.
const STORE_BY_PLATFORM: Record<'ios' | 'android', string> = { ios: 'apple', android: 'google' };
const LOG = '[mobile:screenshots]';

const APP_ID = 'com.boardsesh.app';
const MAESTRO_DEVICE_ORIENTATION_PLACEHOLDER = '${MAESTRO_DEVICE_ORIENTATION}';

const DEFAULT_ANDROID_DEVICE = 'Pixel 2';
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
// An emulator's localhost is its OWN loopback, so --backend local additionally
// needs these two reversed onto the host. Derived from the URLs above so a port
// move there can't leave the reverse behind.
const LOCAL_BACKEND_REVERSE_PORTS: readonly number[] = [LOCAL_BACKEND_URL, LOCAL_WEB_URL].map((url) =>
  Number.parseInt(new URL(url).port, 10),
);
export const DEFAULT_USER_EMAIL = 'test@boardsesh.com';
export const DEFAULT_USER_PASSWORD = 'test';
const MAESTRO_INSTALL_HINT = 'Install Maestro: curl -Ls "https://get.maestro.mobile.dev" | bash';

export type ScreenshotPlatform = 'ios' | 'android' | 'all';
export type ScreenshotFlow = 'app-store' | 'onboarding';
export type ScreenshotBackend = 'local' | 'prod';
/**
 * Whether this capture talks to a real backend (`off`), proxies one while
 * writing down what it answered (`record`), or serves those recordings back
 * (`replay`). Orthogonal to `--backend`, which only ever names the UPSTREAM: a
 * recording proxies it, a replay never makes an outbound request at all.
 */
export type ScreenshotFixturesMode = 'off' | 'record' | 'replay';

export type ScreenshotTheme = 'light' | 'dark';
export type IosDeviceOrientation = 'PORTRAIT' | 'LANDSCAPE_LEFT';

export interface IosScreenshotDevice {
  name: string;
  typeId: string;
  orientation: IosDeviceOrientation;
}

// iPhones: just the 6.9" iPhone 16 Pro Max. App Store Connect auto-scales the
// largest iPhone size down to every smaller iPhone, so a single 6.9" set covers the
// whole iPhone range — extra iPhone sizes are invisible to users and add no ranking
// value, only CI time (see app-stores/apple/app-store-submission-guide.md). iPad is
// a separate App Store slot that does NOT auto-scale from the iPhone screenshots, so
// it gets its own captures below. Locale, not iPhone size, is the axis that helps the
// listing, so the orchestrator still captures every app locale.
export const IOS_PHONE_SCREENSHOT_DEVICES: readonly IosScreenshotDevice[] = [
  {
    name: 'iPhone 16 Pro Max',
    typeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max',
    orientation: 'PORTRAIT',
  },
];

export const IOS_IPAD_SCREENSHOT_DEVICES: readonly IosScreenshotDevice[] = [
  {
    name: 'iPad Pro 13-inch (M5)',
    typeId: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB',
    orientation: 'LANDSCAPE_LEFT',
  },
  {
    name: 'iPad Pro 11-inch (M5)',
    typeId: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB',
    orientation: 'LANDSCAPE_LEFT',
  },
];

export const IOS_SCREENSHOT_DEVICES: readonly IosScreenshotDevice[] = [
  ...IOS_PHONE_SCREENSHOT_DEVICES,
  ...IOS_IPAD_SCREENSHOT_DEVICES,
];

const COMMON_IOS_DEVICE_NAMES = IOS_SCREENSHOT_DEVICES.map((device) => device.name);
const PHONE_IOS_DEVICE_NAMES = IOS_PHONE_SCREENSHOT_DEVICES.map((device) => device.name);
const IPAD_IOS_DEVICE_NAMES = IOS_IPAD_SCREENSHOT_DEVICES.map((device) => device.name);
const DEFAULT_IOS_DEVICES_ARGUMENT = 'common';
const PHONE_IOS_DEVICES_ARGUMENT = 'phones';
const IPAD_IOS_DEVICES_ARGUMENT = 'ipads';
const DEFAULT_LOCALES_ARGUMENT = 'all';

export interface AppStoreLocaleTarget {
  appLocale: Locale;
  appStoreLocales: readonly string[];
}

const APP_STORE_LOCALES_BY_APP_LOCALE: Record<Locale, readonly string[]> = {
  'en-US': ['en-US'],
  es: ['es-ES', 'es-MX'],
  fr: ['fr-FR'],
  de: ['de-DE'],
};

/** Default / `--locales all` set. Excludes app locales without store screenshot folders yet. */
const STORE_READY_APP_LOCALES: readonly Locale[] = ['en-US', 'es', 'fr', 'de'];

export interface ScreenshotOptions {
  platform: ScreenshotPlatform;
  flow: ScreenshotFlow;
  backend: ScreenshotBackend;
  devices: string[];
  androidDevice: string;
  appLocales: Locale[];
  variant: string | null;
  theme: ScreenshotTheme;
  /** Workout type the Record/session screen pre-selects (generator screenshot); null = Off. */
  workout: string | null;
  /**
   * Board drawing the capture pins. `null` leaves the app's screenshot default
   * (Aura) in place; `classic` shoots the old look for a comparison set.
   */
  renderMode: string | null;
  /**
   * `|`-separated board selectors, in slot order — slot 0 is the board every
   * board-backed shot sits on, slot 1 the second board-view's wall. `null` leaves
   * the app's defaults (see `screenshot-mode.ts`) in place.
   */
  boards: string | null;
  /** Prebuilt/cached app artifact to install; iOS can build one when null. */
  appPath: string | null;
  /**
   * Capture orientation override for iOS device names not in IOS_SCREENSHOT_DEVICES
   * (e.g. an ad-hoc iPad passed via --device). Known devices keep their own
   * orientation; null falls back to portrait for unlisted names.
   */
  orientation: IosDeviceOrientation | null;
  /**
   * Android only: install the dev-client APK and serve its JS from a Metro this
   * script starts, instead of a standalone APK with the bundle baked in. iOS is
   * always a dev-client, so the flag does nothing there.
   */
  devClient: boolean;
  /**
   * Record the app's backend traffic, replay a recorded set, or neither. `off`
   * keeps the capture pointed at the live `--backend` and behaves exactly as it
   * did before fixtures existed.
   */
  fixtures: ScreenshotFixturesMode;
  /** Where the fixture set lives. A relative path resolves against the repo root. */
  fixturesDir: string;
  /** Record only: discard the existing fixture set instead of extending it. */
  fresh: boolean;
  /**
   * Record only: override the minted `frozenNow` FLOOR with this one. `null`
   * mints one (now, to the second). This is the START instant the app runs on
   * during the recording, not the value the finished set ships with: the
   * backend bumps the PERSISTED manifest's `frozenNow` past the newest
   * response actually recorded (see docs/mobile-screenshot-fixtures.md, "The
   * frozen clock"), so a run that takes 20 minutes never ships a fixture that
   * would replay as being in the future. Optional even for a multi-shard
   * recording — `mergeFixtureSets` takes the MAXIMUM finalized `frozenNow`
   * across every shard, so shards frozen at different instants still merge
   * into one coherent set.
   */
  frozenNow: string | null;
  shutdown: boolean;
}

export function parseArgs(argv: readonly string[]): ScreenshotOptions {
  const args = argv.filter((argument) => argument !== '--');
  const options: ScreenshotOptions = {
    platform: 'ios',
    flow: 'app-store',
    backend: 'local',
    devices: [...COMMON_IOS_DEVICE_NAMES],
    androidDevice: DEFAULT_ANDROID_DEVICE,
    appLocales: [...STORE_READY_APP_LOCALES],
    variant: null,
    // Dark is the canonical store appearance (the app defaults to dark).
    theme: 'dark',
    // Volume by default so the Record screen captures the workout generator with
    // a visible, selected tile (its shelf is a gesture-handler ScrollView Maestro
    // can't tap/scroll). `--workout off` leaves the generator Off ("Start a session").
    workout: 'volume',
    // null → the app's own screenshot defaults apply, so CI needs no env to get
    // the intended renderer and boards. Both exist to retarget a one-off run.
    renderMode: null,
    boards: null,
    appPath: null,
    orientation: null,
    devClient: false,
    fixtures: 'off',
    fixturesDir: DEFAULT_SCREENSHOT_FIXTURES_DIR,
    fresh: false,
    frozenNow: null,
    shutdown: false,
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
      case '--device': {
        const deviceName = expectValue(flag, value);
        options.devices = [deviceName];
        options.androidDevice = deviceName;
        index++;
        break;
      }
      case '--devices':
        options.devices = parseDevicesArgument(expectValue(flag, value));
        index++;
        break;
      case '--locales':
        options.appLocales = parseLocalesArgument(expectValue(flag, value));
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
      case '--render-mode':
        options.renderMode = expectEnum(flag, value, ['aura', 'classic', 'default']);
        index++;
        break;
      case '--boards':
        options.boards = expectValue(flag, value);
        index++;
        break;
      case '--app-path':
        options.appPath = resolve(expectValue(flag, value));
        index++;
        break;
      case '--orientation': {
        const orientation = expectEnum(flag, value, ['portrait', 'landscape']);
        options.orientation = orientation === 'landscape' ? 'LANDSCAPE_LEFT' : 'PORTRAIT';
        index++;
        break;
      }
      case '--dev-client':
        options.devClient = true;
        break;
      case '--fixtures':
        options.fixtures = expectEnum(flag, value, ['off', 'record', 'replay']) as ScreenshotFixturesMode;
        index++;
        break;
      case '--fixtures-dir':
        options.fixturesDir = expectValue(flag, value);
        index++;
        break;
      case '--fresh':
        options.fresh = true;
        break;
      case '--frozen-now':
        options.frozenNow = expectValue(flag, value);
        index++;
        break;
      case '--shutdown':
        options.shutdown = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  // Replay has nothing to discard and record is the only mode that writes, so a
  // `--fresh` anywhere else is a typo that would otherwise pass silently and
  // leave the caller believing the set was rebuilt.
  if (options.fresh && options.fixtures !== 'record') {
    throw new Error('--fresh only applies to --fixtures record');
  }

  // Same reasoning as --fresh: replay reads its frozen instant from the
  // manifest, so overriding it there is a no-op that would silently be ignored.
  if (options.frozenNow !== null) {
    if (options.fixtures !== 'record') {
      throw new Error('--frozen-now only applies to --fixtures record');
    }
    if (Number.isNaN(Date.parse(options.frozenNow))) {
      throw new Error(`--frozen-now must be a parseable ISO instant (got "${options.frozenNow}")`);
    }
  }

  return options;
}

function parseDevicesArgument(value: string): string[] {
  if (value === DEFAULT_IOS_DEVICES_ARGUMENT) {
    return [...COMMON_IOS_DEVICE_NAMES];
  }
  if (value === PHONE_IOS_DEVICES_ARGUMENT) {
    return [...PHONE_IOS_DEVICE_NAMES];
  }
  if (value === IPAD_IOS_DEVICES_ARGUMENT) {
    return [...IPAD_IOS_DEVICE_NAMES];
  }
  const devices = value
    .split(',')
    .map((deviceName) => deviceName.trim())
    .filter((deviceName) => deviceName.length > 0);
  if (devices.length === 0) {
    throw new Error('--devices requires at least one device name');
  }
  return devices;
}

function parseLocalesArgument(value: string): Locale[] {
  if (value === DEFAULT_LOCALES_ARGUMENT) {
    return [...STORE_READY_APP_LOCALES];
  }
  const locales = value
    .split(',')
    .map((locale) => locale.trim())
    .filter((locale) => locale.length > 0);
  if (locales.length === 0) {
    throw new Error('--locales requires at least one locale');
  }
  const invalidLocales = locales.filter((locale) => !isSupportedLocale(locale));
  if (invalidLocales.length > 0) {
    throw new Error(
      `--locales must contain supported app locales (${SUPPORTED_LOCALES.join(', ')}) or "all" (got ${invalidLocales.join(', ')})`,
    );
  }
  return Array.from(new Set(locales)) as Locale[];
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
 *
 * `backendPort` is the fixtures backend's own BOUND port — passed in by the
 * caller (which owns the `ScreenshotBackendSession` that bound it) rather than
 * re-derived from `BOARDSESH_SCREENSHOT_BACKEND_PORT` here, so this function
 * can never bake in a different port than the one actually listening.
 */
export function buildScreenshotEnv(
  options: ScreenshotOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
  appLocale: Locale | null = null,
  frozenNow: string | null = null,
  backendPort: number | null = null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    EXPO_PUBLIC_SCREENSHOT_MODE: '1',
    // Baked at JS-bundle time; theme-provider locks to it in screenshot mode.
    EXPO_PUBLIC_SCREENSHOT_THEME: options.theme,
    // The app auto-signs-in with these on boot (see screenshot-mode.ts), so the
    // Maestro flow never types into the login form — which pops iOS's
    // "Save Password?" dialog over every shot and blocks the board picker.
    EXPO_PUBLIC_SCREENSHOT_USER_EMAIL: baseEnv.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL,
    EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD: baseEnv.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD,
    // The app GETs this once it reaches home (AnalyticsScreenTracker), so the
    // orchestrator's readiness server sees it directly — a reach-home signal that
    // survives Metro's log-forwarding dying mid-run.
    EXPO_PUBLIC_SCREENSHOT_READY_URL: `http://localhost:${SCREENSHOT_READY_PORT}/ready`,
  };
  if (appLocale) {
    env.EXPO_PUBLIC_SCREENSHOT_LOCALE = appLocale;
  }
  if (options.variant) {
    env.EXPO_PUBLIC_SCREENSHOT_VARIANT = options.variant;
  }
  if (options.workout) {
    env.EXPO_PUBLIC_SCREENSHOT_WORKOUT = options.workout;
  }
  if (options.renderMode) {
    env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE = options.renderMode;
  }
  if (options.boards) {
    env.EXPO_PUBLIC_SCREENSHOT_BOARDS = options.boards;
  }
  if (options.backend === 'local') {
    env.EXPO_PUBLIC_BACKEND_URL = env.EXPO_PUBLIC_BACKEND_URL ?? LOCAL_BACKEND_URL;
    env.EXPO_PUBLIC_WEB_URL = env.EXPO_PUBLIC_WEB_URL ?? LOCAL_WEB_URL;
  }
  if (options.fixtures !== 'off') {
    if (!frozenNow) {
      // Not a defensive nicety: without the frozen instant the bundle would run
      // on the wall clock against frozen data, and every relative timestamp in
      // the capture would drift from the fixture set it is reading.
      throw new Error('buildScreenshotEnv needs the frozen instant when --fixtures is record or replay');
    }
    if (backendPort === null) {
      throw new Error('buildScreenshotEnv needs the bound backend port when --fixtures is record or replay');
    }
    // Overwrite, not `??`: the fixtures backend IS the backend for this run, so
    // it must win over both the `--backend local` defaults above and any
    // EXPO_PUBLIC_BACKEND_URL the caller exported.
    const backendUrl = `http://localhost:${backendPort}`;
    env.EXPO_PUBLIC_BACKEND_URL = backendUrl;
    env.EXPO_PUBLIC_WS_URL = `${backendUrl.replace(/^http/, 'ws')}/graphql`;
    // EXPO_PUBLIC_WEB_URL is deliberately left alone: the app's `/static/*`
    // reads go through EXPO_PUBLIC_BACKEND_URL, not the web URL, which instead
    // serves dev-only thumbnail routes and share links — redirecting it would
    // make a `--backend local` fixtures capture fail on `MISS route` for every
    // one of those, and would bake `localhost` share URLs into the bundle.
    env.EXPO_PUBLIC_SCREENSHOT_NOW = frozenNow;
  }
  return env;
}

export interface DeviceInfo {
  udid: string;
  name: string;
  state: string;
}

function runInherit(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string = ROOT_DIR): number {
  guardSimulatorCommand(command, args, ROOT_DIR);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  return result.status ?? 1;
}

function runCapture(command: string, args: string[], env?: NodeJS.ProcessEnv): { status: number; stdout: string } {
  guardSimulatorCommand(command, args, ROOT_DIR);
  // No `env` key at all when the caller passed none: spawnSync inherits
  // process.env only when the option is absent, and `env: undefined` would be a
  // silent, empty environment.
  const result = spawnSync(command, args, env ? { encoding: 'utf8', env } : { encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

/**
 * The env an app launched on a simulator runs with. `SIMCTL_CHILD_*` variables
 * are handed to the launched process (with the prefix stripped), so this pins
 * the app's timezone to UTC.
 *
 * Without it the capture inherits the host's zone, and every local-date
 * derivation in the app — day dividers, the activity heatmap's today cell, "3h
 * ago" crossing midnight — lands on a different calendar day on a developer's
 * machine than on a UTC CI runner, from the same frozen instant. The Android
 * side pins the same thing with the emulator's `-timezone UTC`.
 */
function simulatorLaunchEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SIMCTL_CHILD_TZ: 'UTC' };
}

function readPlistString(plistPath: string, key: string): string | null {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function validateIosAppLauncherUrl(appPath: string, metroPort = METRO_PORT): void {
  if (!appPath.endsWith('.app')) return;
  const infoPlist = join(appPath, 'Info.plist');
  const expectedLauncherUrl = `http://localhost:${metroPort}`;
  const actualLauncherUrl = readPlistString(infoPlist, 'DEV_CLIENT_DEFAULT_LAUNCHER_URL');
  if (actualLauncherUrl !== expectedLauncherUrl) {
    throw new Error(
      `${appPath} was built for DEV_CLIENT_DEFAULT_LAUNCHER_URL=${actualLauncherUrl ?? '(missing)'}, ` +
        `expected ${expectedLauncherUrl}. Rebuild it with BOARDSESH_METRO_PORT=${metroPort} or omit --app-path.`,
    );
  }
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

export function resolveIosScreenshotDevices(
  deviceNames: readonly string[],
  orientationOverride: IosDeviceOrientation | null = null,
): IosScreenshotDevice[] {
  return deviceNames.map((deviceName) => {
    const knownDevice = IOS_SCREENSHOT_DEVICES.find((device) => device.name === deviceName);
    // A known device keeps its own orientation — an override never clobbers a
    // record whose orientation we already know is correct.
    if (knownDevice) return knownDevice;
    // An unlisted device name: usable only if a simulator by that name already
    // exists (typeId: '' tells findOrCreateIosDevice it can't auto-create one, so
    // it errors with a clear message instead). Portrait is the fallback, but an
    // explicit --orientation lets an ad-hoc iPad capture in landscape.
    return {
      name: deviceName,
      typeId: '',
      orientation: orientationOverride ?? 'PORTRAIT',
    };
  });
}

export function resolveAppStoreLocaleTargets(appLocales: readonly Locale[]): AppStoreLocaleTarget[] {
  return appLocales.map((appLocale) => ({
    appLocale,
    appStoreLocales: APP_STORE_LOCALES_BY_APP_LOCALE[appLocale],
  }));
}

export function findOrCreateIosDevice(screenshotDevice: IosScreenshotDevice): DeviceInfo {
  const devices = listSimulatorDevices();
  const selectedUdid = process.env.BOARDSESH_IOS_SIMULATOR_UDID;
  if (selectedUdid) {
    const selectedDevice = devices.find((device) => device.udid.toUpperCase() === selectedUdid.toUpperCase());
    if (!selectedDevice) throw new Error(`Selected simulator ${selectedUdid} is unavailable.`);
    if (
      screenshotDevice.name !== selectedDevice.name &&
      screenshotDevice.name.toUpperCase() !== selectedUdid.toUpperCase()
    ) {
      throw new Error(
        `Screenshot device ${screenshotDevice.name} differs from leased simulator ${selectedDevice.name}. Pass the leased device explicitly.`,
      );
    }
    return selectedDevice;
  }
  const booted = devices.find((device) => device.name === screenshotDevice.name && device.state === 'Booted');
  if (booted) return booted;
  const existing = devices.find((device) => device.name === screenshotDevice.name);
  if (existing) return existing;
  if (screenshotDevice.typeId.length === 0) {
    throw new Error(
      `No "${screenshotDevice.name}" simulator found. Create it in Xcode or use one of: ${COMMON_IOS_DEVICE_NAMES.join(', ')}.`,
    );
  }

  const runtime = newestIosRuntime();
  if (!runtime) {
    throw new Error(
      `No "${screenshotDevice.name}" simulator found and no iOS runtime available to create one. Open Xcode > Settings > Components to install a simulator runtime, or create the device in Xcode.`,
    );
  }
  console.log(`${LOG} Creating simulator "${screenshotDevice.name}" (${runtime})...`);
  const { status } = runCapture('xcrun', ['simctl', 'create', screenshotDevice.name, screenshotDevice.typeId, runtime]);
  if (status !== 0) {
    throw new Error(`Failed to create simulator "${screenshotDevice.name}". Create it manually in Xcode and rerun.`);
  }
  const created = listSimulatorDevices().find((device) => device.name === screenshotDevice.name);
  if (!created) throw new Error(`Created "${screenshotDevice.name}" but could not locate it afterwards.`);
  return created;
}

/**
 * The booted simulator an ad-hoc tool should attach to. With one simulator booted,
 * returns it (matching Android's resolveRunningEmulator). With several booted,
 * disambiguates by `name` (the configured screenshot device) and throws when that
 * still isn't unique. Returns null when nothing is booted.
 */
export function resolveBootedIosDevice(name?: string): DeviceInfo | null {
  name = process.env.BOARDSESH_IOS_SIMULATOR_UDID ?? name;
  const booted = listSimulatorDevices().filter((device) => device.state === 'Booted');
  if (booted.length === 0) return null;
  if (name) {
    const named = booted.filter((device) => device.name === name || device.udid === name);
    if (named.length === 1) return named[0];
    throw new Error(`Requested simulator ${name} is not uniquely booted.`);
  }
  if (booted.length === 1) return booted[0];
  throw new Error(
    `Multiple booted simulators (${booted.map((device) => device.name).join(', ')}); pass --device "<name>" to pick one.`,
  );
}

export function bootDevice(device: DeviceInfo): void {
  if (device.state !== 'Booted') {
    console.log(`${LOG} Booting ${device.name} (${device.udid})...`);
    // `boot` errors if already booted; ignore that specific case.
    runCapture('xcrun', ['simctl', 'boot', device.udid]);
  }
  runCapture('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
  // Bring up the Simulator window so Maestro's iOS driver has a foreground app.
  spawnSync('open', ['-a', 'Simulator'], { stdio: 'ignore' });
}

export function applyCleanStatusBar(udid: string): void {
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

export function clearStatusBar(udid: string): void {
  runCapture('xcrun', ['simctl', 'status_bar', udid, 'clear']);
}

/**
 * Group the captured PNGs by content hash and return every group with more than
 * one file. Two byte-identical captures mean a navigation step silently failed
 * and the flow screenshotted the same screen twice — seen on the iPad 11",
 * where the Climbs sidebar tap missed and `02-climbs.png` shipped as a
 * pixel-perfect copy of `01-home.png`. Distinct screens never hash equal (the
 * status bar is frozen at 9:41, but screen content always differs), so any
 * duplicate is a real capture failure and the shard should fail loudly instead
 * of uploading a duplicate to the store.
 */
export function findDuplicateScreenshotGroups(captureDir: string): string[][] {
  const pngs = readdirSync(captureDir)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .sort();
  const filesByHash = new Map<string, string[]>();
  for (const png of pngs) {
    const digest = createHash('sha256')
      .update(readFileSync(join(captureDir, png)))
      .digest('hex');
    const group = filesByHash.get(digest);
    if (group) {
      group.push(png);
    } else {
      filesByHash.set(digest, [png]);
    }
  }
  return [...filesByHash.values()].filter((group) => group.length > 1);
}

/**
 * The app's screenshot default when `--render-mode` is not passed. Kept in step
 * with `SCREENSHOT_RENDER_MODE` in `packages/mobile/src/lib/screenshot-mode.ts`;
 * asserting against it is what catches a bundle that never picked the env up.
 */
export const DEFAULT_SCREENSHOT_RENDER_MODE = 'aura';

// Deliberately not /g: these are shared module constants, and a global regex
// carries `lastIndex` between calls. `matchAll` copies them, but `.exec`/`.test`
// would not, and that failure is intermittent. Matched per line instead, which
// also strips the timestamp Metro and logcat prefix each line with.
const RENDER_MODE_LINE = /\[screenshot\] render mode: (\S+) \(requested (\S+), probe (\S+)\)/;
const BOARD_WARN_LINE = /\[screenshot\] WARN board\[\d+\].*/;
const BOARD_ROSTER_LINE = /\[screenshot\] board roster: .*/;
const RENDER_SUMMARY_LINE = /\[screenshot\] (?:render mode:|board\[\d+\] ").*/;

/**
 * Everything wrong with what the app told us it drew, from the log the capture
 * produced (Metro's tee on iOS, logcat on Android).
 *
 * Both failure modes this catches are SILENT in the PNGs unless you already know
 * what to look for: the capability probe vetoing Aura on a stale binary yields a
 * complete, plausible store set in the old look, and an unmatched board selector
 * yields a complete set on the wrong wall. Neither trips the byte-identical
 * gate, so they'd reach the listing.
 */
export function findScreenshotRenderProblems(
  logText: string,
  options: { renderMode: string | null; requireRenderLine: boolean },
): string[] {
  const problems: string[] = [];
  const wanted = options.renderMode ?? DEFAULT_SCREENSHOT_RENDER_MODE;
  // `default` asks for whatever the app draws by default, which is what the app
  // then reports as the requested mode — so resolve it the same way it does.
  const wantedRequested = wanted === 'default' ? DEFAULT_SCREENSHOT_RENDER_MODE : wanted;

  const lines = logText.split('\n');

  let sawRenderLine = false;
  for (const line of lines) {
    const renderMode = line.match(RENDER_MODE_LINE);
    if (!renderMode) continue;
    const [, effective, requested, probe] = renderMode;
    sawRenderLine = true;
    if (requested !== wantedRequested) {
      problems.push(
        `app asked for the "${requested}" drawing, run wanted "${wantedRequested}" — the screenshot env did not reach the JS bundle.`,
      );
    }
    if (effective !== requested) {
      problems.push(
        `app drew "${effective}" after asking for "${requested}" (capability probe: ${probe}) — the installed binary cannot draw it.`,
      );
    }
  }
  if (options.requireRenderLine && !sawRenderLine) {
    problems.push('no "[screenshot] render mode:" line in the capture log — the board never rendered.');
  }

  const boardProblems: string[] = [];
  for (const line of lines) {
    const warning = line.match(BOARD_WARN_LINE);
    if (warning) boardProblems.push(warning[0].trim());
  }
  // The roster the app logged alongside a miss, so the failing run says what to
  // use instead. Carried separately because the app logs it on its own line —
  // see the truncation note in screenshot-board-selection.ts.
  if (boardProblems.length > 0) {
    for (const line of lines) {
      const roster = line.match(BOARD_ROSTER_LINE);
      if (roster) boardProblems.push(roster[0].trim());
    }
  }
  problems.push(...boardProblems);

  return [...new Set(problems)];
}

/**
 * The `[screenshot]` lines that say what a clean capture actually shot.
 *
 * Provenance, printed on success: "Aura, on Marco's Board" is the whole claim a
 * store set makes, and a board name alone doesn't settle whether it was the 10x12
 * anyone meant. Recording the resolved config in the run log means a set can be
 * traced to its walls months later without re-running the capture.
 */
export function summariseScreenshotRender(logText: string): string[] {
  const summary = logText
    .split('\n')
    .map((line) => line.match(RENDER_SUMMARY_LINE)?.[0].trim())
    .filter((line): line is string => !!line);
  return [...new Set(summary)];
}

/** Print what `findScreenshotRenderProblems` found; true when the capture is clean. */
function reportScreenshotRenderProblems(logText: string, options: ScreenshotOptions, source: string): boolean {
  const problems = findScreenshotRenderProblems(logText, {
    renderMode: options.renderMode,
    // Only the store flow is board-backed; the onboarding flow shoots screens
    // that never mount a board, so a missing render line there is expected.
    requireRenderLine: options.flow === 'app-store',
  });
  if (problems.length === 0) {
    for (const line of summariseScreenshotRender(logText)) {
      console.log(`${LOG} ${line}`);
    }
    return true;
  }
  for (const problem of problems) {
    console.error(`${LOG} FAILED: ${problem}`);
  }
  console.error(`${LOG} (read from ${source})`);
  return false;
}

/**
 * The frozen-clock line the app logs once at boot
 * (`screenshot-board-auto-activator.tsx`), as it reaches the capture log —
 * Metro's tee on iOS, logcat on Android.
 */
const FROZEN_CLOCK_LINE = /\[screenshot\] clock: frozen at (\S+)/;
const LIVE_CLOCK_LINE = /\[screenshot\] clock: live/;

/**
 * Whether the JS bundle actually froze "now" at the instant the fixture set was
 * recorded at.
 *
 * This is the silent half of a replay capture: the bodies come back frozen from
 * disk regardless, so a bundle still on the wall clock produces a complete,
 * plausible store set whose "3h ago" strings and heatmap window drift a little
 * further from the fixtures every day. Nothing else notices.
 *
 * Compared as instants, not strings: the manifest carries a whole-second
 * `2026-09-08T12:00:00Z` while the app logs `Date#toISOString`, which always
 * prints milliseconds.
 */
export function findFrozenClockProblems(logText: string, frozenNow: string): string[] {
  const lines = logText.split('\n');
  const expectedMs = Date.parse(frozenNow);
  let sawClockLine = false;
  const problems: string[] = [];

  for (const line of lines) {
    if (LIVE_CLOCK_LINE.test(line)) {
      sawClockLine = true;
      problems.push(
        `the app ran on the live clock while replaying fixtures frozen at ${frozenNow} — EXPO_PUBLIC_SCREENSHOT_NOW did not reach the JS bundle.`,
      );
      continue;
    }
    const frozen = line.match(FROZEN_CLOCK_LINE);
    if (!frozen) continue;
    sawClockLine = true;
    if (Date.parse(frozen[1]) !== expectedMs) {
      problems.push(
        `the app froze its clock at ${frozen[1]}, but the fixture set was recorded at ${frozenNow} — the two must be the same instant.`,
      );
    }
  }

  if (!sawClockLine) {
    problems.push(
      'no "[screenshot] clock:" line in the capture log — the app never reported which clock it was on, so the frozen instant could not be confirmed.',
    );
  }
  return [...new Set(problems)];
}

/** Print what `findFrozenClockProblems` found; true when the clock is pinned correctly. */
function reportFrozenClockProblems(logText: string, frozenNow: string, source: string): boolean {
  const problems = findFrozenClockProblems(logText, frozenNow);
  if (problems.length === 0) return true;
  for (const problem of problems) console.error(`${LOG} FAILED: ${problem}`);
  console.error(`${LOG} (read from ${source})`);
  return false;
}

/** Print what `findScreenshotBackendProblems` found; true when the capture is clean. */
function reportScreenshotBackendProblems(logText: string, mode: ScreenshotBackendMode): boolean {
  const problems = findScreenshotBackendProblems(logText, { mode });
  if (problems.length === 0) return true;
  for (const problem of problems) console.error(`${LOG} FAILED: ${problem}`);
  console.error(`${LOG} (read from ${SCREENSHOT_BACKEND_LOG_PATH})`);
  return false;
}

/**
 * How many lines the backend log holds right now.
 *
 * Snapshotted before each capture so the gate below judges only the traffic that
 * capture produced. One backend serves every device and locale in a run, so
 * without the slice the second device inherits the first's misses and every
 * later shard fails on a problem that was already reported.
 */
export function screenshotBackendLogLineCount(logPath: string = SCREENSHOT_BACKEND_LOG_PATH): number {
  if (!existsSync(logPath)) return 0;
  // Newlines, not `split().length` — the log is being appended to while this
  // reads it, and counting the trailing empty element as a line would make the
  // slice below drop the first line the capture actually produced.
  return readFileSync(logPath, 'utf8').split('\n').length - 1;
}

/** The backend log from `baselineLines` onward. */
export function readScreenshotBackendLogSince(
  baselineLines: number,
  logPath: string = SCREENSHOT_BACKEND_LOG_PATH,
): string {
  if (!existsSync(logPath)) return '';
  return readFileSync(logPath, 'utf8').split('\n').slice(baselineLines).join('\n');
}

/** A running screenshot backend, and the two facts the capture needs from it. */
export interface ScreenshotBackendSession {
  process: ChildProcess;
  mode: ScreenshotBackendMode;
  /** The instant this capture pretends it is — from the manifest on replay, from now on record. */
  frozenNow: string;
  port: number;
  /** Absolute path of the fixture set this session reads or writes. */
  fixturesDir: string;
}

/** Where the fixture set lives for this run, absolute. */
export function resolveFixturesDir(options: ScreenshotOptions): string {
  return isAbsolute(options.fixturesDir) ? options.fixturesDir : resolve(ROOT_DIR, options.fixturesDir);
}

/**
 * Has the backend WE started come up on this port?
 *
 * A healthy `/health` on its own is not the answer, and getting that wrong is
 * how a capture ends up reading somebody else's fixture set: when the port is
 * already held, our child exits 1 with EADDRINUSE while the squatter keeps
 * answering `/health` perfectly. So the READY line — which only our child can
 * have written, into a log this function's caller truncated moments ago — is the
 * half that proves whose backend this is.
 */
function screenshotBackendReady(port: number): boolean {
  const healthy =
    runCapture('curl', ['-fsS', '-o', '/dev/null', '--max-time', '2', `http://127.0.0.1:${port}/health`]).status === 0;
  if (!healthy) return false;
  if (!existsSync(SCREENSHOT_BACKEND_LOG_PATH)) return false;
  return readFileSync(SCREENSHOT_BACKEND_LOG_PATH, 'utf8')
    .split('\n')
    .some((line) => {
      const parsed = parseScreenshotBackendLogLine(line);
      return parsed?.event === 'ready' && parsed.port === port;
    });
}

/** Dump the tail of the backend log, the way dumpMetroLogTail does for Metro. */
function dumpScreenshotBackendLogTail(lines = 40): void {
  if (!existsSync(SCREENSHOT_BACKEND_LOG_PATH)) {
    console.error(`${LOG} (no screenshot backend log at ${SCREENSHOT_BACKEND_LOG_PATH} to dump)`);
    return;
  }
  const tail = readFileSync(SCREENSHOT_BACKEND_LOG_PATH, 'utf8').split('\n').slice(-lines).join('\n');
  console.error(`${LOG} --- last ${lines} lines of the screenshot backend log ---\n${tail}\n${LOG} --- end ---`);
}

/** The mode/port/fixturesDir/frozenNow a spawned backend needs, resolved once by the caller. */
interface ScreenshotBackendSpawnContext {
  mode: ScreenshotBackendMode;
  port: number;
  fixturesDir: string;
  frozenNow: string;
}

/**
 * The CLI args `startScreenshotBackend` spawns `scripts/screenshot-backend.ts`
 * with. Pure and exported so the once-per-process `--fresh` rule below is
 * testable without spawning anything.
 *
 * `alreadyStartedThisRun` is true once this process has already started a
 * backend with `--fresh` this run — a `--platform all` capture starts and stops
 * one backend PER PLATFORM, and passing `--fresh` to the second platform's
 * backend would wipe the first platform's recording before it's ever merged.
 */
export function buildBackendArgs(
  options: ScreenshotOptions,
  context: ScreenshotBackendSpawnContext,
  alreadyStartedThisRun: boolean,
): string[] {
  const args = [
    SCREENSHOT_BACKEND_SCRIPT,
    '--mode',
    context.mode,
    '--port',
    String(context.port),
    '--fixtures',
    context.fixturesDir,
    '--frozen-now',
    context.frozenNow,
    '--flow',
    options.flow,
  ];
  if (context.mode === 'record') {
    // `--backend prod` leaves the upstream unset so the CLI's own PROD default
    // applies — one place owns that URL.
    if (options.backend === 'local') args.push('--upstream', LOCAL_BACKEND_URL);
    if (options.fresh && !alreadyStartedThisRun) args.push('--fresh');
  }
  return args;
}

/**
 * Whether this process has already started a backend with `--fresh` (see
 * `buildBackendArgs`). Module-level, on purpose: it tracks "has THIS `vp run
 * mobile:screenshots` invocation already discarded the fixture set", which is a
 * property of the process, not of any one platform's run.
 */
let freshConsumedThisRun = false;

/**
 * Start the record/replay backend as a SEPARATE detached process, and refuse to
 * continue until it has actually bound.
 *
 * A child process for the same reason startReadinessServer uses one: this
 * orchestrator is fully synchronous (spawnSync for sleep/simctl/maestro), so an
 * in-process server's event loop would never get to accept a connection. Its
 * stdout+stderr go straight to a file descriptor — not through a pipe this
 * process would have to drain, and not through a `>` redirect a shell would
 * block-buffer.
 *
 * Failing here rather than warning is deliberate: a capture that runs on with no
 * backend renders the connectivity placard on every screen, which is a complete
 * set of wrong screenshots.
 */
export function startScreenshotBackend(options: ScreenshotOptions): ScreenshotBackendSession {
  const mode: ScreenshotBackendMode = options.fixtures === 'record' ? 'record' : 'replay';
  const fixturesDir = resolveFixturesDir(options);
  const port = resolveScreenshotBackendPort(process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT);
  if (port === 0) {
    // A real port number is baked into the JS bundle's backend URLs (see
    // buildScreenshotEnv) before this process binds anything, so an
    // OS-assigned ephemeral port (what 0 means to `.listen()`) would leave the
    // bundle pointed at a port nothing is actually listening on.
    throw new Error(
      'BOARDSESH_SCREENSHOT_BACKEND_PORT must not be 0 — the orchestrator has to know the exact port before the ' +
        'backend binds it. Pick a fixed port instead.',
    );
  }

  // Replay reproduces the recorded run, so its frozen instant is whatever the
  // recording froze — read from the manifest here (not left to the CLI) because
  // the same instant has to be baked into the JS bundle by buildScreenshotEnv.
  let frozenNow: string;
  if (mode === 'replay') {
    const manifest = readScreenshotFixtureManifest(fixturesDir);
    if (!manifest) {
      throw new Error(`no recorded fixture set under ${fixturesDir} — record one first with \`${RE_RECORD_COMMAND}\`.`);
    }
    frozenNow = manifest.frozenNow;
  } else {
    frozenNow = options.frozenNow ?? startOfSecondIso(new Date());
  }

  const args = buildBackendArgs(options, { mode, port, fixturesDir, frozenNow }, freshConsumedThisRun);
  if (mode === 'record' && options.fresh) freshConsumedThisRun = true;

  // A `--platform all` run stops one platform's backend and starts a fresh one
  // for the next; SIGTERM does not guarantee the OS frees the port the instant
  // the child exits, so wait for it the same way the Metro path does between
  // locales — this also covers the ordinary case (nothing was ever using the
  // port), where it returns immediately.
  if (!waitForPortToClose(port)) {
    throw new Error(
      `port ${port} did not close in time for the screenshot backend to bind — so the capture would talk to ` +
        `whatever is on it instead of this run's fixtures. Stop it, or set BOARDSESH_SCREENSHOT_BACKEND_PORT to a ` +
        `free port.`,
    );
  }

  // Truncate, so the miss gate below reads this run and no other.
  const logFd = openSync(SCREENSHOT_BACKEND_LOG_PATH, 'w');
  console.log(`${LOG} Starting the screenshot backend (mode=${mode}, port=${port}, frozenNow=${frozenNow})...`);
  const backend = spawn('tsx', args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  closeSync(logFd);
  backend.unref();

  const attempts = SCREENSHOT_BACKEND_READY_TIMEOUT_SECONDS * 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (screenshotBackendReady(port)) {
      console.log(`${LOG} Screenshot backend ready on port ${port} (log: ${SCREENSHOT_BACKEND_LOG_PATH}).`);
      return { process: backend, mode, frozenNow, port, fixturesDir };
    }
    spawnSync('sleep', ['0.5']);
  }

  dumpScreenshotBackendLogTail();
  stopScreenshotBackend({ process: backend, mode, frozenNow, port, fixturesDir });
  throw new Error(
    `the screenshot backend never answered /health on port ${port} within ${SCREENSHOT_BACKEND_READY_TIMEOUT_SECONDS}s — ` +
      `is the port already taken? See ${SCREENSHOT_BACKEND_LOG_PATH}.`,
  );
}

/** SIGTERM the backend's process group, so its final manifest rewrite runs. */
export function stopScreenshotBackend(session: ScreenshotBackendSession | null): void {
  if (!session || session.process.pid === undefined) return;
  console.log(`${LOG} Stopping the screenshot backend...`);
  try {
    process.kill(-session.process.pid, 'SIGTERM');
  } catch {
    try {
      session.process.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

/**
 * The message logged (and returned as the failure) when the backend's own
 * status endpoint can't be read at the end of a recording — the backend died
 * mid-capture, so nothing after that point was recorded reliably.
 */
export const RECORDING_STATUS_UNREACHABLE_MESSAGE =
  'the screenshot backend did not answer /__screenshot-backend/status — it died during the capture; nothing was recorded reliably';

export interface RecordingStatus {
  hits?: number;
  misses?: number;
  recorded?: number;
  redacted?: number;
  fixtures?: { graphql?: number; static?: number };
}

/**
 * Parse the backend's `/__screenshot-backend/status` response from the raw
 * curl result, or `null` when it can't be trusted: a non-zero exit (curl
 * couldn't even reach it) or a 200 whose body isn't JSON. Pure — no process or
 * network I/O — so this decision (what counts as "the backend died
 * mid-capture") is testable without a live server, unlike the curl call
 * itself.
 */
export function parseRecordingStatus(curlResult: { status: number; stdout: string }): RecordingStatus | null {
  if (curlResult.status !== 0) return null;
  try {
    return JSON.parse(curlResult.stdout) as RecordingStatus;
  } catch {
    return null;
  }
}

/**
 * What the recording actually captured. Printed at the end of a record run so
 * the operator can see the fixture set grew before committing it.
 *
 * Fails the run (rather than warning) when the status endpoint can't be read at
 * all: a curl failure or unparseable body means the backend process is gone or
 * wedged, and a recording that ends that way can't be trusted just because the
 * capture's own exit code was 0.
 *
 * A non-zero `redacted` also fails the run: those fixtures carried a live auth
 * token and were dropped, so the set on disk has holes the NEXT capture would
 * only discover as replay misses. (The backend CLI exits 1 on the same
 * condition, but this orchestrator is synchronous and never sees that exit
 * code.)
 */
export function reportRecordingSummary(session: ScreenshotBackendSession): boolean {
  const curlResult = runCapture('curl', [
    '-fsS',
    '--max-time',
    '5',
    `http://127.0.0.1:${session.port}/__screenshot-backend/status`,
  ]);
  const stats = parseRecordingStatus(curlResult);
  if (!stats) {
    console.error(`${LOG} FAILED: ${RECORDING_STATUS_UNREACHABLE_MESSAGE}`);
    return false;
  }
  console.log(
    `${LOG} Recorded ${stats.recorded ?? 0} new response(s); the set now holds ` +
      `${stats.fixtures?.graphql ?? 0} graphql + ${stats.fixtures?.static ?? 0} static fixtures ` +
      `(${stats.hits ?? 0} hit, ${stats.misses ?? 0} missed) in ${session.fixturesDir}.`,
  );
  if ((stats.redacted ?? 0) > 0) {
    console.error(
      `${LOG} FAILED: ${stats.redacted} fixture(s) carried a live auth token and were NOT written — the recording is incomplete.`,
    );
    return false;
  }
  return true;
}

/**
 * Replace a store folder's PNGs with the ones this capture produced.
 *
 * Replace, not merge: the numeric prefix is display order, so renumbering a slot
 * renames its file and a copy-over would leave the old name sitting next to the
 * new one. Both then upload, in an order nobody chose, and Play would be handed
 * more phone shots than it accepts.
 */
export function writeCapturedScreenshots(captureDir: string, outputDir: string): string[] {
  const pngs = readdirSync(captureDir).filter((file) => file.toLowerCase().endsWith('.png'));
  // Nothing to replace the old set with, so leave it alone. The caller fails the
  // run on an empty result either way, and the Play folder is committed to git —
  // a capture that produced nothing should not also stage the deletion of the
  // set that is currently live.
  if (pngs.length === 0) return [];
  mkdirSync(outputDir, { recursive: true });
  for (const existingFile of readdirSync(outputDir)) {
    if (existingFile.toLowerCase().endsWith('.png')) {
      rmSync(join(outputDir, existingFile), { force: true });
    }
  }
  const saved: string[] = [];
  for (const png of pngs) {
    const outputFile = join(outputDir, png);
    cpSync(join(captureDir, png), outputFile);
    saved.push(outputFile);
  }
  return saved;
}

function collectScreenshots(
  captureDir: string,
  platform: 'ios' | 'android',
  deviceName: string,
  appStoreLocales: readonly string[] | null = null,
): string[] {
  const storeRoot = join(OUTPUT_ROOT, STORE_BY_PLATFORM[platform], 'screenshots');
  if (!appStoreLocales) {
    return writeCapturedScreenshots(captureDir, join(storeRoot, deviceSlug(deviceName)));
  }

  const saved: string[] = [];
  for (const appStoreLocale of appStoreLocales) {
    saved.push(...writeCapturedScreenshots(captureDir, join(storeRoot, appStoreLocale, deviceSlug(deviceName))));
  }
  return saved;
}

function flowFileForPlatform(options: ScreenshotOptions, platform: 'ios' | 'android'): string {
  const platformFlowFile = join(MAESTRO_DIR, `${options.flow}-${platform}.yaml`);
  if (existsSync(platformFlowFile)) return platformFlowFile;
  return join(MAESTRO_DIR, `${options.flow}.yaml`);
}

export function isIpadScreenshotDevice(screenshotDevice: IosScreenshotDevice): boolean {
  return screenshotDevice.typeId.includes('iPad');
}

/**
 * The Maestro flow source for an iOS device. iPad deep links don't navigate on
 * the simulator — the "Open in 'Boardsesh'?" scheme-confirm dialog swallows every
 * `openurl` — so iPad drives navigation via sidebar coordinate taps from a
 * dedicated `<flow>-ipad.yaml`. Falls back to the shared `<flow>[-ios].yaml`
 * (iPhone's deep-link flow) when no iPad variant exists.
 */
export function iosSourceFlowFile(options: ScreenshotOptions, screenshotDevice: IosScreenshotDevice): string {
  if (isIpadScreenshotDevice(screenshotDevice)) {
    const ipadFlowFile = join(MAESTRO_DIR, `${options.flow}-ipad.yaml`);
    if (existsSync(ipadFlowFile)) return ipadFlowFile;
  }
  return flowFileForPlatform(options, 'ios');
}

// The iPad flow taps sidebar items by their locale-independent testID
// (`ipad-sidebar-<segment>`, see IpadSidebar) and verifies each navigation via
// the item's `selected` accessibility state — no per-device coordinate math.
// Only the orientation placeholder needs substituting per device.
export function renderMaestroFlowForIosDevice(flowSource: string, screenshotDevice: IosScreenshotDevice): string {
  return flowSource.replaceAll(MAESTRO_DEVICE_ORIENTATION_PLACEHOLDER, screenshotDevice.orientation);
}

export function rotationDegreesForIosOrientation(orientation: IosDeviceOrientation): number | null {
  return orientation === 'LANDSCAPE_LEFT' ? -90 : null;
}

function renderedFlowFileForIosDevice(
  options: ScreenshotOptions,
  screenshotDevice: IosScreenshotDevice,
  captureDir: string,
): string {
  const flowFile = iosSourceFlowFile(options, screenshotDevice);
  if (!existsSync(flowFile)) return flowFile;
  const renderedFlowFile = join(captureDir, `${options.flow}-${deviceSlug(screenshotDevice.name)}.yaml`);
  writeFileSync(renderedFlowFile, renderMaestroFlowForIosDevice(readFileSync(flowFile, 'utf8'), screenshotDevice));
  return renderedFlowFile;
}

function readPngDimensions(filePath: string): { width: number; height: number } | null {
  const { status, stdout } = runCapture('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]);
  if (status !== 0) return null;
  const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  const width = widthMatch ? Number.parseInt(widthMatch[1], 10) : Number.NaN;
  const height = heightMatch ? Number.parseInt(heightMatch[1], 10) : Number.NaN;
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function normalizeCapturedIosScreenshots(captureDir: string, screenshotDevice: IosScreenshotDevice): number {
  const rotationDegrees = rotationDegreesForIosOrientation(screenshotDevice.orientation);
  if (rotationDegrees === null) return 0;

  const pngs = readdirSync(captureDir).filter((file) => file.toLowerCase().endsWith('.png'));
  for (const png of pngs) {
    const screenshotPath = join(captureDir, png);
    const dimensions = readPngDimensions(screenshotPath);
    if (dimensions && dimensions.width > dimensions.height) continue;
    const { status } = runCapture('sips', ['-r', String(rotationDegrees), screenshotPath]);
    if (status !== 0) {
      console.error(`${LOG} FAILED: could not rotate landscape iOS screenshot ${png}.`);
      return status;
    }
  }
  return 0;
}

function captureIosDevice(
  options: ScreenshotOptions,
  screenshotDevice: IosScreenshotDevice,
  appPath: string,
  localeTarget: AppStoreLocaleTarget,
  backendSession: ScreenshotBackendSession | null,
): number {
  const device = findOrCreateIosDevice(screenshotDevice);
  bootDevice(device);
  applyCleanStatusBar(device.udid);

  console.log(`${LOG} Installing ${appPath} on ${device.name} for ${localeTarget.appLocale}...`);
  // Install in place to preserve app data and the simulator keychain.
  const install = runCapture('xcrun', ['simctl', 'install', device.udid, appPath]);
  if (install.status !== 0) {
    console.error(`${LOG} FAILED: simctl install exited ${install.status}.`);
    return install.status;
  }

  const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-shots-'));
  // Every exit below this point but the last is a failure, and the finally block
  // cannot see a return value — so the last statement of the try flips this.
  let captureSucceeded = false;
  try {
    // Metro is already up and pre-warmed by runIos (once per locale, before this
    // per-device loop), so this goes straight to launching the app.
    //
    // Every device in a locale shares one Metro log, and startMetro only truncates
    // it when Metro starts — so a `$screen /home` line from the previous device is
    // still in the log. Snapshot the current marker count and wait for it to
    // INCREASE (not merely be present), or device 2+ would skip the readiness wait
    // on a stale marker and capture a blank/loading frame.
    const homeReadyBaseline = homeReadyMarkerCount();
    const readinessBaseline = screenshotReadinessCount();
    // Snapshot before the app can talk to the backend, so the gate below judges
    // only this device's traffic (one backend serves the whole run).
    const backendLogBaseline = screenshotBackendLogLineCount();

    // First try a plain launch — no `simctl openurl`. The screenshots build bakes
    // DEV_CLIENT_DEFAULT_LAUNCHER_URL=http://localhost:${METRO_PORT} into
    // Info.plist (see ./plugins/with-screenshot-dev-menu), so the dev-client
    // auto-connects to Metro on a plain launch and — auto-signed-in (see auth-provider's
    // SCREENSHOT_MODE branch) — lands straight on home, without ever opening the
    // custom-scheme URL or showing a login screen. That matters because a fresh CI
    // sim raises an "Open in Boardsesh?" confirmation for ANY openurl of the
    // scheme, and Maestro can't dismiss it reliably. Dev-menu chrome is suppressed
    // via the same plugin.
    console.log(`${LOG} Launching the app (auto-loads Metro via DEV_CLIENT_DEFAULT_LAUNCHER_URL)...`);
    runCapture('xcrun', ['simctl', 'launch', device.udid, APP_ID], simulatorLaunchEnv());

    // The app auto-signs-in and boots straight to home, so wait for it to get
    // there before Maestro runs — this is what login.yaml's readiness wait used to
    // do (now deleted; there's no login screen to gate on).
    console.log(`${LOG} Waiting for the app to auto-sign-in and reach home...`);
    // The dev-client's auto-connect to Metro is intermittently flaky in CI — the app
    // lands on the "Searching for development servers" launcher (or the "Failed to
    // load app" error) instead of loading the JS. When that happens, re-launch and try
    // again; each fresh launch re-attempts the connect, and a shard that never recovers
    // fails hard (rather than capturing the launcher) so it can be re-run.
    //
    // Re-launch PLAINLY on BOTH devices — never `openurl`. A plain `simctl launch`
    // re-triggers the dev-client's DEV_CLIENT_DEFAULT_LAUNCHER_URL auto-connect with no
    // dialog. An openurl raises the "Open in 'Boardsesh'?" confirm which, undismissed
    // here (this is BEFORE the flow's prime block), blocks the app from ever loading —
    // that's exactly why the iPhone shards hung through every retry in CI while the iPad
    // (already plain-relaunch) passed. The readiness ping + `$screen /home` marker then
    // both register once the app actually reaches home.
    //
    // Generous per-wait budget: a CI cold bundle build alone is ~35-60s, on top of a
    // slow simulator boot + auto-sign-in, so 45s (the old iPhone value) timed out before
    // the app could ever get home.
    let reachedHome = waitForHomeReady(homeReadyBaseline, readinessBaseline, 120);
    for (let attempt = 1; attempt <= 3 && !reachedHome; attempt += 1) {
      console.log(`${LOG} Not home yet; terminating and re-launching (attempt ${attempt}/3)...`);
      runCapture('xcrun', ['simctl', 'terminate', device.udid, APP_ID]);
      runCapture('xcrun', ['simctl', 'launch', device.udid, APP_ID], simulatorLaunchEnv());
      reachedHome = waitForHomeReady(homeReadyBaseline, readinessBaseline, 120);
    }
    if (!reachedHome) {
      console.error(`${LOG} FAILED: app did not reach the home screen (auto sign-in / bundle load).`);
      // Diagnose which reach-home signal (if any) moved: a marker gain means the app
      // reached home but the readiness ping never arrived; a readiness gain we somehow
      // missed; neither means the app never loaded its JS at all.
      console.error(
        `${LOG} reach-home signals: marker ${homeReadyMarkerCount() - homeReadyBaseline} new, ` +
          `readiness ${screenshotReadinessCount() - readinessBaseline} new ` +
          `(server reachable from host: ${readinessServerReachable() ? 'yes' : 'NO'}).`,
      );
      dumpMetroLogTail();
      return 1;
    }

    const sourceFlowFile = iosSourceFlowFile(options, screenshotDevice);
    if (!existsSync(sourceFlowFile)) {
      console.error(`${LOG} FAILED: flow not found: ${sourceFlowFile}`);
      return 1;
    }
    const flowFile = renderedFlowFileForIosDevice(options, screenshotDevice, captureDir);
    const email = process.env.SCREENSHOT_USER_EMAIL ?? DEFAULT_USER_EMAIL;
    const password = process.env.SCREENSHOT_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
    console.log(`${LOG} Running Maestro flow ${options.flow} on ${device.udid} (${screenshotDevice.orientation})...`);
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

    const normalizeStatus = normalizeCapturedIosScreenshots(captureDir, screenshotDevice);
    if (normalizeStatus !== 0) return normalizeStatus;

    // The app's own `[screenshot]` markers land in Metro's stdout, which startMetro
    // tees here (truncated per locale, so this is only ever the current run's).
    const metroLog = existsSync(METRO_LOG_PATH) ? readFileSync(METRO_LOG_PATH, 'utf8') : '';
    if (!reportScreenshotRenderProblems(metroLog, options, METRO_LOG_PATH)) return 1;

    if (backendSession) {
      const backendLog = readScreenshotBackendLogSince(backendLogBaseline);
      if (!reportScreenshotBackendProblems(backendLog, backendSession.mode)) return 1;
      // Both modes carry a frozenNow — replay reads it from the manifest, record
      // mints one (or takes --frozen-now) — so the bundle's clock is checked
      // against it either way.
      if (!reportFrozenClockProblems(metroLog, backendSession.frozenNow, METRO_LOG_PATH)) return 1;
    }

    const duplicateGroups = findDuplicateScreenshotGroups(captureDir);
    if (duplicateGroups.length > 0) {
      for (const group of duplicateGroups) {
        console.error(
          `${LOG} FAILED: byte-identical captures ${group.join(' = ')} — a navigation step did not take effect.`,
        );
      }
      return 1;
    }

    const saved = collectScreenshots(captureDir, 'ios', device.name, localeTarget.appStoreLocales);
    if (saved.length === 0) {
      console.error(`${LOG} WARNING: flow completed but no PNGs were captured.`);
      return 1;
    }
    console.log(
      `${LOG} Saved ${saved.length} screenshot(s) to app-stores/${STORE_BY_PLATFORM.ios}/screenshots/{${localeTarget.appStoreLocales.join(',')}}/${deviceSlug(device.name)}/`,
    );
    for (const file of saved) console.log(`${LOG}   ${file}`);
    captureSucceeded = true;
  } finally {
    if (!captureSucceeded) preserveFailedRunArtifacts(captureDir);
    rmSync(captureDir, { force: true, recursive: true });
    clearStatusBar(device.udid);
    if (options.shutdown) {
      runCapture('xcrun', ['simctl', 'shutdown', device.udid]);
    }
  }

  return 0;
}

/**
 * Stream the device log to `LOGCAT_LOG_PATH` until the returned process is killed.
 *
 * Started before Maestro launches the app, so the app's `[screenshot]` markers
 * cannot rotate out from under the capture gate. Multiple readers on logcat are
 * fine — the CI wrapper keeps its own stream for the debug artifact, and neither
 * consumes the buffer.
 */
function startLogcatStream(deviceId: string): ChildProcess {
  writeFileSync(LOGCAT_LOG_PATH, '');
  const logFile = openSync(LOGCAT_LOG_PATH, 'a');
  let stream: ChildProcess;
  try {
    stream = spawn('adb', ['-s', deviceId, 'logcat'], { stdio: ['ignore', logFile, 'ignore'] });
  } catch (error) {
    // The exit handler below is what normally closes this; if the spawn never
    // happened there is nothing to hang it on.
    closeSync(logFile);
    throw error;
  }
  stream.on('exit', () => closeSync(logFile));
  // Named rather than swallowed: a stream that never started reads to the gate as
  // an app that never logged, and those have different fixes.
  stream.on('error', (error) => console.error(`${LOG} adb logcat stream failed to start: ${error.message}`));
  return stream;
}

/**
 * Whether the streamed device log is worth reading yet.
 *
 * A dead reader beats a present marker. This runs after Maestro has finished and
 * before anything kills the stream, so a stopped reader is always unexpected —
 * and the marker is not the last thing the app logs. A board selector that missed
 * warns whenever the shot that needs it opens, which on a two-wall flow is long
 * after the first render. Accepting a truncated log because the render line
 * happened to land in it is exactly how a fallback wall reaches the store.
 *
 * `reader-died` and `waiting` are separate because they need different fixes: one
 * is a broken reader, the other an app that has not spoken yet.
 */
export function screenshotLogcatState(streamAlive: boolean, logText: string): 'ready' | 'reader-died' | 'waiting' {
  if (!streamAlive) return 'reader-died';
  if (RENDER_MODE_LINE.test(logText)) return 'ready';
  return 'waiting';
}

/**
 * Whether the log stream is still writing, asked of the OS rather than of Node.
 *
 * `ChildProcess.exitCode` is populated when the event loop delivers the child's
 * exit, and this orchestrator is spawnSync from end to end — the loop never turns
 * between starting the stream and reading it, so `exitCode` reads `null` however
 * long ago adb died. `ps` has no such blind spot. An empty result is a process
 * that is gone; `Z` is one that exited and is still waiting to be reaped by an
 * event loop that will not run until the capture is over.
 */
function logcatStreamAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const state = runCapture('ps', ['-o', 'stat=', '-p', String(pid)]).stdout.trim();
  return state.length > 0 && !state.startsWith('Z');
}

/** Bytes written so far, or 0 if the stream has not created the file yet. */
function logcatSize(): number {
  try {
    return statSync(LOGCAT_LOG_PATH).size;
  } catch {
    return 0;
  }
}

/**
 * The streamed device log, once the app's markers have actually landed in it.
 *
 * Waits for the marker rather than sleeping a fixed two seconds: `adb logcat`
 * buffers, and a slow emulator can trail the capture by more than a guess — a
 * gate that reads too early is the bug this whole file just fixed.
 *
 * Returns null when the stream died before recording anything.
 */
function readSettledLogcat(stream: ChildProcess): string | null {
  let lastSize = -1;
  let logcat = '';
  for (let attempt = 0; attempt < 15; attempt += 1) {
    // A real capture writes ~9MB here; re-reading all of it 15 times to answer
    // one boolean is 130MB of pointless I/O, so only re-read once adb has
    // actually appended something.
    const size = logcatSize();
    if (size !== lastSize) {
      lastSize = size;
      logcat = size > 0 ? readFileSync(LOGCAT_LOG_PATH, 'utf8') : '';
    }
    const state = screenshotLogcatState(logcatStreamAlive(stream.pid), logcat);
    if (state === 'ready') return logcat;
    if (state === 'reader-died') {
      console.error(
        `${LOG} FAILED: the adb logcat stream is no longer running, so the log is truncated and anything the app logged after it died is missing.`,
      );
      return null;
    }
    runCapture('sleep', ['1']);
  }
  // Out of patience. Hand back whatever landed and let the gate name what is
  // missing from it — "no render mode line" says more than "timed out" — but say
  // out loud that we stopped waiting, so a genuinely slow emulator is
  // distinguishable from an app that never logged.
  console.error(`${LOG} the capture log never showed a render-mode line in 15 polls; checking what did land.`);
  return logcat;
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

  // A standalone APK carries its JS — and therefore its backend URL — from build
  // time, so pointing it at a local fixtures backend is impossible. Say so
  // instead of capturing a full set against the live backend under a flag that
  // claims otherwise.
  if (options.fixtures !== 'off' && !options.devClient) {
    console.error(
      `${LOG} FAILED: --fixtures needs --dev-client on Android; a standalone APK bakes its backend URL in.`,
    );
    return 1;
  }

  // The dev-client APK carries no JS, so it resolves through the shared APK
  // cache (download the latest rn-android-dev-* release, or build one) and runs
  // under the side-by-side .dev package.
  const appPath = options.devClient
    ? ensureAndroidApk({ appPath: options.appPath ?? undefined })
    : resolveAndroidAppPath(options);
  const packageId = options.devClient ? ANDROID_DEV_PACKAGE : APP_ID;
  const deviceName = androidDeviceName(options);
  console.log(`${LOG} Installing ${appPath} on ${deviceId} (${deviceName})...`);
  if (options.devClient) {
    // Throws on a failed install; main() turns that into a FAILED line + exit 1.
    installDevClient('adb', deviceId, appPath);
  } else {
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
  }
  // Drop whatever an earlier run left in the ring buffer, then start streaming to
  // a file BEFORE Maestro launches the app — see LOGCAT_LOG_PATH for why a
  // post-hoc `logcat -d` loses the app's markers on a chatty run.
  runCapture('adb', ['-s', deviceId, 'logcat', '-c']);
  const logcatStream = startLogcatStream(deviceId);
  applyCleanAndroidStatusBar(deviceId);

  const flowFile = flowFileForPlatform(options, 'android');
  if (!existsSync(flowFile)) {
    console.error(`${LOG} FAILED: flow not found: ${flowFile}`);
    return 1;
  }

  const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-android-shots-'));
  // See captureIosDevice: the finally block cannot see a return value, so the
  // last statement of the try flips this.
  let captureSucceeded = false;
  let devClientSession: DevClientSession | null = null;
  let backendSession: ScreenshotBackendSession | null = null;
  let backendLogBaseline = 0;
  try {
    if (options.fixtures !== 'off') backendSession = startScreenshotBackend(options);
    if (options.devClient) {
      // Android captures the single en-US tree (the locale matrix is iOS-only),
      // so no locale is baked into the bundle here.
      const metroEnv = buildScreenshotEnv(
        options,
        process.env,
        null,
        backendSession?.frozenNow ?? null,
        backendSession?.port ?? null,
      );
      console.log(
        `${LOG} Starting Metro on ${METRO_PORT} (backend=${options.backend}, theme=${options.theme}, flow=${options.flow}${options.variant ? `, variant=${options.variant}` : ''}${options.fixtures !== 'off' ? `, fixtures=${options.fixtures}` : ''})...`,
      );
      devClientSession = startMetroForDevClient(metroEnv);
      // The emulator's localhost is its own loopback, so the fixtures backend
      // needs reversing onto the host exactly like the local dev backend does.
      const reversePorts = [
        ...(options.backend === 'local' ? LOCAL_BACKEND_REVERSE_PORTS : []),
        ...(backendSession ? [backendSession.port] : []),
      ];
      connectDevClient('adb', deviceId, reversePorts);
      backendLogBaseline = screenshotBackendLogLineCount();
      if (!launchDevClientToHome('adb', deviceId, { logPrefix: LOG })) {
        console.error(`${LOG} FAILED: dev-client never reached home`);
        return 1;
      }
    }

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
        // The flows declare `appId: ${APP_ID}`; the standalone store APK is the
        // production package (the dev-client path passes the .dev package).
        '-e',
        `APP_ID=${packageId}`,
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

    const logcat = readSettledLogcat(logcatStream);
    if (logcat === null) return 1;
    if (!reportScreenshotRenderProblems(logcat, options, LOGCAT_LOG_PATH)) return 1;

    if (backendSession) {
      const backendLog = readScreenshotBackendLogSince(backendLogBaseline);
      if (!reportScreenshotBackendProblems(backendLog, backendSession.mode)) return 1;
      // Both modes carry a frozenNow — replay reads it from the manifest, record
      // mints one (or takes --frozen-now) — so the bundle's clock is checked
      // against it either way.
      if (!reportFrozenClockProblems(logcat, backendSession.frozenNow, LOGCAT_LOG_PATH)) return 1;
      if (backendSession.mode === 'record' && !reportRecordingSummary(backendSession)) return 1;
    }

    const duplicateGroups = findDuplicateScreenshotGroups(captureDir);
    if (duplicateGroups.length > 0) {
      for (const group of duplicateGroups) {
        console.error(
          `${LOG} FAILED: byte-identical captures ${group.join(' = ')} — a navigation step did not take effect.`,
        );
      }
      return 1;
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
    captureSucceeded = true;
  } finally {
    // First, so a Maestro failure (or any early return above) still takes Metro
    // and the readiness server down with it.
    if (devClientSession) stopDevClientSession(devClientSession);
    stopScreenshotBackend(backendSession);
    logcatStream.kill();
    clearAndroidStatusBar(deviceId);
    if (!captureSucceeded) preserveFailedRunArtifacts(captureDir);
    rmSync(captureDir, { force: true, recursive: true });
    if (options.shutdown && deviceId.startsWith('emulator-')) {
      runCapture('adb', ['-s', deviceId, 'emu', 'kill']);
    }
  }

  return 0;
}

/**
 * Keep the evidence of a failed run: whatever Maestro shot before it gave up,
 * and the screenshot backend's own log.
 *
 * captureDir is a temp dir the finally block removes, so the partial set (which
 * step went wrong) would otherwise vanish; CI's capture script exports
 * SCREENSHOT_DEBUG_DIR (uploaded as an artifact) for exactly this.
 *
 * The backend log matters just as much and used to be left behind: it lives in
 * the OS temp dir, so the artifact carried the PNGs and the device log but not
 * the one file that says which operation missed and with what variables.
 * Diagnosing run 34240391447 meant brute-forcing a 12-character hash offline;
 * the log now rides along.
 */
function preserveFailedRunArtifacts(captureDir: string): void {
  const debugDir = process.env.SCREENSHOT_DEBUG_DIR;
  if (!debugDir) return;
  const pngs = readdirSync(captureDir).filter((file) => file.endsWith('.png'));
  if (pngs.length > 0) {
    const target = join(debugDir, 'captures');
    mkdirSync(target, { recursive: true });
    for (const png of pngs) copyFileSync(join(captureDir, png), join(target, png));
    console.error(`${LOG} kept ${pngs.length} capture(s) from the failed run in ${target}`);
  }
  if (!existsSync(SCREENSHOT_BACKEND_LOG_PATH)) return;
  mkdirSync(debugDir, { recursive: true });
  const backendLogTarget = join(debugDir, 'screenshot-backend.log');
  copyFileSync(SCREENSHOT_BACKEND_LOG_PATH, backendLogTarget);
  console.error(`${LOG} kept the screenshot backend log from the failed run in ${backendLogTarget}`);
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
  return options.androidDevice;
}

function resolveAndroidAppPath(options: ScreenshotOptions): string {
  if (options.appPath) {
    if (!existsSync(options.appPath)) {
      throw new Error(`--app-path not found: ${options.appPath}`);
    }
    validateIosAppLauncherUrl(options.appPath);
    return options.appPath;
  }
  if (existsSync(DEFAULT_ANDROID_APK)) {
    return DEFAULT_ANDROID_APK;
  }
  throw new Error(
    `Android capture requires --app-path <path/to/app.apk>. Build the screenshot APK first, or place one at ${DEFAULT_ANDROID_APK}.`,
  );
}

export function applyCleanAndroidStatusBar(deviceId: string): void {
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

export function clearAndroidStatusBar(deviceId: string): void {
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

function runIos(options: ScreenshotOptions): number {
  if (!commandExists('xcrun') || runCapture('xcrun', ['simctl', 'help']).status !== 0) {
    console.log(`${LOG} Skipped: iOS simulator tooling (xcrun simctl) not available.`);
    return 0;
  }
  if (!commandExists('maestro')) {
    console.error(`${LOG} FAILED: Maestro not found on PATH. ${MAESTRO_INSTALL_HINT}`);
    return 1;
  }

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

  const appPath = resolveAppPath(options);
  const screenshotDevices = resolveIosScreenshotDevices(options.devices, options.orientation);
  const localeTargets = resolveAppStoreLocaleTargets(options.appLocales);

  const readinessServer = startReadinessServer();
  let backendSession: ScreenshotBackendSession | null = null;
  try {
    // Started once for the whole run (every locale, every device), so the
    // per-capture gate slices the log from a baseline rather than reading it whole.
    if (options.fixtures !== 'off') backendSession = startScreenshotBackend(options);
    const status = runIosLocales(options, appPath, screenshotDevices, localeTargets, backendSession);
    if (status !== 0) return status;
    if (backendSession?.mode === 'record' && !reportRecordingSummary(backendSession)) return 1;
    return 0;
  } finally {
    stopScreenshotBackend(backendSession);
    stopReadinessServer(readinessServer);
  }
}

function runIosLocales(
  options: ScreenshotOptions,
  appPath: string,
  screenshotDevices: readonly IosScreenshotDevice[],
  localeTargets: readonly AppStoreLocaleTarget[],
  backendSession: ScreenshotBackendSession | null,
): number {
  for (let localeIndex = 0; localeIndex < localeTargets.length; localeIndex++) {
    if (localeIndex > 0 && !waitForPortToClose(METRO_PORT)) {
      console.error(`${LOG} FAILED: Metro port ${METRO_PORT} did not close after the previous locale run.`);
      return 1;
    }
    const localeTarget = localeTargets[localeIndex];
    const metroEnv = buildScreenshotEnv(
      options,
      process.env,
      localeTarget.appLocale,
      backendSession?.frozenNow ?? null,
      backendSession?.port ?? null,
    );
    console.log(
      `${LOG} Starting Metro on ${METRO_PORT} (backend=${options.backend}, theme=${options.theme}, flow=${options.flow}, locale=${localeTarget.appLocale}${options.variant ? `, variant=${options.variant}` : ''}${options.fixtures !== 'off' ? `, fixtures=${options.fixtures}` : ''})...`,
    );
    const metro = startMetro(metroEnv);
    try {
      if (!waitForMetro()) {
        console.error(`${LOG} FAILED: Metro did not become ready on port ${METRO_PORT}.`);
        return 1;
      }
      prewarmMetroBundle();
      for (const screenshotDevice of screenshotDevices) {
        const status = captureIosDevice(options, screenshotDevice, appPath, localeTarget, backendSession);
        if (status !== 0) return status;
      }
    } finally {
      stopMetro(metro);
    }
  }

  return 0;
}

/**
 * Resolve the Boardsesh.app to install: a prebuilt/cached one (--app-path, the CI
 * common path) or a freshly built Debug simulator app (local one-command DX).
 */
export function resolveAppPath(options: ScreenshotOptions): string {
  if (options.appPath) {
    if (!existsSync(options.appPath)) {
      throw new Error(`--app-path not found: ${options.appPath}`);
    }
    return options.appPath;
  }
  console.log(`${LOG} No --app-path given; building a Debug simulator app (slow — CI passes a cached .app)...`);
  const status = runInherit('tsx', [BUILD_SIM_APP_SCRIPT, '--', '--app-out', APP_CACHE_DIR], process.env);
  if (status !== 0) {
    throw new Error(`simulator app build failed (exit ${status})`);
  }
  const built = join(APP_CACHE_DIR, 'Boardsesh.app');
  if (!existsSync(built)) {
    throw new Error(`build reported success but ${built} is missing`);
  }
  return built;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  let options: ScreenshotOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // --devices (the iOS device matrix) and --locales (the iOS locale matrix) only
  // feed runIos; runAndroid captures the single --device into one en-US tree. Warn
  // if they were passed for an android-only run so they don't look silently
  // honoured. (`--platform all` still runs iOS, which does consume them.)
  if (options.platform === 'android') {
    const ignoredIosFlags = ['--devices', '--locales'].filter((flag) => argv.includes(flag));
    if (ignoredIosFlags.length > 0) {
      console.warn(
        `${LOG} ${ignoredIosFlags.join(' and ')} only affect iOS captures and are ignored for --platform android; ` +
          `use --device to pick the Android device.`,
      );
    }
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
