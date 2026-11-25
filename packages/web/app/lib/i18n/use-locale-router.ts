'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { applyLocale, stripLocalePrefix } from './locale-href';
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from './config';
import { runIfSessionGenerationCurrent, useSessionGeneration } from '@/app/hooks/use-session-generation';
import { navigateAcrossMarketingDocument, needsMarketingDocumentNavigation } from './marketing-document-navigation';

function useActiveLocale(): Locale {
  const { i18n } = useTranslation();
  return isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
}

export function usePathnameWithoutLocale(): string {
  const pathname = usePathname() ?? '/';
  const activeLocale = useActiveLocale();
  return stripLocalePrefix(pathname, activeLocale);
}

type RouterPushOptions = Parameters<ReturnType<typeof useRouter>['push']>[1];
type RouterReplaceOptions = Parameters<ReturnType<typeof useRouter>['replace']>[1];
type RouterPrefetchOptions = Parameters<ReturnType<typeof useRouter>['prefetch']>[1];

export function useLocaleRouter() {
  const router = useRouter();
  const activeLocale = useActiveLocale();
  const sourcePath = usePathname() ?? '/';
  // Navigation asked for by a render from before an account change is dropped.
  const generation = useSessionGeneration();

  const push = useCallback(
    (href: string, options?: RouterPushOptions) => {
      // At once, or after a running viewer check confirms this login; never for another account.
      runIfSessionGenerationCurrent(generation, () => {
        const target = applyLocale(href, activeLocale);
        if (navigateAcrossMarketingDocument(target, false, sourcePath)) return;
        if (options === undefined) router.push(target);
        else router.push(target, options);
      });
    },
    [router, activeLocale, generation, sourcePath],
  );

  const replace = useCallback(
    (href: string, options?: RouterReplaceOptions) => {
      // At once, or after a running viewer check confirms this login; never for another account.
      runIfSessionGenerationCurrent(generation, () => {
        const target = applyLocale(href, activeLocale);
        if (navigateAcrossMarketingDocument(target, true, sourcePath)) return;
        if (options === undefined) router.replace(target);
        else router.replace(target, options);
      });
    },
    [router, activeLocale, generation, sourcePath],
  );

  const prefetch = useCallback(
    (href: string, options?: RouterPrefetchOptions) => {
      const target = applyLocale(href, activeLocale);
      if (needsMarketingDocumentNavigation(sourcePath, target)) return;
      return options === undefined ? router.prefetch(target) : router.prefetch(target, options);
    },
    [router, activeLocale, sourcePath],
  );

  return useMemo(
    () => ({
      push,
      replace,
      prefetch,
      back: () => router.back?.(),
      forward: () => router.forward?.(),
      refresh: () => router.refresh?.(),
    }),
    [push, replace, prefetch, router],
  );
}
