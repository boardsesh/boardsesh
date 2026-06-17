import { describe, expect, it } from 'vitest';

import { buildScreenshotEnv, deviceSlug, parseArgs, type ScreenshotOptions } from '../mobile-screenshots';

function makeOptions(overrides: Partial<ScreenshotOptions> = {}): ScreenshotOptions {
  return {
    platform: 'ios',
    flow: 'app-store',
    backend: 'local',
    device: 'iPhone 16 Pro Max',
    variant: null,
    theme: 'dark',
    workout: 'volume',
    appPath: null,
    shutdown: false,
    party: false,
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
  it('defaults to ios / app-store / local / dark when no flags are given', () => {
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
        '--device',
        'Pixel 8',
        '--workout',
        'ladder',
        '--app-path',
        '/tmp/Boardsesh.app',
        '--shutdown',
        '--party',
      ]),
    ).toEqual({
      platform: 'android',
      flow: 'onboarding',
      backend: 'prod',
      device: 'Pixel 8',
      variant: 'material',
      theme: 'light',
      workout: 'ladder',
      appPath: '/tmp/Boardsesh.app',
      shutdown: true,
      party: true,
    });
  });

  it('defaults Android captures to the Play phone emulator device', () => {
    expect(parseArgs(['--platform', 'android']).device).toBe('Pixel 2');
  });

  it('maps --workout off to null', () => {
    expect(parseArgs(['--workout', 'off']).workout).toBeNull();
  });

  it('rejects an invalid enum value', () => {
    expect(() => parseArgs(['--theme', 'sepia'])).toThrow(/--theme must be one of/);
    expect(() => parseArgs(['--platform', 'windows'])).toThrow(/--platform must be one of/);
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
