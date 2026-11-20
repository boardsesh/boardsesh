'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { applyLocale, stripLocalePrefix } from './locale-href';
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from './config';
import { runIfSessionGenerationCurrent, useSessionGeneration } from '@/app/hooks/use-session-generation';

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
  // Navigation asked for by a render from before an account change is dropped.
  const generation = useSessionGeneration();

  const push = useCallback(
    (href: string, options?: RouterPushOptions) => {
      // At once, or after a running viewer check confirms this login; never for another account.
      runIfSessionGenerationCurrent(generation, () => {
        const target = applyLocale(href, activeLocale);
        if (options === undefined) router.push(target);
        else router.push(target, options);
      });
    },
    [router, activeLocale, generation],
  );

  const replace = useCallback(
    (href: string, options?: RouterReplaceOptions) => {
      // At once, or after a running viewer check confirms this login; never for another account.
      runIfSessionGenerationCurrent(generation, () => {
        const target = applyLocale(href, activeLocale);
        if (options === undefined) router.replace(target);
        else router.replace(target, options);
      });
    },
    [router, activeLocale, generation],
  );

  const prefetch = useCallback(
    (href: string, options?: RouterPrefetchOptions) => {
      const target = applyLocale(href, activeLocale);
      return options === undefined ? router.prefetch(target) : router.prefetch(target, options);
    },
    [router, activeLocale],
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
