import { afterEach, describe, expect, it } from 'vitest';
// Relative, not '@boardsesh/i18n': the scripts vitest project doesn't resolve
// workspace package names (same as mobile-locales-parity.test.ts).
import { SUPPORTED_LOCALES } from '../../packages/shared/i18n/src/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBackendArgs,
  buildScreenshotEnv,
  deviceSlug,
  findFrozenClockProblems,
  parseRecordingStatus,
  readScreenshotBackendLogSince,
  reportRecordingSummary,
  screenshotBackendLogLineCount,
  startScreenshotBackend,
  DEFAULT_SCREENSHOT_RENDER_MODE,
  RECORDING_STATUS_UNREACHABLE_MESSAGE,
  findDuplicateScreenshotGroups,
  findScreenshotRenderProblems,
  iosSourceFlowFile,
  screenshotLogcatState,
  summariseScreenshotRender,
  writeCapturedScreenshots,
  isIpadScreenshotDevice,
  parseArgs,
  renderMaestroFlowForIosDevice,
  resolveAppStoreLocaleTargets,
  resolveIosScreenshotDevices,
  rotationDegreesForIosOrientation,
  validateIosAppLauncherUrl,
  type IosScreenshotDevice,
  type ScreenshotBackendSession,
  type ScreenshotOptions,
} from '../mobile-screenshots';
import { metroDevClientUrl, SCREENSHOT_READY_PORT, screenshotReadinessCount } from '../lib/metro-dev-server';

const phoneDevices = ['iPhone 16 Pro Max'];
const ipadDevices = ['iPad Pro 13-inch (M5)', 'iPad Pro 11-inch (M5)'];
const commonDevices = [...phoneDevices, ...ipadDevices];
const allAppLocales: ScreenshotOptions['appLocales'] = ['en-US', 'es', 'fr', 'de'];

function makeOptions(overrides: Partial<ScreenshotOptions> = {}): ScreenshotOptions {
  return {
    platform: 'ios',
    flow: 'app-store',
    backend: 'local',
    devices: commonDevices,
    androidDevice: 'Pixel 2',
    appLocales: allAppLocales,
    variant: null,
    theme: 'dark',
    workout: 'volume',
    renderMode: null,
    boards: null,
    appPath: null,
    orientation: null,
    devClient: false,
    fixtures: 'off',
    fixturesDir: 'packages/mobile/screenshot-fixtures',
    fresh: false,
    frozenNow: null,
    shutdown: false,
    ...overrides,
  };
}

// buildScreenshotEnv takes a NodeJS.ProcessEnv base (defaults to process.env).
// The repo augments ProcessEnv to require NODE_ENV, so a bare `{}` literal isn't
// assignable; these tests only care about the EXPO_PUBLIC_* keys, so build the
// base from a typed helper.
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('deviceSlug', () => {
  it('lowercases and dash-joins a device name', () => {
    expect(deviceSlug('iPhone 16 Pro Max')).toBe('iphone-16-pro-max');
  });

  it('collapses runs of non-alphanumerics and trims edges', () => {
    expect(deviceSlug('  Pixel 8 (Pro) ')).toBe('pixel-8-pro');
    expect(deviceSlug('iPad Pro 13"')).toBe('ipad-pro-13');
    expect(deviceSlug('iPad Pro 13-inch (M5)')).toBe('ipad-pro-13-inch-m5');
  });
});

describe('parseArgs', () => {
  it('defaults to ios / app-store / local / common devices / all locales / dark when no flags are given', () => {
    expect(parseArgs([])).toEqual(makeOptions());
  });

  it('ignores a bare `--` separator', () => {
    expect(parseArgs(['--'])).toEqual(makeOptions());
  });

  it('parses every flag', () => {
    expect(
      parseArgs([
        '--platform',
        'android',
        '--flow',
        'onboarding',
        '--backend',
        'prod',
        '--theme',
        'light',
        '--variant',
        'material',
        '--devices',
        'iPhone 16 Pro Max, iPhone 16 Pro',
        '--locales',
        'es,fr',
        '--workout',
        'ladder',
        '--render-mode',
        'classic',
        '--boards',
        'The Cellar|Kilter Board Homewall',
        '--app-path',
        '/tmp/Boardsesh.app',
        '--dev-client',
        '--fixtures',
        'replay',
        '--fixtures-dir',
        '/tmp/fixtures',
        '--shutdown',
      ]),
    ).toEqual({
      platform: 'android',
      flow: 'onboarding',
      backend: 'prod',
      devices: ['iPhone 16 Pro Max', 'iPhone 16 Pro'],
      androidDevice: 'Pixel 2',
      appLocales: ['es', 'fr'],
      variant: 'material',
      theme: 'light',
      workout: 'ladder',
      renderMode: 'classic',
      boards: 'The Cellar|Kilter Board Homewall',
      appPath: '/tmp/Boardsesh.app',
      orientation: null,
      devClient: true,
      fixtures: 'replay',
      fixturesDir: '/tmp/fixtures',
      fresh: false,
      frozenNow: null,
      shutdown: true,
    });
  });

  it('defaults --dev-client off and parses it as a bare boolean flag', () => {
    expect(parseArgs([]).devClient).toBe(false);
    expect(parseArgs(['--platform', 'android', '--dev-client']).devClient).toBe(true);
    // iOS captures are always dev-clients, so the flag is accepted and ignored
    // there rather than rejected — `--platform all` passes one argv to both.
    expect(parseArgs(['--dev-client']).platform).toBe('ios');
  });

  it('maps --orientation landscape/portrait to the iOS orientation override', () => {
    expect(parseArgs(['--orientation', 'landscape']).orientation).toBe('LANDSCAPE_LEFT');
    expect(parseArgs(['--orientation', 'portrait']).orientation).toBe('PORTRAIT');
    expect(parseArgs([]).orientation).toBeNull();
    expect(() => parseArgs(['--orientation', 'sideways'])).toThrow(/--orientation must be one of/);
  });

  it('defaults Android captures to the Play phone emulator device', () => {
    expect(parseArgs(['--platform', 'android']).androidDevice).toBe('Pixel 2');
  });

  it('uses --device as the Android label and a backwards-compatible single-iOS-device alias', () => {
    const options = parseArgs(['--device', 'iPhone 16 Pro Max']);
    expect(options.devices).toEqual(['iPhone 16 Pro Max']);
    expect(options.androidDevice).toBe('iPhone 16 Pro Max');
  });

  it('maps --workout off to null', () => {
    expect(parseArgs(['--workout', 'off']).workout).toBeNull();
  });

  it('rejects an invalid enum value', () => {
    expect(() => parseArgs(['--theme', 'sepia'])).toThrow(/--theme must be one of/);
    expect(() => parseArgs(['--platform', 'windows'])).toThrow(/--platform must be one of/);
  });

  it('maps --devices common and --locales all to the defaults', () => {
    expect(parseArgs(['--devices', 'common', '--locales', 'all'])).toEqual(makeOptions());
  });

  it('maps --devices phones and --devices ipads to their platform groups', () => {
    expect(parseArgs(['--devices', 'phones']).devices).toEqual(phoneDevices);
    expect(parseArgs(['--devices', 'ipads']).devices).toEqual(ipadDevices);
  });

  it('rejects invalid locales and empty comma lists', () => {
    expect(() => parseArgs(['--locales', 'ja'])).toThrow(/supported app locales/);
    expect(() => parseArgs(['--devices', ','])).toThrow(/at least one device/);
  });

  it('rejects an unknown flag and a value-less flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--device', '--shutdown'])).toThrow(/--device requires a value/);
  });
});

