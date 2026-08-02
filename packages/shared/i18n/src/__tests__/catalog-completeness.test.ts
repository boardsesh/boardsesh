import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOCALE } from '../config';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');

// Every supported locale (except the source `en-US`) must stay at full parity
// with the English catalog. Missing keys silently fall back to English at
// runtime, ship untranslated copy to users, and spam Sentry with missing-key
// warnings — fail the build here instead.
const STRICTLY_ENFORCED_LOCALES = ['es', 'fr', 'de'] as const;

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

describe('i18n catalog completeness', () => {
  for (const locale of STRICTLY_ENFORCED_LOCALES) {
    describe(locale, () => {
      for (const namespace of namespaces) {
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
});
