import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ONLY_LOCALES, DEFAULT_LOCALE, MOBILE_NAMESPACES, WEB_LOCALES } from '../config';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');

// Every supported locale (except the source `en-US`) must stay at full parity
// with the English catalog. Missing keys silently fall back to English at
// runtime, ship untranslated copy to users, and spam Sentry with missing-key
// warnings — fail the build here instead.
const STRICTLY_ENFORCED_LOCALES = ['es', 'fr', 'de'] as const;

// App-only locales (zh-Hans) ship the mobile namespaces and nothing else: www
// does not serve them, so the web-only catalogs must NOT exist for them. Parity
// is enforced for exactly the namespaces Metro bundles.
const mobileNamespaceFiles = MOBILE_NAMESPACES.map((namespace) => `${namespace}.json`);

type Catalog = Record<string, unknown>;

function loadCatalog(locale: string, namespace: string): Catalog {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, namespace), 'utf8'));
}

function collectKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') {
    return [prefix];
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const next = prefix ? `${prefix}.${key}` : key;
    keys.push(...collectKeys(value, next));
  }
  return keys;
}

function collectStrings(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (node === null || typeof node !== 'object') return [];
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(node)) {
    entries.push(...collectStrings(value, prefix ? `${prefix}.${key}` : key));
  }
  return entries;
}

// The ICU placeholders a string interpolates, e.g. "Hello {{name}}" -> {"name"}.
function placeholders(value: string): string[] {
  return [...new Set([...value.matchAll(/{{\s*([A-Za-z0-9_]+)/g)].map((match) => match[1]))].sort();
}

const namespaces = readdirSync(join(LOCALES_DIR, DEFAULT_LOCALE)).filter((file) => file.endsWith('.json'));

function describeParity(locale: string, namespaceFiles: readonly string[]) {
  describe(locale, () => {
    for (const namespace of namespaceFiles) {
      it(`${namespace} ships the same key set as en-US`, () => {
        const expected = new Set(collectKeys(loadCatalog(DEFAULT_LOCALE, namespace)));
        const actual = new Set(collectKeys(loadCatalog(locale, namespace)));
        const missing = [...expected].filter((key) => !actual.has(key));
        const extra = [...actual].filter((key) => !expected.has(key));
        expect({ namespace, missing, extra }).toEqual({ namespace, missing: [], extra: [] });
      });

      // Key parity alone lets a translation silently drop an interpolation:
      // the key exists, the sentence reads fine, and the value the placeholder
      // carried (a board name, a download size) just never renders. Catch it
      // here rather than in a screenshot.
      it(`${namespace} interpolates the same placeholders as en-US`, () => {
        const translated = new Map(collectStrings(loadCatalog(locale, namespace)));
        const mismatched = collectStrings(loadCatalog(DEFAULT_LOCALE, namespace))
          .filter(([key]) => translated.has(key))
          .map(([key, source]) => ({
            key,
            expected: placeholders(source),
            actual: placeholders(translated.get(key)!),
          }))
          .filter(({ expected, actual }) => expected.join() !== actual.join());
        expect({ namespace, mismatched }).toEqual({ namespace, mismatched: [] });
      });
    }
  });
}

describe('i18n catalog completeness', () => {
  for (const locale of STRICTLY_ENFORCED_LOCALES) {
    describeParity(locale, namespaces);
  }

  it('enforces every web locale except the English source', () => {
    // The list above is hand-maintained. A web locale missing from it would
    // ship untranslated namespaces with nothing failing.
    expect([...STRICTLY_ENFORCED_LOCALES].sort()).toEqual(
      WEB_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).sort(),
    );
  });
});

describe('app-only locale catalogs', () => {
  for (const locale of APP_ONLY_LOCALES) {
    describeParity(locale, mobileNamespaceFiles);

    it(`${locale} ships the mobile namespaces and no web-only one`, () => {
      // A stray marketing.json here would look like a half-finished web locale
      // and invite someone to switch the routes on.
      const shipped = readdirSync(join(LOCALES_DIR, locale))
        .filter((file) => file.endsWith('.json'))
        .sort();
      expect(shipped).toEqual([...mobileNamespaceFiles].sort());
    });

    it(`${locale} keeps the same key order as en-US`, () => {
      // Order is not load-bearing at runtime, but a reordered catalog turns every
      // later translation diff into noise.
      for (const namespace of mobileNamespaceFiles) {
        expect({ namespace, keys: collectKeys(loadCatalog(locale, namespace)) }).toEqual({
          namespace,
          keys: collectKeys(loadCatalog(DEFAULT_LOCALE, namespace)),
        });
      }
    });

    it(`${locale} leaves no string empty`, () => {
      for (const namespace of mobileNamespaceFiles) {
        const source = new Map(collectStrings(loadCatalog(DEFAULT_LOCALE, namespace)));
        const empty = collectStrings(loadCatalog(locale, namespace))
          .filter(([key, value]) => value.trim() === '' && (source.get(key) ?? '').trim() !== '')
          .map(([key]) => key);
        expect({ namespace, empty }).toEqual({ namespace, empty: [] });
      }
    });
  }
});

describe('Simplified Chinese plural forms', () => {
  // Chinese has one plural category (`other`). i18next resolves every count to
  // the `_other` key, so `_one` is never read, but key parity keeps it in the
  // file.
  it('gives every _one key an _other sibling', () => {
    for (const namespace of mobileNamespaceFiles) {
      const keys = new Set(collectKeys(loadCatalog('zh-Hans', namespace)));
      const orphans = [...keys]
        .filter((key) => key.endsWith('_one'))
        .filter((key) => !keys.has(key.replace(/_one$/, '_other')));
      expect({ namespace, orphans }).toEqual({ namespace, orphans: [] });
    }
  });

  // `_other` is what a climber with exactly one item reads, so it cannot use a
  // plural pronoun ("you logged them" for a single send).
  it('keeps plural pronouns out of every _other string', () => {
    const pluralPronoun = /它们|他们|她们|这些|那些/;
    for (const namespace of mobileNamespaceFiles) {
      const pluralOnly = collectStrings(loadCatalog('zh-Hans', namespace))
        .filter(([key, text]) => key.endsWith('_other') && pluralPronoun.test(text))
        .map(([key]) => key);
      expect({ namespace, pluralOnly }).toEqual({ namespace, pluralOnly: [] });
    }
  });
});