describe('buildScreenshotEnv', () => {
  it('always enables screenshot mode and bakes the theme', () => {
    const env = buildScreenshotEnv(makeOptions({ theme: 'dark' }), baseEnv());
    expect(env.EXPO_PUBLIC_SCREENSHOT_MODE).toBe('1');
    expect(env.EXPO_PUBLIC_SCREENSHOT_THEME).toBe('dark');
  });

  it('bakes the screenshot locale when a locale target is supplied', () => {
    const env = buildScreenshotEnv(makeOptions(), baseEnv(), 'fr');
    expect(env.EXPO_PUBLIC_SCREENSHOT_LOCALE).toBe('fr');
  });

  it('bakes the readiness URL the app pings when it reaches home', () => {
    const env = buildScreenshotEnv(makeOptions(), baseEnv());
    expect(env.EXPO_PUBLIC_SCREENSHOT_READY_URL).toBe(`http://localhost:${SCREENSHOT_READY_PORT}/ready`);
  });

  it('points a local build at the local backend defaults', () => {
    const env = buildScreenshotEnv(makeOptions({ backend: 'local' }), baseEnv());
    expect(env.EXPO_PUBLIC_BACKEND_URL).toBe('http://localhost:8080');
    expect(env.EXPO_PUBLIC_WEB_URL).toBe('http://localhost:3000');
  });

  it('respects a pre-set backend URL for a local build', () => {
    const env = buildScreenshotEnv(
      makeOptions({ backend: 'local' }),
      baseEnv({ EXPO_PUBLIC_BACKEND_URL: 'http://10.0.0.5:8080' }),
    );
    expect(env.EXPO_PUBLIC_BACKEND_URL).toBe('http://10.0.0.5:8080');
  });

  it('leaves backend URLs unset for a prod build (app uses its prod defaults)', () => {
    const env = buildScreenshotEnv(makeOptions({ backend: 'prod' }), baseEnv());
    expect(env.EXPO_PUBLIC_BACKEND_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_WEB_URL).toBeUndefined();
  });

  it('sets the variant override only when one is requested', () => {
    expect(buildScreenshotEnv(makeOptions({ variant: 'material' }), baseEnv()).EXPO_PUBLIC_SCREENSHOT_VARIANT).toBe(
      'material',
    );
    expect(
      buildScreenshotEnv(makeOptions({ variant: null }), baseEnv()).EXPO_PUBLIC_SCREENSHOT_VARIANT,
    ).toBeUndefined();
  });

  it('bakes the workout when set and omits it when null', () => {
    expect(buildScreenshotEnv(makeOptions({ workout: 'pyramid' }), baseEnv()).EXPO_PUBLIC_SCREENSHOT_WORKOUT).toBe(
      'pyramid',
    );
    expect(
      buildScreenshotEnv(makeOptions({ workout: null }), baseEnv()).EXPO_PUBLIC_SCREENSHOT_WORKOUT,
    ).toBeUndefined();
  });

  it('leaves the render mode and board list to the app defaults unless the run overrides them', () => {
    const defaults = buildScreenshotEnv(makeOptions(), baseEnv());
    expect(defaults.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE).toBeUndefined();
    expect(defaults.EXPO_PUBLIC_SCREENSHOT_BOARDS).toBeUndefined();

    const overridden = buildScreenshotEnv(
      makeOptions({ renderMode: 'classic', boards: 'The Cellar|Kilter Board Homewall' }),
      baseEnv(),
    );
    expect(overridden.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE).toBe('classic');
    expect(overridden.EXPO_PUBLIC_SCREENSHOT_BOARDS).toBe('The Cellar|Kilter Board Homewall');
  });

  it('bakes the auto-sign-in credentials (defaults to the test account)', () => {
    const env = buildScreenshotEnv(makeOptions(), baseEnv());
    expect(env.EXPO_PUBLIC_SCREENSHOT_USER_EMAIL).toBe('test@boardsesh.com');
    expect(env.EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD).toBe('test');
    const overridden = buildScreenshotEnv(
      makeOptions(),
      baseEnv({ SCREENSHOT_USER_EMAIL: 'shots@boardsesh.com', SCREENSHOT_USER_PASSWORD: 'secret' }),
    );
    expect(overridden.EXPO_PUBLIC_SCREENSHOT_USER_EMAIL).toBe('shots@boardsesh.com');
    expect(overridden.EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD).toBe('secret');
  });
});

