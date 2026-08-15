import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SiteJsonLd from '@/app/components/seo/site-json-ld';
import { getPopularBoardConfigs } from './lib/server-popular-configs';
import { getRecentBetaLinks } from './lib/server-recent-beta-links';
import { selectHomeLcpHints } from './lib/popular-lcp-preload';
import { getPublicBackendHttpUrl } from './lib/backend-url';
import HomePageContent from './home-page-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.home.title'),
    description: t('metadata.home.description'),
    ogDescription: t('metadata.home.ogDescription'),
    path: '/',
    locale,
  });
}

export default async function Home() {
  const [popularConfigs, recentBeta, locale] = await Promise.all([
    getPopularBoardConfigs(),
    getRecentBetaLinks(),
    getLocale(),
  ]);
  // Point the single high-priority image hint at whatever the browser will
  // actually paint as the LCP element: the first (cross-origin) beta thumbnail
  // when the recent-beta rail renders, otherwise the first board thumbnail.
  // `getPublicBackendHttpUrl()` resolves to a browser-reachable origin on the
  // server (unlike `getBackendHttpUrl`, which can return a Docker-internal one).
  const { preconnectOrigin, boardPreloadUrl } = selectHomeLcpHints({
    recentBetaCount: recentBeta.length,
    popularConfigs,
    backendOrigin: getPublicBackendHttpUrl(),
  });

  return (
    <I18nProvider locale={locale} namespaces={['marketing', 'boards', 'climbs', 'profile', 'feed']}>
      {/* Warm the cross-origin backend host that serves the beta-rail LCP image.
          No crossOrigin: the beta <img> is a credentialed no-cors request, so a
          plain preconnect opens the connection it can reuse. */}
      {preconnectOrigin && <link rel="preconnect" href={preconnectOrigin} />}
      {boardPreloadUrl && <link rel="preload" as="image" href={boardPreloadUrl} fetchPriority="high" />}
      <SiteJsonLd />
      <HomePageContent initialPopularConfigs={popularConfigs} initialRecentBeta={recentBeta} />
    </I18nProvider>
  );
}
