import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildScreenshotEnv,
  deviceSlug,
  metroDevClientUrl,
  parseArgs,
  renderMaestroFlowForIosDevice,
  resolveAppStoreLocaleTargets,
  resolveIosScreenshotDevices,
  rotationDegreesForIosOrientation,
  validateIosAppLauncherUrl,
  type IosScreenshotDevice,
  type ScreenshotOptions,
} from '../mobile-screenshots';

const phoneDevices = ['iPhone 16 Pro Max'];
const ipadDevices = ['iPad Pro 13-inch (M5)', 'iPad Pro 11-inch (M5)'];
const commonDevices = [...phoneDevices, ...ipadDevices];
const allAppLocales: ScreenshotOptions['appLocales'] = ['en-US', 'es', 'fr'];

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
    expect(() => parseArgs(['--locales', 'de'])).toThrow(/supported app locales/);
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
    expect(resolveAppStoreLocaleTargets(['en-US', 'es', 'fr'])).toEqual([
      { appLocale: 'en-US', appStoreLocales: ['en-US'] },
      { appLocale: 'es', appStoreLocales: ['es-ES', 'es-MX'] },
      { appLocale: 'fr', appStoreLocales: ['fr-FR'] },
    ]);
  });
});
