'use client';

import React from 'react';
import NextLink from 'next/link';
import { useTranslation } from 'react-i18next';
import { applyLocale } from '@/app/lib/i18n/locale-href';
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale, isSupportedLocale } from '@/app/lib/i18n/config';
import { needsAppGuideDocumentNavigation } from '@/app/lib/i18n/published-locales';
import {
  needsMarketingDocumentNavigation,
  withMarketingNavigationCampaign,
} from '@/app/lib/i18n/marketing-document-navigation';

type LocaleLinkProps = Omit<React.ComponentProps<typeof NextLink>, 'href'> & {
  href: string;
  locale?: Locale;
};

export default function LocaleLink({ href, locale, onNavigate, replace, prefetch, ...rest }: LocaleLinkProps) {
  const { i18n } = useTranslation();
  const activeLocale: Locale = locale ?? (isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE);
  const localizedHref = applyLocale(href, activeLocale);
  const crossesDocumentShell =
    typeof window !== 'undefined' && needsMarketingDocumentNavigation(window.location.pathname, localizedHref);
  const handleNavigate: NonNullable<LocaleLinkProps['onNavigate']> = (event) => {
    const destination = new URL(localizedHref, window.location.href);
    const savedLocale = document.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith(`${LOCALE_COOKIE}=`))
      ?.split('=')[1];
    const needsDocumentNavigation =
      needsMarketingDocumentNavigation(window.location.pathname, destination.pathname) ||
      needsAppGuideDocumentNavigation(
        window.location.pathname,
        destination.pathname,
        i18n.language,
        activeLocale,
        savedLocale && isSupportedLocale(savedLocale) ? savedLocale : undefined,
      );
    if (!needsDocumentNavigation) {
      onNavigate?.(event);
      return;
    }

    // A soft navigation keeps the existing root layout and document language.
    // Reload for a language change so middleware can apply the saved locale.
    let cancelled = false;
    onNavigate?.({ preventDefault: () => (cancelled = true) });
    event.preventDefault();
    if (cancelled) return;
    const attributedDestination = withMarketingNavigationCampaign(destination);
    if (replace) window.location.replace(attributedDestination);
    else window.location.assign(attributedDestination);
  };

  return (
    <NextLink
      href={localizedHref}
      onNavigate={handleNavigate}
      replace={replace}
      prefetch={crossesDocumentShell ? false : prefetch}
      {...rest}
    />
  );
}
