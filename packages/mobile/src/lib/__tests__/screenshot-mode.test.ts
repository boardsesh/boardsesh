import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Regression guard for the cold-start crash where a merge between two PRs left a
// bare `SCREENSHOT_MODE` reference in this module after the binding was deleted.
// `screenshot-mode.ts` is imported by the auth + theme providers at the top of
// the startup tree, so a top-level ReferenceError here aborts the app on launch
// (expo-updates ErrorRecovery then crashes the process). These tests import the
// module fresh under different env so any top-level throw fails loudly here
// instead of only on a device.

const SCREENSHOT_ENV_KEYS = [
  'EXPO_PUBLIC_SCREENSHOT_MODE',
  'EXPO_PUBLIC_SCREENSHOT_LOCALE',
  'EXPO_PUBLIC_SCREENSHOT_THEME',
  'EXPO_PUBLIC_SCREENSHOT_VARIANT',
  'EXPO_PUBLIC_SCREENSHOT_WORKOUT',
  'EXPO_PUBLIC_SCREENSHOT_USER_EMAIL',
  'EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD',
] as const;

describe('screenshot-mode', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of SCREENSHOT_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SCREENSHOT_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('evaluates without throwing in a normal build (no screenshot env)', async () => {
    const screenshotMode = await import('../screenshot-mode');
    // The locale override line is exactly where the bare-`SCREENSHOT_MODE` bug
    // lived. In a normal build the guard is false, so there is no override.
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBeNull();
    expect(screenshotMode.SCREENSHOT_THEME_OVERRIDE).toBe('dark');
    expect(screenshotMode.SCREENSHOT_VARIANT_PREFERENCE).toBe('auto');
    expect(screenshotMode.SCREENSHOT_WORKOUT).toBeNull();
    expect(screenshotMode.SCREENSHOT_USER_EMAIL).toBe('');
    expect(screenshotMode.SCREENSHOT_USER_PASSWORD).toBe('');
  });

  it('keeps the locale override null when screenshot mode is off, even with a locale set', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE = 'fr';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBeNull();
  });

  it('applies a supported locale override only when screenshot mode is on', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE = 'fr';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBe('fr');
  });

  it('ignores an unsupported locale even in screenshot mode', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE = 'zz-not-a-locale';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBeNull();
  });
});
