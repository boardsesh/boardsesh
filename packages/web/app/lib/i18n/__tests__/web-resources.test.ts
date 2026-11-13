// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { loadCatalog } from '@boardsesh/i18n/catalog-loader';
import {
  analyzeFile,
  appRoot,
  computeMissingKeys,
  discoverFiles,
  loadCatalog as loadCatalogKeys,
} from '../../../../scripts/check-orphaned-i18n-keys';
import { DEFAULT_LOCALE, SEED_NAMESPACES, SUPPORTED_LOCALES, type SeedNamespace } from '../config';
import { getServerTranslationForLocale, loadServerResources } from '../server';

vi.mock('server-only', () => ({}));
vi.mock('../get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('../missing-key-reporter', () => ({ reportMissingI18nKey: vi.fn() }));

const NATIVE_ONLY_NAMESPACES: readonly SeedNamespace[] = ['common', 'climbs', 'feed'];

it('keeps web and shared copy helpers within the available hydration resources', async () => {
  const resources = await loadServerResources(DEFAULT_LOCALE, SEED_NAMESPACES);
  const catalogKeys = loadCatalogKeys(SEED_NAMESPACES);
  const prunedNamespaces = new Set<string>();
  for (const [namespace, keys] of catalogKeys) {
    if (Object.hasOwn(resources[namespace], 'mobile')) continue;
    if ([...keys].some((key) => key.startsWith('mobile.'))) prunedNamespaces.add(namespace);
    catalogKeys.set(namespace, new Set([...keys].filter((key) => !key.startsWith('mobile.'))));
  }
  const analyses = discoverFiles([
    appRoot,
    resolve(appRoot, '../../shared/workout-summary/src'),
    resolve(appRoot, '../../shared/connected-apps/src'),
  ]).map((filename) => ({ filename, ...analyzeFile(filename) }));
  const references = analyses.flatMap((analysis) => analysis.references);
  const unsafeTemplates = analyses.flatMap(({ filename, globs }) =>
    [...globs].flatMap(([namespace, patterns]) => {
      // An unbound helper can receive a translator for a pruned namespace too.
      if (!prunedNamespaces.has(namespace) && catalogKeys.has(namespace)) return [];
      // A leading wildcard can resolve to mobile too; require explicit copy
      // when a template could enter a branch omitted from this web namespace.
      return patterns.some(({ segments }) => typeof segments[0] !== 'string' || segments[0] === 'mobile')
        ? [{ filename, namespace }]
        : [];
    }),
  );

  expect(computeMissingKeys(catalogKeys, references)).toEqual([]);
  expect(unsafeTemplates).toEqual([]);
}, 20_000);

describe.each(SUPPORTED_LOCALES)('web hydration resources in %s', (locale) => {
  it('preserves all copy except the three unused native branches', async () => {
    const resources = await loadServerResources(locale, SEED_NAMESPACES);
    for (const namespace of SEED_NAMESPACES) {
      const catalog = (await loadCatalog(locale, namespace)).default as Record<string, unknown>;
      if (NATIVE_ONLY_NAMESPACES.includes(namespace)) {
        expect(catalog.mobile).toBeDefined();
        expect(resources[namespace]).toEqual(
          Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== 'mobile')),
        );
        expect(resources[namespace]).not.toHaveProperty('mobile');
      } else {
        expect(resources[namespace], namespace).toEqual(catalog);
      }
    }
    expect(resources.boards).toHaveProperty('mobile.edit.notFound');
    expect(resources.session).toHaveProperty('mobile');
  });

  it('leaves native catalogs and server translation available after projection', async () => {
    for (const namespace of NATIVE_ONLY_NAMESPACES) {
      const catalog = (await loadCatalog(locale, namespace)).default as Record<string, unknown>;
      const original = JSON.stringify(catalog);
      const { i18n } = await getServerTranslationForLocale(locale, namespace);

      await loadServerResources(locale, [namespace]);

      expect(i18n.getResource(locale, namespace, 'mobile')).toEqual(catalog.mobile);
      expect(JSON.stringify(catalog)).toBe(original);
    }
  });

  it('cuts at least a quarter of the compressed crawl-heavy catalogs', async () => {
    const resources = await loadServerResources(locale, NATIVE_ONLY_NAMESPACES);
    const fullCatalogs = Object.fromEntries(
      await Promise.all(
        NATIVE_ONLY_NAMESPACES.map(async (namespace) => [namespace, (await loadCatalog(locale, namespace)).default]),
      ),
    );
    const before = gzipSync(JSON.stringify(fullCatalogs)).byteLength;
    const after = gzipSync(JSON.stringify(resources)).byteLength;

    expect(after).toBeLessThan(before * 0.75);
  });
});
