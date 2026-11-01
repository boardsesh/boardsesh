import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// detectDeviceLocale walks the device's preferred languages in order. The
// per-tag rules are covered in match-device-locale.test.ts; this file covers the
// walk, the fallback, and that the Chinese catalogs are actually registered.

const deviceLocales = vi.hoisted(() => ({
  current: [] as Array<{ languageTag: string; languageCode: string | null }>,
}));

vi.mock('expo-localization', () => ({
  getLocales: () => deviceLocales.current,
}));

// Importing ../config parses every namespace of every locale from cold, which
// is what the generous timeout pays for (see screenshot-locale.test.ts).
const CATALOGUE_IMPORT_TIMEOUT_MS = 30_000;

function setDevice(...languageTags: string[]): void {
  deviceLocales.current = languageTags.map((languageTag) => ({
    languageTag,
    languageCode: languageTag.split('-')[0] ?? null,
  }));
}

describe('detectDeviceLocale', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    deviceLocales.current = [];
  });

  it.each([
    ['zh-CN', 'zh-Hans'],
    ['zh-Hans-CN', 'zh-Hans'],
    ['zh-Hans-US', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hans-CN-u-mu-celsius', 'zh-Hans'],
    ['zh-Hant', 'en-US'],
    ['zh-TW', 'en-US'],
    ['zh-HK', 'en-US'],
    ['fr-FR', 'fr'],
    ['ja-JP', 'en-US'],
  ])(
    'a device set to %s runs the app in %s',
    async (languageTag, expected) => {
      setDevice(languageTag);
      const { detectDeviceLocale } = await import('../config');
      expect(detectDeviceLocale()).toBe(expected);
    },
    CATALOGUE_IMPORT_TIMEOUT_MS,
  );

  it(
    'skips an unsupported first language for the next one the app can render',
    async () => {
      // A Traditional reader who also lists German gets German, not Simplified.
      setDevice('zh-Hant-TW', 'de-DE');
      const { detectDeviceLocale } = await import('../config');
      expect(detectDeviceLocale()).toBe('de');
    },
    CATALOGUE_IMPORT_TIMEOUT_MS,
  );

  it(
    'falls back to English when the device reports no languages',
    async () => {
      setDevice();
      const { detectDeviceLocale } = await import('../config');
      expect(detectDeviceLocale()).toBe('en-US');
    },
    CATALOGUE_IMPORT_TIMEOUT_MS,
  );

  it(
    'starts i18next in Simplified Chinese with every mobile namespace loaded',
    async () => {
      setDevice('zh-Hans-CN');
      const { default: i18n } = await import('../config');
      const { MOBILE_NAMESPACES } = await import('@boardsesh/i18n');

      expect(i18n.language).toBe('zh-Hans');
      for (const namespace of MOBILE_NAMESPACES) {
        expect({ namespace, loaded: i18n.hasResourceBundle('zh-Hans', namespace) }).toEqual({
          namespace,
          loaded: true,
        });
      }
      expect(i18n.t('actions.cancel')).toBe('取消');
      // Chinese has one plural category, so every count reads the `_other` key.
      expect(i18n.t('comment.count', { count: 1 })).toBe('1 条评论');
      expect(i18n.t('comment.count', { count: 5 })).toBe('5 条评论');
    },
    CATALOGUE_IMPORT_TIMEOUT_MS,
  );
});
