import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'fr-FR', languageCode: 'fr' }],
}));

describe('screenshot locale override', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the bundled screenshot locale in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_LOCALE', 'es');

    const { detectDeviceLocale } = await import('../config');

    expect(detectDeviceLocale()).toBe('es');
  });

  it('falls back to device locale when screenshot locale is absent', async () => {
    const { detectDeviceLocale } = await import('../config');

    expect(detectDeviceLocale()).toBe('fr');
  });
});
