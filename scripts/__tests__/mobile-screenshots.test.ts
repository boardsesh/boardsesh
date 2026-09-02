import { describe, expect, it } from 'vitest';
// Relative, not '@boardsesh/i18n': the scripts vitest project doesn't resolve
// workspace package names (same as mobile-locales-parity.test.ts).
import { SUPPORTED_LOCALES } from '../../packages/shared/i18n/src/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildScreenshotEnv,
  deviceSlug,
  DEFAULT_SCREENSHOT_RENDER_MODE,
  findDuplicateScreenshotGroups,
  findScreenshotRenderProblems,
  iosSourceFlowFile,
  summariseScreenshotRender,
  isIpadScreenshotDevice,
  metroDevClientUrl,
  parseArgs,
  renderMaestroFlowForIosDevice,
  resolveAppStoreLocaleTargets,
  resolveIosScreenshotDevices,
  rotationDegreesForIosOrientation,
  SCREENSHOT_READY_PORT,
  screenshotReadinessCount,
  validateIosAppLauncherUrl,
  type IosScreenshotDevice,
  type ScreenshotOptions,
} from '../mobile-screenshots';

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
      shutdown: true,
    });
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
