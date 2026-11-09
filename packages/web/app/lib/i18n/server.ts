import 'server-only';
import 'intl-pluralrules';
import { cache } from 'react';
import { createInstance, type i18n, type TFunction } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next/initReactI18next';
import { loadCatalog } from '@boardsesh/i18n/catalog-loader';
import { DEFAULT_LOCALE, DEFAULT_NAMESPACE, SUPPORTED_LOCALES, type Locale, type SeedNamespace } from './config';
import { getLocale } from './get-locale';
import { reportMissingI18nKey } from './missing-key-reporter';

const resourceLoader = resourcesToBackend((locale: string, namespace: string) => loadCatalog(locale, namespace));

// Per-request memoization. React.cache dedupes calls with the same arguments
// inside a single render, so generateMetadata + the page body share an
// instance instead of bootstrapping i18next twice. namespacesKey is a
// canonicalised string so unsorted/duplicate inputs still hit the cache.
const initI18nForRequest = cache(async (locale: Locale, namespacesKey: string): Promise<i18n> => {
  const namespaces = namespacesKey.split(',');
  const instance = createInstance();
  await instance
    .use(resourceLoader)
    .use(initReactI18next)
    .init({
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: SUPPORTED_LOCALES as unknown as string[],
      defaultNS: DEFAULT_NAMESPACE,
      ns: namespaces,
      interpolation: { escapeValue: false },
      returnNull: false,
      saveMissing: true,
      saveMissingPlurals: false,
      missingKeyHandler: (lngs, ns, key, fallbackValue) => {
        reportMissingI18nKey({ lngs, ns, key, fallbackValue });
      },
    });
  return instance;
});

function namespacesToKey(namespaces: readonly string[]): string {
  return [...new Set(namespaces)].sort().join(',');
}

export async function getServerTranslation(
  ns: SeedNamespace | readonly SeedNamespace[] = DEFAULT_NAMESPACE,
): Promise<{ t: TFunction; i18n: i18n; locale: Locale }> {
  return getServerTranslationForLocale(await getLocale(), ns);
}

/** API responses can resolve an explicit supported cookie locale without changing ambient headers. */
export async function getServerTranslationForLocale(
  locale: Locale,
  ns: SeedNamespace | readonly SeedNamespace[] = DEFAULT_NAMESPACE,
): Promise<{ t: TFunction; i18n: i18n; locale: Locale }> {
  const namespaces = Array.isArray(ns) ? ns : [ns];
  const instance = await initI18nForRequest(locale, namespacesToKey(namespaces));
  const primaryNs = namespaces[0];
  return { t: instance.getFixedT(locale, primaryNs), i18n: instance, locale };
}

export async function loadServerResources(
  locale: Locale,
  namespaces: readonly SeedNamespace[],
): Promise<Record<string, Record<string, unknown>>> {
  const instance = await initI18nForRequest(locale, namespacesToKey(namespaces));
  const resources: Record<string, Record<string, unknown>> = {};
  for (const ns of namespaces) {
    resources[ns] = (instance.getResourceBundle(locale, ns) ?? {}) as Record<string, unknown>;
  }
  return resources;
}
