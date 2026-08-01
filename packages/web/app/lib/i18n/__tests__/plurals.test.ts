import { describe, expect, it, beforeAll } from 'vite-plus/test';
import 'intl-pluralrules';
import i18next from 'i18next';

// Validates that i18next's CLDR plural resolver maps `count` to the correct
// `_one` / `_other` suffix for each supported locale. Since v24 the v3 JSON
// compatibility mode is gone; without `Intl.PluralRules` the resolver falls
// back to an English-only dummy rule, so this CLDR path is the one every
// locale rides on. The polyfill import above is a no-op on
// Node 22 (which ships native `Intl.PluralRules`) but ensures the test file
// exercises the same code path the browser bundle uses — so a regression that
// strips the polyfill would still surface here if it ever broke locale
// registration.
//
// Catches: missing `_one`/`_other` siblings in catalogs, and runtime
// environments where plural rules aren't registered.

describe('i18next plural resolution', () => {
  beforeAll(async () => {
    await i18next.init({
      lng: 'en-US',
      fallbackLng: 'en-US',
      supportedLngs: ['en-US', 'es', 'fr'],
      resources: {
        'en-US': {
          translation: {
            climb_one: '{{count}} climb',
            climb_other: '{{count}} climbs',
          },
        },
        es: {
          translation: {
            climb_one: '{{count}} bloque',
            climb_other: '{{count}} bloques',
          },
        },
        fr: {
          translation: {
            climb_one: '{{count}} bloc',
            climb_other: '{{count}} blocs',
          },
        },
      },
      interpolation: { escapeValue: false },
    });
  });

  it.each([
    ['en-US', 1, '1 climb'],
    ['en-US', 2, '2 climbs'],
    ['en-US', 0, '0 climbs'],
    ['es', 1, '1 bloque'],
    ['es', 2, '2 bloques'],
    ['fr', 1, '1 bloc'],
    ['fr', 2, '2 blocs'],
    // French treats 0 as singular (`one`), unlike English/Spanish — this
    // catches anyone who hardcodes `count !== 1 → other` instead of using
    // `Intl.PluralRules`.
    ['fr', 0, '0 bloc'],
  ])('resolves %s count=%i to "%s"', async (locale, count, expected) => {
    const t = await i18next.changeLanguage(locale);
    expect(t('climb', { count })).toBe(expected);
  });
});
