import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@boardsesh/i18n';
import { matchDeviceLocale } from '../match-device-locale';

describe('matchDeviceLocale', () => {
  describe('Simplified Chinese', () => {
    // Every tag here was reported by a real device in production analytics.
    it.each([
      ['zh-Hans-CN', 'iPhone and Android in mainland China'],
      ['zh-CN', 'Android without a script subtag'],
      ['zh-Hans-US', 'iPhone set to Simplified outside China'],
      ['zh-Hans', 'bare script tag from iOS'],
      ['zh-Hans-CN-u-mu-celsius', 'Android with a Unicode extension'],
    ])('%s resolves to zh-Hans (%s)', (languageTag) => {
      expect(matchDeviceLocale(languageTag)).toBe('zh-Hans');
    });

    it.each(['zh-Hans-HK', 'zh-Hans-SG', 'zh-Hans-MY', 'zh-SG', 'zh-MY', 'zh', 'zh_CN', 'ZH-hans-cn'])(
      '%s resolves to zh-Hans',
      (languageTag) => {
        expect(matchDeviceLocale(languageTag)).toBe('zh-Hans');
      },
    );

    it('reads the script, not the region, when both are present', () => {
      // A Simplified reader living in Taiwan, and a Traditional reader in China.
      expect(matchDeviceLocale('zh-Hans-TW')).toBe('zh-Hans');
      expect(matchDeviceLocale('zh-Hant-CN')).toBeNull();
    });

    it('does not mistake an extension subtag for a region', () => {
      // `-u-rg-twzzzz` is a regional-format override, not the language region.
      expect(matchDeviceLocale('zh-u-rg-twzzzz')).toBe('zh-Hans');
      expect(matchDeviceLocale('zh-Hans-u-nu-hanidec')).toBe('zh-Hans');
    });
  });

  describe('Traditional Chinese', () => {
    // The app has no Traditional catalog. English beats the other script.
    it.each(['zh-Hant', 'zh-TW', 'zh-HK', 'zh-Hant-TW', 'zh-Hant-HK', 'zh-MO', 'zh-Hant-MO', 'zh-Hant-TW-u-ca-roc'])(
      '%s has no app locale',
      (languageTag) => {
        expect(matchDeviceLocale(languageTag)).toBeNull();
      },
    );
  });

  describe('the locales that already shipped', () => {
    it('returns an exact app locale unchanged', () => {
      for (const locale of SUPPORTED_LOCALES) {
        expect(matchDeviceLocale(locale)).toBe(locale);
      }
    });

    it.each([
      ['en-GB', 'en-US'],
      ['en-AU', 'en-US'],
      ['en', 'en-US'],
      ['en-US-u-hc-h23', 'en-US'],
      ['es-MX', 'es'],
      ['es-419', 'es'],
      ['fr-CA', 'fr'],
      ['de-AT', 'de'],
      ['de-CH-u-co-phonebk', 'de'],
    ])('%s resolves to %s', (languageTag, expected) => {
      expect(matchDeviceLocale(languageTag)).toBe(expected);
    });

    it.each(['ja-JP', 'ko', 'pt-BR', 'nl', 'yue-Hant-HK', '', null, undefined])(
      '%s has no app locale',
      (languageTag) => {
        expect(matchDeviceLocale(languageTag)).toBeNull();
      },
    );

    it('does not match a language whose code merely starts the same', () => {
      // `e` is not `en-US`/`es`, and `zhx` is not Chinese.
      expect(matchDeviceLocale('e')).toBeNull();
      expect(matchDeviceLocale('zhx-CN')).toBeNull();
    });
  });
});
