import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'fr-FR', languageCode: 'fr' }],
}));

/**
 * Both tests import the i18n config through `vi.resetModules()`, so each one pays
 * for the WHOLE catalogue graph — every namespace in every one of the four
 * locales — to be parsed from cold. That cost grows with each key anybody adds,
 * and it had no headroom left under the 5 s default: SW-13's spray-reset strings
 * were enough to tip the first import over it.
 *
 * What is being asserted takes microseconds; the timeout is buying module load,
 * so it is set where a slow CI box has room rather than where today's catalogue
 * happens to land. A real regression here is a hang, not five seconds.
 */
const CATALOGUE_IMPORT_TIMEOUT_MS = 30_000;

describe('screenshot locale override', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    'uses the bundled screenshot locale in screenshot mode',
    async () => {
      vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
      vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_LOCALE', 'es');

      const { detectDeviceLocale } = await import('../config');

      expect(detectDeviceLocale()).toBe('es');
    },
    CATALOGUE_IMPORT_TIMEOUT_MS,
  );

  it(
    'falls back to device locale when screenshot locale is absent',
    async () => {
      const { detectDeviceLocale } = await import('../config');

      expect(detectDeviceLocale()).toBe('fr');
    },
    CATALOGUE_IMPORT_TIMEOUT_MS,
  );
});
