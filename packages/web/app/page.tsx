import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SiteJsonLd from '@/app/components/seo/site-json-ld';
import { getBoardDiscovery } from './lib/server-board-discovery';
import { getRecentBetaLinks } from './lib/server-recent-beta-links';
import HomePageContent from './home-page-content';
import HomeGymSearch from './components/home/home-gym-search';
import { cachedCommunityStats } from './lib/graphql/server-cached-client';
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
  const [boards, recentBeta, locale, communityStats] = await Promise.all([
    getBoardDiscovery(),
    getRecentBetaLinks(),
    getLocale(),
    cachedCommunityStats(),
  ]);

  // Formatted here rather than in the client hero: the numbers are server data,
  // and `Intl.NumberFormat` on the locale we already resolved keeps 132,341 from
  // rendering as 132341 in English or 132.341 in German by accident.
  const { t } = await getServerTranslation('marketing');
  const numberFormat = new Intl.NumberFormat(locale);
  const heroProof = communityStats
    ? t('home.hero.proof', {
        formattedClimbers: numberFormat.format(communityStats.climbersLast30Days),
        formattedClimbs: numberFormat.format(communityStats.litLast30Days),
      })
    : t('home.hero.proofNoCount');

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
        initialBoards={boards}
        heroProof={heroProof}
        initialRecentBeta={recentBeta}
        gymSearch={<HomeGymSearch />}
        featureStrip={<HomeFeatureStrip />}
        supportBlock={<HomeSupportBlock />}
      />
    </I18nProvider>
  );
}
