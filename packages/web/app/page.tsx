import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SiteJsonLd from '@/app/components/seo/site-json-ld';
import { getPopularBoardConfigs } from './lib/server-popular-configs';
import { getRecentBetaLinks } from './lib/server-recent-beta-links';
import HomePageContent from './home-page-content';
import HomeGymSearch from './components/home/home-gym-search';
import HomeFeatureStrip from './components/home/home-feature-strip';
import HomeSupportBlock from './components/home/home-support-block';

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

  return (
    <I18nProvider locale={locale} namespaces={['marketing', 'boards', 'climbs', 'profile', 'feed']}>
      {/* The hero's Next Image owns its responsive preload. Board and beta
          thumbnails now sit below the hero and must not compete with it. */}
      <SiteJsonLd />
      {/* The three marketing sections are async server components, so they are
          rendered HERE and handed down as slots: HomePageContent is a client
          component (the hero reads the visitor's platform) and cannot await
          them. This keeps their markup — the gym links especially — in the
          first HTML a crawler sees. */}
      <HomePageContent
        initialPopularConfigs={popularConfigs}
        initialRecentBeta={recentBeta}
        gymSearch={<HomeGymSearch />}
        featureStrip={<HomeFeatureStrip />}
        supportBlock={<HomeSupportBlock />}
      />
    </I18nProvider>
  );
}
