import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// detectDeviceLocale (reached via resolveLanguage and i18n init at import) reads
// the device locales through expo-localization. Pin it to a French device so the
// 'system' case has a deterministic, non-default result to assert against.
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'fr-FR', languageCode: 'fr' }],
}));

// locale-preference pulls in the secure-store adapter transitively; stub the
// native module so importing it doesn't touch a real keychain.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import { isLocaleOverride, resolveLanguage } from '../locale-preference';

describe('isLocaleOverride', () => {
  it('accepts "system" and every supported locale', () => {
    expect(isLocaleOverride('system')).toBe(true);
    expect(isLocaleOverride('en-US')).toBe(true);
    expect(isLocaleOverride('es')).toBe(true);
    expect(isLocaleOverride('fr')).toBe(true);
  });

  it('rejects unknown locales and non-string junk', () => {
    expect(isLocaleOverride('de')).toBe(false);
    expect(isLocaleOverride('')).toBe(false);
    expect(isLocaleOverride(null)).toBe(false);
    expect(isLocaleOverride(undefined)).toBe(false);
    expect(isLocaleOverride(42)).toBe(false);
  });
});

describe('resolveLanguage', () => {
  it('resolves "system" to the detected device locale', () => {
    expect(resolveLanguage('system')).toBe('fr');
  });

  it('passes an explicit locale through unchanged', () => {
    expect(resolveLanguage('es')).toBe('es');
    expect(resolveLanguage('en-US')).toBe('en-US');
  });
});

// The SCREENSHOT_LOCALE_OVERRIDE guard is a module-level const baked from env at
// import, so re-import the module under a stubbed env to exercise both branches.
describe('screenshot locale override', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolveLanguage returns the baked screenshot locale, ignoring the override arg', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_LOCALE', 'es');

    const { resolveLanguage: resolveUnderScreenshotMode } = await import('../locale-preference');

    expect(resolveUnderScreenshotMode('system')).toBe('es');
    expect(resolveUnderScreenshotMode('fr')).toBe('es');
  });

  it('getStoredLocaleOverride returns the baked screenshot locale without reading SecureStore', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_LOCALE', 'es');

    const secureStore = await import('expo-secure-store');
    const { getStoredLocaleOverride } = await import('../locale-preference');

    expect(await getStoredLocaleOverride()).toBe('es');
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
  });

  it('getStoredLocaleOverride falls back to "system" outside screenshot mode', async () => {
    const { getStoredLocaleOverride } = await import('../locale-preference');

    // The expo-secure-store mock returns null, so an absent override is "system".
    expect(await getStoredLocaleOverride()).toBe('system');
  });
});