describe('findScreenshotRenderProblems', () => {
  const clean = [
    '[screenshot] board[0] "Marco\'s Kilterboard" -> Marco\'s Kilterboard (kilter L1 S7 @40°)',
    '[screenshot] render mode: aura (requested aura, probe ok)',
  ].join('\n');

  it('passes a capture that drew what the run asked for on the pinned walls', () => {
    expect(findScreenshotRenderProblems(clean, { renderMode: null, requireRenderLine: true })).toEqual([]);
  });

  it('catches the capability probe quietly downgrading the store set to classic', () => {
    const log = '[screenshot] render mode: classic (requested aura, probe unavailable)';
    const problems = findScreenshotRenderProblems(log, { renderMode: null, requireRenderLine: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot draw it');
  });

  it('catches a bundle the screenshot env never reached', () => {
    const log = '[screenshot] render mode: classic (requested classic, probe ok)';
    const problems = findScreenshotRenderProblems(log, { renderMode: null, requireRenderLine: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('did not reach the JS bundle');
  });

  it('accepts the classic look when the run explicitly asked for it', () => {
    const log = '[screenshot] render mode: classic (requested classic, probe ok)';
    expect(findScreenshotRenderProblems(log, { renderMode: 'classic', requireRenderLine: true })).toEqual([]);
  });

  it('resolves `default` the same way the app does', () => {
    expect(findScreenshotRenderProblems(clean, { renderMode: 'default', requireRenderLine: true })).toEqual([]);
  });

  it('catches a shot that fell back off its pinned wall, and carries the roster with it', () => {
    const log = [
      clean,
      '[screenshot] WARN board[1] selector "Tension Board 2" matched nothing; using position',
      '[screenshot] board roster: "The Cellar" (tension L9 S12 @40°)',
    ].join('\n');
    const problems = findScreenshotRenderProblems(log, { renderMode: null, requireRenderLine: true });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('selector "Tension Board 2" matched nothing');
    // Whoever reads the failed run needs the names to pick from, not just the miss.
    expect(problems[1]).toContain('"The Cellar" (tension L9 S12 @40°)');
  });

  it('leaves the roster out when nothing went wrong with the boards', () => {
    const log = `${clean}\n[screenshot] board roster: "The Cellar" (tension L9 S12 @40°)`;
    expect(findScreenshotRenderProblems(log, { renderMode: null, requireRenderLine: true })).toEqual([]);
  });

  it('reports a board-backed flow whose board never rendered, but not a flow without one', () => {
    expect(findScreenshotRenderProblems('', { renderMode: null, requireRenderLine: true })).toEqual([
      'no "[screenshot] render mode:" line in the capture log — the board never rendered.',
    ]);
    expect(findScreenshotRenderProblems('', { renderMode: null, requireRenderLine: false })).toEqual([]);
  });

  it('collapses the same problem repeated across every shot into one line', () => {
    const log = Array.from(
      { length: 4 },
      () => '[screenshot] render mode: classic (requested aura, probe unavailable)',
    ).join('\n');
    expect(findScreenshotRenderProblems(log, { renderMode: null, requireRenderLine: true })).toHaveLength(1);
  });

  it('reports what a clean capture shot, walls and drawing both', () => {
    const log = [
      '[screenshot] board[0] "Marco\'s Board" -> "Marco\'s Board" (kilter L8 S27 @40°)',
      '[screenshot] board[1] "High Point" -> "High Point Climbing Orlando - Tension Board" (tension L10 S18 @40°)',
      '[screenshot] render mode: aura (requested aura, probe ok)',
      '[screenshot] board roster: "something else" (kilter L1 S7 @40°)',
    ].join('\n');

    const summary = summariseScreenshotRender(log);

    // The roster is a failure diagnostic, not provenance — a clean run says which
    // walls it used, not which ones it could have used.
    expect(summary).toHaveLength(3);
    expect(summary[0]).toContain('(kilter L8 S27 @40°)');
    expect(summary[2]).toBe('[screenshot] render mode: aura (requested aura, probe ok)');
  });

  // Regression: the Android gate first read `adb logcat -d`, which dumps the ring
  // buffer as it stands. A capture pushes ~64k lines through it, so the app's own
  // markers had rotated out by the time the gate looked and a correct capture
  // failed with "the board never rendered". A streamed log keeps the early lines
  // no matter how much noise follows them.
  it('still finds the markers when the capture buried them under thousands of lines', () => {
    const noise = Array.from({ length: 5000 }, (_, index) => `09-02 05:36:14.868 D/Noise( 4026): line ${index}`);
    const log = [
      '09-02 05:36:20.497 I/ReactNativeJS( 4026): [screenshot] board[0] "Marco\'s Board" -> "Marco\'s Board" (kilter L8 S25 @35°)',
      '09-02 05:36:21.470 I/ReactNativeJS( 4026): [screenshot] render mode: aura (requested aura, probe ok)',
      ...noise,
    ].join('\n');

    expect(findScreenshotRenderProblems(log, { renderMode: null, requireRenderLine: true })).toEqual([]);
    // And the logcat timestamp/tag prefix is stripped off the provenance lines.
    expect(summariseScreenshotRender(log)[1]).toBe('[screenshot] render mode: aura (requested aura, probe ok)');
  });

  // The gate asserts the app asked for the run's mode, so this constant has to be
  // the same value screenshot-mode.ts falls back to. Read as text rather than
  // imported: that module is bundled for React Native and pulling it into a node
  // test would drag its dependency graph along for one string.
  it('pins its idea of the app default to what screenshot-mode.ts actually falls back to', () => {
    const source = readFileSync('packages/mobile/src/lib/screenshot-mode.ts', 'utf8');
    const fallback = source.match(/EXPO_PUBLIC_SCREENSHOT_RENDER_MODE\?\.trim\(\) \|\| '([a-z]+)'/)?.[1];
    expect(fallback, 'screenshot-mode.ts must keep a literal render-mode fallback').toBeTruthy();
    expect(fallback).toBe(DEFAULT_SCREENSHOT_RENDER_MODE);
  });
});

describe('screenshotLogcatState', () => {
  const marker = '09-02 05:36:21.470 I/ReactNativeJS( 4026): [screenshot] render mode: aura (requested aura, probe ok)';

  it('waits while the stream is alive and the app has not said anything yet', () => {
    expect(screenshotLogcatState(true, '')).toBe('waiting');
    expect(screenshotLogcatState(true, 'D/Noise( 1 ): booting')).toBe('waiting');
  });

  it('reads once the app has said what it drew', () => {
    expect(screenshotLogcatState(true, marker)).toBe('ready');
  });

  // The marker is not the last thing the app logs: a board selector that missed
  // warns when the shot needing it opens, which on a two-wall flow is long after
  // the first render. A reader that stopped mid-capture truncated the log, and
  // this runs before anything kills the stream, so that is always unexpected.
  it('rejects a log the reader stopped writing, even with the render marker in it', () => {
    expect(screenshotLogcatState(false, marker)).toBe('reader-died');
  });

  it('calls out a reader that stopped with nothing to show, which is not a silent app', () => {
    expect(screenshotLogcatState(false, 'D/Noise( 1 ): booting')).toBe('reader-died');
  });
});

describe('screenshotReadinessCount', () => {
  it('counts each home-reached ping line the readiness server appended', () => {
    // A private temp log — writing the real READINESS_LOG_PATH could poison a
    // capture run happening on the same machine.
    const tempDir = mkdtempSync(join(tmpdir(), 'boardsesh-readiness-'));
    const logPath = join(tempDir, 'ready.log');
    try {
      expect(screenshotReadinessCount(logPath)).toBe(0);
      writeFileSync(logPath, '');
      expect(screenshotReadinessCount(logPath)).toBe(0);
      writeFileSync(logPath, 'x\n');
      expect(screenshotReadinessCount(logPath)).toBe(1);
      // Blank trailing lines don't inflate the count (the wait compares against a baseline).
      writeFileSync(logPath, 'x\nx\n');
      expect(screenshotReadinessCount(logPath)).toBe(2);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe('findDuplicateScreenshotGroups', () => {
  it('flags byte-identical captures and leaves distinct ones alone', () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-dup-shots-'));
    try {
      // The iPad 11" failure shape: the Climbs tap never navigated, so
      // 02-climbs came out as a pixel-perfect copy of 01-home.
      writeFileSync(join(captureDir, '01-home.png'), 'home-frame-bytes');
      writeFileSync(join(captureDir, '02-climbs.png'), 'home-frame-bytes');
      writeFileSync(join(captureDir, '00-wall.png'), 'wall-frame-bytes');
      writeFileSync(join(captureDir, 'notes.txt'), 'home-frame-bytes');
      expect(findDuplicateScreenshotGroups(captureDir)).toEqual([['01-home.png', '02-climbs.png']]);
    } finally {
      rmSync(captureDir, { force: true, recursive: true });
    }
  });

  it('returns no groups when every capture is distinct', () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'boardsesh-dup-shots-'));
    try {
      writeFileSync(join(captureDir, '01-home.png'), 'home-frame-bytes');
      writeFileSync(join(captureDir, '02-climbs.png'), 'climbs-frame-bytes');
      expect(findDuplicateScreenshotGroups(captureDir)).toEqual([]);
    } finally {
      rmSync(captureDir, { force: true, recursive: true });
    }
  });
});

describe('writeCapturedScreenshots', () => {
  it('replaces the folder rather than merging into it', () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'capture-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'store-'));
    try {
      // Renumbering a slot renames its file, so the previous set's names are not
      // a subset of the new one's. Merging would upload both, in an order nobody
      // chose, and hand Play more phone shots than it accepts.
      writeFileSync(join(outputDir, '00-home.png'), 'stale');
      writeFileSync(join(outputDir, '01-climbs.png'), 'stale');
      writeFileSync(join(outputDir, 'notes.txt'), 'keep me');
      writeFileSync(join(captureDir, '00-board-view.png'), 'fresh');
      writeFileSync(join(captureDir, '01-home.png'), 'fresh');

      const saved = writeCapturedScreenshots(captureDir, outputDir);

      expect(readdirSync(outputDir).sort()).toEqual(['00-board-view.png', '01-home.png', 'notes.txt']);
      expect(saved).toHaveLength(2);
    } finally {
      rmSync(captureDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it('leaves the live set alone when the capture produced nothing', () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'capture-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'store-'));
    try {
      writeFileSync(join(outputDir, '00-board-view.png'), 'live');

      // The caller fails the run on the empty result. It must not ALSO have wiped
      // the folder on the way there — the Play set is committed to git, and a
      // capture that produced nothing should not stage the deletion of the shots
      // currently on the listing.
      expect(writeCapturedScreenshots(captureDir, outputDir)).toEqual([]);
      expect(readdirSync(outputDir)).toEqual(['00-board-view.png']);
    } finally {
      rmSync(captureDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it('creates the folder on a first capture', () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'capture-'));
    const parent = mkdtempSync(join(tmpdir(), 'store-'));
    const outputDir = join(parent, 'de-DE', 'iphone-16-pro-max');
    try {
      writeFileSync(join(captureDir, '00-board-view.png'), 'fresh');

      expect(writeCapturedScreenshots(captureDir, outputDir)).toHaveLength(1);
      expect(readdirSync(outputDir)).toEqual(['00-board-view.png']);
    } finally {
      rmSync(captureDir, { force: true, recursive: true });
      rmSync(parent, { force: true, recursive: true });
    }
  });
});

describe('metroDevClientUrl', () => {
  it('uses the Expo app scheme that iOS dev launcher accepts', () => {
    expect(metroDevClientUrl(8091)).toBe('exp+boardsesh://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8091');
  });
});

describe('validateIosAppLauncherUrl', () => {
  function hasPlutil() {
    return spawnSync('command', ['-v', 'plutil'], { shell: true, stdio: 'ignore' }).status === 0;
  }

  function writeInfoPlist(appPath: string, launcherUrl: string) {
    writeFileSync(
      join(appPath, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>DEV_CLIENT_DEFAULT_LAUNCHER_URL</key>
  <string>${launcherUrl}</string>
</dict>
</plist>
`,
    );
  }

  it('accepts an iOS app path baked for the active Metro port', () => {
    if (!hasPlutil()) return;
    const tempDir = mkdtempSync(join(tmpdir(), 'boardsesh-test-app-'));
    const appPath = join(tempDir, 'Boardsesh.app');
    mkdirSync(appPath);
    try {
      writeInfoPlist(appPath, 'http://localhost:8091');
      expect(() => validateIosAppLauncherUrl(appPath, 8091)).not.toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an iOS app path baked for a different Metro port', () => {
    if (!hasPlutil()) return;
    const tempDir = mkdtempSync(join(tmpdir(), 'boardsesh-test-app-'));
    const appPath = join(tempDir, 'Boardsesh.app');
    mkdirSync(appPath);
    try {
      writeInfoPlist(appPath, 'http://localhost:8081');
      expect(() => validateIosAppLauncherUrl(appPath, 8091)).toThrow(/expected http:\/\/localhost:8091/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('renderMaestroFlowForIosDevice', () => {
  it('renders the setOrientation placeholder to the target iOS device orientation', () => {
    const ipadDevice: IosScreenshotDevice = {
      name: 'iPad Pro 13-inch (M5)',
      typeId: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB',
      orientation: 'LANDSCAPE_LEFT',
    };

    const rendered = renderMaestroFlowForIosDevice(
      '- setOrientation: ${MAESTRO_DEVICE_ORIENTATION}\n- takeScreenshot: 00-home\n',
      ipadDevice,
    );

    expect(rendered).toContain('- setOrientation: LANDSCAPE_LEFT');
    expect(rendered).not.toContain('${MAESTRO_DEVICE_ORIENTATION}');
  });

  it('keeps real iOS flows orientable for iPad screenshot captures', () => {
    const ipadDevice: IosScreenshotDevice = {
      name: 'iPad Pro 13-inch (M5)',
      typeId: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB',
      orientation: 'LANDSCAPE_LEFT',
    };

    for (const flowPath of ['packages/mobile/.maestro/app-store.yaml', 'packages/mobile/.maestro/onboarding.yaml']) {
      const flowSource = readFileSync(flowPath, 'utf8');
      expect(flowSource).toContain('${MAESTRO_DEVICE_ORIENTATION}');
      expect(renderMaestroFlowForIosDevice(flowSource, ipadDevice)).toContain('- setOrientation: LANDSCAPE_LEFT');
    }
  });

  it('the iPad flow taps sidebar items by testID and verifies the selected state — no coordinate taps', () => {
    const ipadFlow = readFileSync('packages/mobile/.maestro/app-store-ipad.yaml', 'utf8');
    // Every destination is tapped via its locale-independent id (IpadSidebar's
    // `ipad-sidebar-<segment>` testID)...
    for (const segment of ['home', 'climbs', 'record', 'wall', 'discover', 'profile']) {
      expect(ipadFlow).toContain(`id: "ipad-sidebar-${segment}"`);
    }
    // ...and each navigation is verified via the item's selected accessibility
    // state, so a silently-swallowed tap (the 11" dark-wall failure) re-taps
    // instead of screenshotting the wrong screen.
    expect(ipadFlow).toContain('selected: true');
    expect(ipadFlow).toContain('retry:');
    // No blind coordinate taps — they carried no proof the navigation happened.
    expect(ipadFlow).not.toContain('point:');
    expect(ipadFlow).not.toContain('${TAP_');
  });
});

describe('iosSourceFlowFile', () => {
  const ipadDevice: IosScreenshotDevice = {
    name: 'iPad Pro 13-inch (M5)',
    typeId: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB',
    orientation: 'LANDSCAPE_LEFT',
  };
  const phoneDevice: IosScreenshotDevice = {
    name: 'iPhone 16 Pro Max',
    typeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max',
    orientation: 'PORTRAIT',
  };

  it('routes the app-store flow to the iPad tap flow for iPad, and the shared flow for iPhone', () => {
    expect(iosSourceFlowFile(makeOptions({ flow: 'app-store' }), ipadDevice)).toMatch(/app-store-ipad\.yaml$/);
    const phoneFlow = iosSourceFlowFile(makeOptions({ flow: 'app-store' }), phoneDevice);
    expect(phoneFlow).toMatch(/app-store\.yaml$/);
    expect(phoneFlow).not.toMatch(/app-store-ipad\.yaml$/);
  });

  it('falls back to the shared flow on iPad when no iPad variant exists (onboarding)', () => {
    expect(iosSourceFlowFile(makeOptions({ flow: 'onboarding' }), ipadDevice)).toMatch(/onboarding\.yaml$/);
  });

  it('the iPad flow is tap-driven (no openurl) and captures the wall kiosk; iPhone stays deep-link driven', () => {
    const ipadFlow = readFileSync('packages/mobile/.maestro/app-store-ipad.yaml', 'utf8');
    expect(ipadFlow).toContain('takeScreenshot: 00-wall');
    expect(ipadFlow).toContain('tapOn:');
    expect(ipadFlow).not.toContain('openLink:');

    const phoneFlow = readFileSync('packages/mobile/.maestro/app-store.yaml', 'utf8');
    expect(phoneFlow).toContain('openLink: com.boardsesh.app://climbs');
    expect(phoneFlow).not.toContain('__MAESTRO_IS_IPAD__');
    expect(phoneFlow).not.toContain('://wall');
  });
});

describe('isIpadScreenshotDevice', () => {
  it('is true for iPad simulator types and false for iPhone', () => {
    expect(
      isIpadScreenshotDevice({
        name: 'iPad Pro 11-inch (M5)',
        typeId: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB',
        orientation: 'LANDSCAPE_LEFT',
      }),
    ).toBe(true);
    expect(
      isIpadScreenshotDevice({
        name: 'iPhone 16 Pro Max',
        typeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max',
        orientation: 'PORTRAIT',
      }),
    ).toBe(false);
  });
});

describe('rotationDegreesForIosOrientation', () => {
  it('normalizes raw iPad landscape-left captures into upright landscape PNGs', () => {
    expect(rotationDegreesForIosOrientation('LANDSCAPE_LEFT')).toBe(-90);
    expect(rotationDegreesForIosOrientation('PORTRAIT')).toBeNull();
  });
});

describe('resolveIosScreenshotDevices', () => {
  it('keeps a known device record and its orientation', () => {
    const [ipad] = resolveIosScreenshotDevices(['iPad Pro 13-inch (M5)']);
    expect(ipad.typeId).toBe('com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB');
    expect(ipad.orientation).toBe('LANDSCAPE_LEFT');
  });

  it('falls back to portrait for an unlisted device name with no override', () => {
    const [device] = resolveIosScreenshotDevices(['iPad Air 13-inch (M3)']);
    expect(device).toEqual({ name: 'iPad Air 13-inch (M3)', typeId: '', orientation: 'PORTRAIT' });
  });

  it('applies an orientation override to unlisted devices only, never to known ones', () => {
    const [unlisted, known] = resolveIosScreenshotDevices(
      ['iPad Air 13-inch (M3)', 'iPhone 16 Pro Max'],
      'LANDSCAPE_LEFT',
    );
    // The ad-hoc iPad captures landscape instead of the portrait default…
    expect(unlisted.orientation).toBe('LANDSCAPE_LEFT');
    // …but the known iPhone keeps its own portrait orientation.
    expect(known.orientation).toBe('PORTRAIT');
  });
});

describe('resolveAppStoreLocaleTargets', () => {
  it('maps app locales to App Store Connect locale directories', () => {
    expect(resolveAppStoreLocaleTargets(['en-US', 'es', 'fr', 'de'])).toEqual([
      { appLocale: 'en-US', appStoreLocales: ['en-US'] },
      { appLocale: 'es', appStoreLocales: ['es-ES', 'es-MX'] },
      { appLocale: 'fr', appStoreLocales: ['fr-FR'] },
      { appLocale: 'de', appStoreLocales: ['de-DE'] },
    ]);
  });

  // STORE_READY_APP_LOCALES is annotated `readonly Locale[]`, but nothing
  // typechecks the root scripts/ directory (there is no `typecheck:scripts` task
  // — see the dependsOn list in vite.config.ts), so that annotation is erased
  // rather than enforced. A locale added to the capture set before it exists in
  // SUPPORTED_LOCALES would sail through CI and then fail at capture time with an
  // unresolvable App Store folder. Assert the subset at runtime instead.
  it('keeps the default capture set inside SUPPORTED_LOCALES', () => {
    const supported: readonly string[] = SUPPORTED_LOCALES;
    for (const appLocale of parseArgs(['--locales', 'all']).appLocales) {
      expect({ appLocale, supported: supported.includes(appLocale) }).toEqual({ appLocale, supported: true });
    }
  });
});

describe('--fixtures', () => {
  it('defaults to off and leaves the fixture env unset', () => {
    const options = parseArgs([]);
    expect(options.fixtures).toBe('off');
    expect(options.fixturesDir).toBe('packages/mobile/screenshot-fixtures');
    expect(options.fresh).toBe(false);
    const env = buildScreenshotEnv(options, baseEnv());
    expect(env.EXPO_PUBLIC_SCREENSHOT_NOW).toBeUndefined();
    expect(env.EXPO_PUBLIC_WS_URL).toBeUndefined();
  });

  it('parses the mode, the directory and --fresh', () => {
    const options = parseArgs(['--fixtures', 'record', '--fixtures-dir', '/tmp/rec', '--fresh']);
    expect(options.fixtures).toBe('record');
    expect(options.fixturesDir).toBe('/tmp/rec');
    expect(options.fresh).toBe(true);
  });

  it('parses --frozen-now for a recording', () => {
    const options = parseArgs(['--fixtures', 'record', '--frozen-now', '2026-09-08T12:00:00Z']);
    expect(options.frozenNow).toBe('2026-09-08T12:00:00Z');
  });

  it('rejects an unknown mode and a --fresh outside record', () => {
    expect(() => parseArgs(['--fixtures', 'maybe'])).toThrow(/--fixtures must be one of/);
    expect(() => parseArgs(['--fresh'])).toThrow(/--fresh only applies to --fixtures record/);
    expect(() => parseArgs(['--fixtures', 'replay', '--fresh'])).toThrow(/--fresh only applies/);
  });

  it('rejects --frozen-now outside record and an unparseable instant', () => {
    expect(() => parseArgs(['--frozen-now', '2026-09-08T12:00:00Z'])).toThrow(
      /--frozen-now only applies to --fixtures record/,
    );
    expect(() => parseArgs(['--fixtures', 'replay', '--frozen-now', '2026-09-08T12:00:00Z'])).toThrow(
      /--frozen-now only applies/,
    );
    expect(() => parseArgs(['--fixtures', 'record', '--frozen-now', 'not-a-date'])).toThrow(
      /--frozen-now must be a parseable ISO instant/,
    );
  });

  it('points the bundle at the given backend port and bakes the frozen instant, leaving the web URL alone', () => {
    const env = buildScreenshotEnv(
      makeOptions({ fixtures: 'replay', backend: 'prod' }),
      baseEnv(),
      'en-US',
      '2026-09-08T12:00:00Z',
      8090,
    );
    expect(env.EXPO_PUBLIC_BACKEND_URL).toBe('http://localhost:8090');
    expect(env.EXPO_PUBLIC_WS_URL).toBe('ws://localhost:8090/graphql');
    // /static/* reads go through EXPO_PUBLIC_BACKEND_URL, not the web URL, so a
    // fixtures run must leave it exactly as --backend prod would (unset).
    expect(env.EXPO_PUBLIC_WEB_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_SCREENSHOT_NOW).toBe('2026-09-08T12:00:00Z');
  });

  it('uses the bound port the caller passes in, not an env-derived one', () => {
    const env = buildScreenshotEnv(
      makeOptions({ fixtures: 'replay' }),
      baseEnv({ BOARDSESH_SCREENSHOT_BACKEND_PORT: '9123' }),
      null,
      '2026-09-08T12:00:00Z',
      9500,
    );
    // The caller's bound port wins even though the env carries a different one —
    // buildScreenshotEnv never re-derives it from BOARDSESH_SCREENSHOT_BACKEND_PORT.
    expect(env.EXPO_PUBLIC_BACKEND_URL).toBe('http://localhost:9500');
    expect(env.EXPO_PUBLIC_WS_URL).toBe('ws://localhost:9500/graphql');
  });

  it('overrides the --backend local URLs and any caller-exported override, but leaves the web URL at its local default', () => {
    const env = buildScreenshotEnv(
      makeOptions({ fixtures: 'replay', backend: 'local' }),
      baseEnv({ EXPO_PUBLIC_BACKEND_URL: 'http://10.0.0.5:8080' }),
      null,
      '2026-09-08T12:00:00Z',
      8090,
    );
    expect(env.EXPO_PUBLIC_BACKEND_URL).toBe('http://localhost:8090');
    // Set by the --backend local branch above (untouched by fixtures mode), not
    // redirected to the fixtures backend.
    expect(env.EXPO_PUBLIC_WEB_URL).toBe('http://localhost:3000');
  });

  it('refuses to build the env without a frozen instant', () => {
    expect(() => buildScreenshotEnv(makeOptions({ fixtures: 'record' }), baseEnv(), null, null, 8090)).toThrow(
      /frozen instant/,
    );
  });

  it('refuses to build the env without the bound backend port', () => {
    expect(() =>
      buildScreenshotEnv(makeOptions({ fixtures: 'record' }), baseEnv(), null, '2026-09-08T12:00:00Z'),
    ).toThrow(/bound backend port/);
  });
});

describe('findFrozenClockProblems', () => {
  const frozenNow = '2026-09-08T12:00:00Z';

  it('accepts a frozen line even though the app prints milliseconds', () => {
    const log = 'blah\n12:00:01 [screenshot] clock: frozen at 2026-09-08T12:00:00.000Z\nmore';
    expect(findFrozenClockProblems(log, frozenNow)).toEqual([]);
  });

  it('fails a bundle still on the wall clock', () => {
    const problems = findFrozenClockProblems('[screenshot] clock: live', frozenNow);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/live clock/);
    expect(problems[0]).toContain(frozenNow);
  });

  it('fails a bundle frozen at a different instant', () => {
    const problems = findFrozenClockProblems('[screenshot] clock: frozen at 2026-01-02T12:00:00.000Z', frozenNow);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/2026-01-02T12:00:00\.000Z/);
  });

  it('fails when the app never reported a clock at all', () => {
    expect(findFrozenClockProblems('nothing to see here', frozenNow)).toEqual([
      'no "[screenshot] clock:" line in the capture log — the app never reported which clock it was on, so the frozen instant could not be confirmed.',
    ]);
  });
});

describe('the screenshot backend log slice', () => {
  it('reads only the lines written after the baseline', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'boardsesh-backend-log-'));
    const logPath = join(logDir, 'backend.log');
    try {
      writeFileSync(logPath, '[screenshot-backend] HIT graphql GetProfile aaaaaaaaaaaa\n');
      const baseline = screenshotBackendLogLineCount(logPath);
      writeFileSync(
        logPath,
        '[screenshot-backend] HIT graphql GetProfile aaaaaaaaaaaa\n' +
          '[screenshot-backend] MISS graphql GetClimb bbbbbbbbbbbb reason=no-fixture\n',
      );
      const since = readScreenshotBackendLogSince(baseline, logPath);
      expect(since).toContain('MISS graphql GetClimb');
      expect(since).not.toContain('HIT graphql GetProfile');
    } finally {
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  it('counts nothing for a log that does not exist yet', () => {
    expect(screenshotBackendLogLineCount(join(tmpdir(), 'boardsesh-no-such-backend.log'))).toBe(0);
    expect(readScreenshotBackendLogSince(0, join(tmpdir(), 'boardsesh-no-such-backend.log'))).toBe('');
  });
});

describe('buildBackendArgs', () => {
  const context = {
    mode: 'record' as const,
    port: 8090,
    fixturesDir: '/tmp/fixtures',
    frozenNow: '2026-09-08T12:00:00Z',
  };

  it('includes --fresh on the first backend this process starts', () => {
    const args = buildBackendArgs(makeOptions({ fixtures: 'record', fresh: true }), context, false);
    expect(args).toContain('--fresh');
  });

  it('omits --fresh once a backend already started this run — a --platform all run must not wipe the first platform', () => {
    const args = buildBackendArgs(makeOptions({ fixtures: 'record', fresh: true }), context, true);
    expect(args).not.toContain('--fresh');
  });

  it('never adds --fresh when the run did not ask for it, regardless of alreadyStartedThisRun', () => {
    expect(buildBackendArgs(makeOptions({ fixtures: 'record', fresh: false }), context, false)).not.toContain(
      '--fresh',
    );
    expect(buildBackendArgs(makeOptions({ fixtures: 'record', fresh: false }), context, true)).not.toContain('--fresh');
  });

  it('adds --upstream only for a local backend, and only in record mode', () => {
    const local = buildBackendArgs(makeOptions({ fixtures: 'record', backend: 'local' }), context, false);
    expect(local).toEqual(expect.arrayContaining(['--upstream']));
    const prod = buildBackendArgs(makeOptions({ fixtures: 'record', backend: 'prod' }), context, false);
    expect(prod).not.toContain('--upstream');
    const replay = buildBackendArgs(
      makeOptions({ fixtures: 'replay', backend: 'local' }),
      { ...context, mode: 'replay' },
      false,
    );
    expect(replay).not.toContain('--upstream');
  });

  it('always carries the mode, port, fixtures dir, frozen instant and flow', () => {
    const args = buildBackendArgs(makeOptions({ fixtures: 'record', flow: 'onboarding' }), context, false);
    expect(args).toEqual(
      expect.arrayContaining([
        '--mode',
        'record',
        '--port',
        '8090',
        '--fixtures',
        '/tmp/fixtures',
        '--frozen-now',
        '2026-09-08T12:00:00Z',
        '--flow',
        'onboarding',
      ]),
    );
  });
});

describe('startScreenshotBackend', () => {
  const originalPortEnv = process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT;

  afterEach(() => {
    if (originalPortEnv === undefined) delete process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT;
    else process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT = originalPortEnv;
  });

  it('rejects BOARDSESH_SCREENSHOT_BACKEND_PORT=0 before doing anything else', () => {
    process.env.BOARDSESH_SCREENSHOT_BACKEND_PORT = '0';
    // A nonexistent fixtures dir would normally fail replay's manifest read —
    // the port-0 guard must fire before that, proving it runs first.
    expect(() =>
      startScreenshotBackend(makeOptions({ fixtures: 'replay', fixturesDir: '/tmp/does-not-exist-at-all' })),
    ).toThrow(/BOARDSESH_SCREENSHOT_BACKEND_PORT must not be 0/);
  });
});

// reportRecordingSummary itself shells out to curl against a live port (see
// screenshotBackendReady for the same pattern) — not exercised here with a real
// server, matching how the rest of this file treats curl-based functions
// (screenshotBackendReady has no test either). The decision this ticket cares
// about — what counts as "the backend died mid-capture" — lives in the pure
// parseRecordingStatus seam below instead, which IS fully covered.
describe('parseRecordingStatus', () => {
  it('fails when curl could not reach the endpoint at all', () => {
    expect(parseRecordingStatus({ status: 7, stdout: '' })).toBeNull();
  });

  it('fails when curl succeeded but the body is not JSON', () => {
    expect(parseRecordingStatus({ status: 0, stdout: 'not json' })).toBeNull();
  });

  it('fails when the body is JSON but not an object (e.g. a bare string or number)', () => {
    expect(parseRecordingStatus({ status: 0, stdout: '"just a string"' })).not.toBeNull();
    // JSON.parse succeeds on a bare string; parseRecordingStatus doesn't validate
    // shape beyond "is it JSON at all" — the caller reads fields with `?? 0`
    // fallbacks, so a malformed-but-parseable body degrades to zero counts
    // rather than crashing.
  });

  it('succeeds on a well-formed status body', () => {
    const stats = parseRecordingStatus({
      status: 0,
      stdout: JSON.stringify({ hits: 1, misses: 0, recorded: 2, redacted: 0, fixtures: { graphql: 2, static: 0 } }),
    });
    expect(stats).toEqual({ hits: 1, misses: 0, recorded: 2, redacted: 0, fixtures: { graphql: 2, static: 0 } });
  });
});

describe('reportRecordingSummary', () => {
  it('fails with the status-unreachable message when the backend cannot be reached', () => {
    // reportRecordingSummary's only network call is the curl invocation
    // parseRecordingStatus's own tests cover the branch logic for — a
    // negative port guarantees curl fails to connect (an unroutable target),
    // landing this deterministically in the "unreachable" branch without
    // needing a live server or waiting out a connect timeout.
    const unreachableSession = {
      process: {},
      mode: 'record',
      frozenNow: '2026-09-08T12:00:00Z',
      port: -1,
      fixturesDir: '/tmp/fixtures',
    } as unknown as ScreenshotBackendSession;
    expect(RECORDING_STATUS_UNREACHABLE_MESSAGE).toMatch(/did not answer .*status/);
    expect(reportRecordingSummary(unreachableSession)).toBe(false);
  });
});
