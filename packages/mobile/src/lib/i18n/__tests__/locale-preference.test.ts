import { describe, it, expect, vi } from 'vitest';

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
