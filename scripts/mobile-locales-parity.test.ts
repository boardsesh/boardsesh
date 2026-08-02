/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '../packages/shared/i18n/src/config';

// Adding a language touches three places that must agree, and nothing but this
// test notices when they don't:
//
//   1. packages/mobile/locales/<lang>.json — the InfoPlist strings Expo writes
//      into <lang>.lproj/InfoPlist.strings at prebuild (the permission prompts).
//   2. ios.infoPlist.CFBundleLocalizations in app.config.ts — what the binary
//      declares, which is what the App Store shows under "Languages".
//   3. SUPPORTED_LOCALES in @boardsesh/i18n — the languages the JS UI translates.
//
// Drift is silent in every direction: a locale file with no CFBundleLocalizations
// entry never reaches the store page, a declared language with no locale file
// claims a translation that doesn't exist, and a missing key falls back to the
// development-region string with no warning.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_ROOT = resolve(REPO_ROOT, 'packages/mobile');
const LOCALES_DIR = resolve(MOBILE_ROOT, 'locales');
const APP_CONFIG = resolve(MOBILE_ROOT, 'app.config.ts');

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

function readLocaleStrings(language: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(LOCALES_DIR, `${language}.json`), 'utf8')) as Record<string, string>;
}

/**
 * CFBundleLocalizations out of app.config.ts. Read as text rather than importing
 * the config: it's an Expo config factory that reads env and resolves plugins, so
 * evaluating it here would couple this test to the whole native config surface.
 */
function declaredLocalizations(): string[] {
  const source = readFileSync(APP_CONFIG, 'utf8');
  const match = source.match(/CFBundleLocalizations:\s*\[([^\]]*)\]/);
  if (!match) throw new Error('CFBundleLocalizations not found in app.config.ts');
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

/** The `locales` map, as language -> path. */
function declaredLocaleFiles(): Record<string, string> {
  const source = readFileSync(APP_CONFIG, 'utf8');
  const match = source.match(/\n {4}locales:\s*\{([^}]*)\}/);
  if (!match) throw new Error('locales map not found in app.config.ts');
  return Object.fromEntries([...match[1].matchAll(/(\w+):\s*['"]([^'"]+)['"]/g)].map((entry) => [entry[1], entry[2]]));
}

describe('mobile locale parity', () => {
  it('declares a CFBundleLocalizations entry for every app locale', () => {
    const declared = declaredLocalizations();
    for (const locale of SUPPORTED_LOCALES) {
      expect(declared).toContain(languageSubtag(locale));
    }
  });

  it('ships an InfoPlist strings file for every declared localization', () => {
    expect(localeFileNames()).toEqual([...declaredLocalizations()].sort());
  });

  it('points the locales map at a file that exists, for every declared localization', () => {
    const localeFiles = declaredLocaleFiles();
    expect(Object.keys(localeFiles).sort()).toEqual([...declaredLocalizations()].sort());
    for (const [language, path] of Object.entries(localeFiles)) {
      expect(path).toBe(`./locales/${language}.json`);
    }
  });

  it('translates the same InfoPlist keys in every language', () => {
    const languages = localeFileNames();
    // en is the base: every prompt the app can show has an English string, so a
    // key missing from a translation is a prompt that silently falls back.
    const baseKeys = Object.keys(readLocaleStrings('en')).sort();
    expect(baseKeys.length).toBeGreaterThan(0);
    for (const language of languages) {
      expect({ language, keys: Object.keys(readLocaleStrings(language)).sort() }).toEqual({
        language,
        keys: baseKeys,
      });
    }
  });

  it('leaves no empty usage descriptions', () => {
    for (const language of localeFileNames()) {
      for (const [key, value] of Object.entries(readLocaleStrings(language))) {
        expect({ language, key, empty: value.trim().length === 0 }).toEqual({ language, key, empty: false });
      }
    }
  });
});
