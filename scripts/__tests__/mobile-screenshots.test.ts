import { describe, expect, it } from 'vitest';

import {
  buildScreenshotEnv,
  deviceSlug,
  parseArgs,
  resolveAppStoreLocaleTargets,
  type ScreenshotOptions,
} from '../mobile-screenshots';

const commonDevices = ['iPhone 16 Pro Max'];
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
      shutdown: true,
    });
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

describe('resolveAppStoreLocaleTargets', () => {
  it('maps app locales to App Store Connect locale directories', () => {
    expect(resolveAppStoreLocaleTargets(['en-US', 'es', 'fr'])).toEqual([
      { appLocale: 'en-US', appStoreLocales: ['en-US'] },
      { appLocale: 'es', appStoreLocales: ['es-ES', 'es-MX'] },
      { appLocale: 'fr', appStoreLocales: ['fr-FR'] },
    ]);
  });
});
