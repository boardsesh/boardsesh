/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { APP_LOCALIZATIONS, localeStringsPath } from '../packages/mobile/app.config';
import { SUPPORTED_LOCALES } from '../packages/shared/i18n/src/config';

// Adding a language touches three places that must agree, and nothing but this
// test notices when they don't:
//
//   1. packages/mobile/locales/<lang>.json — the InfoPlist strings Expo writes
//      into <lang>.lproj/InfoPlist.strings at prebuild (the permission prompts).
//   2. APP_LOCALIZATIONS in app.config.ts — the single source behind both
//      ios.infoPlist.CFBundleLocalizations (what the App Store shows under
//      "Languages") and the `locales` map that emits the .lproj bundles.
//   3. SUPPORTED_LOCALES in @boardsesh/i18n — the languages the JS UI translates.
//
// Drift is silent in every direction: a locale file with no declaration never
// reaches the store page, a declared language with no locale file claims a
// translation that doesn't exist, and a missing key falls back to the
// development-region string with no warning.
//
// Both config values are imported, not parsed out of the file — a regex over
// app.config.ts would break on a reformat and fail as a thrown Error rather than
// a named assertion.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_ROOT = resolve(REPO_ROOT, 'packages/mobile');
const LOCALES_DIR = resolve(MOBILE_ROOT, 'locales');

/** Language subtag of an app locale — 'en-US' -> 'en'. */
function languageSubtag(locale: string): string {
  return locale.split('-')[0];
}

function localeFileNames(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
}

/**
 * The iOS strings for a language. Keys at the TOP level of a locale file apply to
 * every platform — Expo's Android Locales plugin writes them into
 * res/values-b+<lang>/strings.xml — so InfoPlist keys have to sit under `ios` or
 * they leak in as junk Android string resources.
 */
function readLocaleStrings(language: string): Record<string, string> {
  const file = JSON.parse(readFileSync(resolve(LOCALES_DIR, `${language}.json`), 'utf8')) as {
    ios?: Record<string, string>;
  };
  return file.ios ?? {};
}

/** Anything outside the `ios` key, which would also be emitted for Android. */
function nonIosKeys(language: string): string[] {
  const file = JSON.parse(readFileSync(resolve(LOCALES_DIR, `${language}.json`), 'utf8')) as Record<string, unknown>;
  return Object.keys(file)
    .filter((key) => key !== 'ios')
    .sort();
}

describe('mobile locale parity', () => {
  it('declares a localization for every app locale', () => {
    const declared: readonly string[] = APP_LOCALIZATIONS;
    for (const locale of SUPPORTED_LOCALES) {
      expect({ locale, declared: declared.includes(languageSubtag(locale)) }).toEqual({ locale, declared: true });
    }
  });

  it('declares no language the JS UI cannot render', () => {
    // The other direction of the check above. A declared localization with a
    // locale file but no catalog would put the language on the App Store product
    // page while the app itself still renders English for it.
    const supportedLanguages = SUPPORTED_LOCALES.map(languageSubtag);
    for (const language of APP_LOCALIZATIONS) {
      expect({ language, translated: supportedLanguages.includes(language) }).toEqual({
        language,
        translated: true,
      });
    }
  });

  it('ships an InfoPlist strings file for every declared localization', () => {
    expect(localeFileNames()).toEqual([...APP_LOCALIZATIONS].sort());
  });

  it('resolves every declared localization to a file that exists', () => {
    for (const language of APP_LOCALIZATIONS) {
      const path = localeStringsPath(language);
      expect({ language, path, exists: existsSync(resolve(MOBILE_ROOT, path)) }).toEqual({
        language,
        path,
        exists: true,
      });
    }
  });

  it('translates the same InfoPlist keys in every language', () => {
    // en is the base: every prompt the app can show has an English string, so a
    // key missing from a translation is a prompt that silently falls back.
    const baseKeys = Object.keys(readLocaleStrings('en')).sort();
    expect(baseKeys.length).toBeGreaterThan(0);
    for (const language of localeFileNames()) {
      expect({ language, keys: Object.keys(readLocaleStrings(language)).sort() }).toEqual({
        language,
        keys: baseKeys,
      });
    }
  });

  // Load-bearing beyond the leak it names: Expo's iOS Locales plugin bails with an
  // early `return` (not `continue`) on the first language whose map is empty, so a
  // single empty `ios` block would silently drop InfoPlist.strings for every
  // language after it in APP_LOCALIZATIONS order. Don't delete this as redundant.
  it('scopes every string to ios so none leak into Android resources', () => {
    for (const language of localeFileNames()) {
      // A key outside `ios` is emitted for BOTH platforms, so an InfoPlist key
      // there becomes <string name="NSHealthUsageDescription"> in
      // res/values-b+<lang>/strings.xml — junk Android resources that also make
      // Android treat the language as a supported resource locale.
      expect({ language, strayKeys: nonIosKeys(language) }).toEqual({ language, strayKeys: [] });
      expect(Object.keys(readLocaleStrings(language)).length).toBeGreaterThan(0);
    }
  });

  it('leaves no empty usage descriptions', () => {
    for (const language of localeFileNames()) {
      for (const [key, value] of Object.entries(readLocaleStrings(language))) {
        expect({ language, key, empty: value.trim().length === 0 }).toEqual({ language, key, empty: false });
      }
    }
  });

  it('uses no double quote, which Expo writes unescaped into InfoPlist.strings', () => {
    // ios/Locales.js emits `key = "${value}";` with no escaping, so a " in a
    // translation produces a malformed .strings file — an iOS-only breakage that
    // wouldn't show up until a device read the prompt. German quotes („…“) and
    // French guillemets are fine; the ASCII one is not.
    for (const language of localeFileNames()) {
      for (const [key, value] of Object.entries(readLocaleStrings(language))) {
        expect({ language, key, hasQuote: value.includes('"') }).toEqual({ language, key, hasQuote: false });
      }
    }
  });
});
