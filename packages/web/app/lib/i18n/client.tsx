'use client';

// Polyfill `Intl.PluralRules` for older browsers / WebViews (e.g. iOS 12,
// older Bluefy builds). When the API is missing, i18next's plural resolver
// silently falls back to a hardcoded English rule
// (`count === 1 ? 'one' : 'other'`), so fr picks the wrong suffix
// (`count=0` renders `_other` instead of `_one`) and categories like `many`
// vanish (issue #1852).
import 'intl-pluralrules';
import React, { useContext, useMemo } from 'react';
import i18next, { type i18n } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { I18nContext, I18nextProvider, initReactI18next } from 'react-i18next';
import { loadCatalog } from '@boardsesh/i18n/catalog-loader';
import { DEFAULT_LOCALE, DEFAULT_NAMESPACE, SUPPORTED_LOCALES, type Locale } from './config';
import { reportMissingI18nKey } from './missing-key-reporter';

// This provider has two lifetimes, because `'use client'` does not mean
// "browser only" — a client component is rendered to HTML on the server on
// every request too.
//
// Browser: the module-level singleton below, one instance per tab. The language
// switcher routes via `next/link` so the browser navigates to the new locale's
// URL — that re-runs the server pipeline, re-mounts the provider with fresh
// resources, and React reconciles every translated subtree. We only fall
// through to `changeLanguage` here for the rare case where a parent re-renders
// this provider with a new `locale` prop without a navigation.
//
// Known limitation in that no-navigation path: `changeLanguage` is async and
// fired without await, and the singleton's object identity is stable across
// renders, so `useMemo([locale, resources])` still returns the same instance.
// Consumers can therefore see the previous locale's strings for one render
// tick. Acceptable for v1 because the no-navigation path is unused — revisit
// if we add an in-app locale toggle that doesn't route. See PR #1778 review.
//
// Server: one instance per render, never the singleton, and `changeLanguage` is
// never called. One Node process interleaves many requests, so a shared
// instance let request B's `changeLanguage('fr')` flip the language out from
// under request A's half-rendered `/de` page and serve it French markup
// (issue #4519). A per-render instance has nothing left to share.
//
// The catch: providers nest. The root layout mounts one `I18nProvider` and
// pages mount their own with a disjoint namespace set (`app/page.tsx` carries
// `marketing` but not `common`). Those used to collapse onto the one shared
// instance, so a page-provider subtree read the root provider's namespaces for
// free. A per-render instance loses that unless it starts from the enclosing
// provider's bundles — hence the `parentInstance` seed below, without which a
// nested subtree renders raw keys.
let clientInstance: i18n | undefined;

function createConfiguredInstance(locale: Locale, resources: Record<string, Record<string, unknown>>): i18n {
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
  return instance;
}

function getClientInstance(
  locale: Locale,
  resources: Record<string, Record<string, unknown>>,
  parentInstance?: i18n,
): i18n {
  if (typeof window === 'undefined') {
    // Seed from the enclosing provider so nested providers still resolve each
    // other's namespaces. The language guard stops a parent sitting on another
    // locale from seeding the wrong strings.
    const inherited =
      (parentInstance?.language === locale ? parentInstance.getDataByLanguage(locale) : undefined) ?? {};
    return createConfiguredInstance(locale, { ...inherited, ...resources });
  }

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

  const instance = createConfiguredInstance(locale, resources);
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
  // react-i18next types `I18nContext` as always carrying an instance, but the
  // context is created with no default value — the outermost provider really
  // does read `undefined` here. If a future react-i18next reshapes the context
  // value, this reads `undefined` and the server loses inheritance rather than
  // breaking; the nested-provider case in ssr-locale-isolation.test.tsx is what
  // turns that into a visible failure.
  const parentContext = useContext(I18nContext) as { i18n: i18n } | undefined;
  const parentInstance = parentContext?.i18n;
  const instance = useMemo(
    () => getClientInstance(locale, resources, parentInstance),
    [locale, resources, parentInstance],
  );
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
