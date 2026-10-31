import React from 'react';
import { headers } from 'next/headers';
import { trustedEdgeCountry } from '@boardsesh/consent/edge-country';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SupportContent from './support-content';
import {
  buildSupportPageOptions,
  parseCurrencyParam,
  readSupportLinksConfig,
  sanitizeSupportSrc,
} from './support-links';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.support.title'),
    description: t('metadata.support.description'),
    path: '/support',
    locale,
  });
}

type SupportPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SupportPage({ searchParams }: SupportPageProps) {
  const [locale, requestHeaders, params] = await Promise.all([getLocale(), headers(), searchParams]);
  const src = sanitizeSupportSrc(params.src);
  // The default currency is per visitor, so this page must never be edge-cached
  // (it is not: see WWW_HTML_CACHE_ROOT_SEGMENTS in infra/cloudflare/config.ts).
  // Country only from a Cloudflare hop; anything else reads as "not the US".
  const country = trustedEdgeCountry({
    forwardedFor: requestHeaders.get('x-forwarded-for'),
    country: requestHeaders.get('cf-ipcountry'),
  });
  const options = buildSupportPageOptions({
    config: readSupportLinksConfig(),
    src,
    country,
    currencyParam: parseCurrencyParam(params.currency),
  });
  const thanks = params.thanks === '1';
  // The thank-you card's supporter panel shares its copy with /settings, so
  // only that visit pays for the `settings` catalog.
  const namespaces = thanks ? (['marketing', 'settings'] as const) : (['marketing'] as const);
  return (
    <I18nProvider locale={locale} namespaces={namespaces}>
      <SupportContent options={options} src={src} thanks={thanks} />
    </I18nProvider>
  );
}
