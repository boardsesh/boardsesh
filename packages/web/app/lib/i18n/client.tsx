'use client';

// Polyfill `Intl.PluralRules` for older browsers / WebViews (e.g. iOS 12,
// older Bluefy builds). i18next resolves plurals through `Intl.PluralRules`,
// and since v24 that API is mandatory with no fallback — without this,
// environments that lack it silently fall through to the base key
// (issue #1852).
import 'intl-pluralrules';
import React, { useMemo } from 'react';
import i18next, { type i18n } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { loadCatalog } from '@boardsesh/i18n/catalog-loader';
import { DEFAULT_LOCALE, DEFAULT_NAMESPACE, SUPPORTED_LOCALES, type Locale } from './config';
import { reportMissingI18nKey } from './missing-key-reporter';

// Module-level singleton. The language switcher routes via `next/link` so the
// browser navigates to the new locale's URL — that re-runs the server pipeline,
// re-mounts the provider with fresh resources, and React reconciles every
// translated subtree. We only fall through to `changeLanguage` here for the
// rare case where a parent re-renders this provider with a new `locale` prop
// without a navigation.
//
// Known limitation in that no-navigation path: `changeLanguage` is async and
// fired without await, and the singleton's object identity is stable across
// renders, so `useMemo([locale, resources])` still returns the same instance.
// Consumers can therefore see the previous locale's strings for one render
// tick. Acceptable for v1 because the no-navigation path is unused — revisit
// if we add an in-app locale toggle that doesn't route. See PR #1778 review.
let clientInstance: i18n | undefined;

function getClientInstance(locale: Locale, resources: Record<string, Record<string, unknown>>): i18n {
  if (clientInstance) {
    for (const [ns, bundle] of Object.entries(resources)) {
      if (!clientInstance.hasResourceBundle(locale, ns)) {
        clientInstance.addResourceBundle(locale, ns, bundle, true, true);
      }
    }
    if (clientInstance.language !== locale) {
      void clientInstance.changeLanguage(locale);
    }
    return clientInstance;
  }

  const instance = i18next.createInstance();
  instance
    .use(resourcesToBackend((lng: string, ns: string) => loadCatalog(lng, ns)))
    .use(initReactI18next)
    .init({
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: SUPPORTED_LOCALES as unknown as string[],
      defaultNS: DEFAULT_NAMESPACE,
      resources: { [locale]: resources },
      interpolation: { escapeValue: false },
      returnNull: false,
      saveMissing: true,
      saveMissingPlurals: false,
      missingKeyHandler: (lngs, ns, key, fallbackValue) => {
        reportMissingI18nKey({ lngs, ns, key, fallbackValue });
      },
    });
  clientInstance = instance;
  return instance;
}

export function I18nProvider({
  locale,
  resources,
  children,
}: {
  locale: Locale;
  resources: Record<string, Record<string, unknown>>;
  children: React.ReactNode;
}) {
  const instance = useMemo(() => getClientInstance(locale, resources), [locale, resources]);
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
