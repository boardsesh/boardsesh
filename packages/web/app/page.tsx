import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SiteJsonLd from '@/app/components/seo/site-json-ld';
import ShowcaseVideoJsonLd from '@/app/components/seo/showcase-video-json-ld';
import { getRecentBetaLinks } from './lib/server-recent-beta-links';
import HomePageContent from './home-page-content';
import TrustFaq from '@/app/components/marketing/trust-faq';
import HomeGymSearch from './components/home/home-gym-search';
import { cachedCommunityStats } from './lib/graphql/server-cached-client';
import { formatCommunityProof } from './lib/community-proof';
import HomeFeatureStrip from './components/home/home-feature-strip';
import HomeSupportBlock from './components/home/home-support-block';
import HomeSupportBanner from './components/home/home-support-banner';
import { isSupportBannerWindow } from './components/home/support-banner-window';
import { hasMonthlyLinks, readSupportLinksConfig } from './support/support-links';
import PhoneQrCard from './components/climb-front-door/phone-qr-card';
import QrLandingTracker from './components/climb-front-door/qr-landing-tracker';
import { homeQrUrl } from './lib/gym-attribution';
import { getStoreButtonLabels } from './lib/store-button-labels.server';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.home.title'),
    description: t('metadata.home.description'),
    ogTitle: t('metadata.home.ogTitle'),
    ogDescription: t('metadata.home.ogDescription'),
    path: '/',
    locale,
  });
}

export default async function Home() {
  const [recentBeta, locale, communityStats, storeLabels] = await Promise.all([
    getRecentBetaLinks(),
    getLocale(),
    cachedCommunityStats(),
    getStoreButtonLabels(),
  ]);

  // Formatted here rather than in the client hero: the numbers are server data,
  // and `Intl.NumberFormat` on the locale we already resolved keeps 132,341 from
  // rendering as 132341 in English or 132.341 in German by accident.
  const { t } = await getServerTranslation('marketing');
  const heroProof = communityStats ? formatCommunityProof(communityStats, t, locale) : undefined;

  // The banner asks people to go monthly, so it waits for a monthly Payment Link
  // to exist. The page reads request headers, so this env read is per request.
  const showSupportBanner = isSupportBannerWindow(new Date()) && hasMonthlyLinks(readSupportLinksConfig());

  return (
    <I18nProvider
      locale={locale}
      namespaces={['marketing', 'website']}
      resourceKeys={{
        marketing: ['home', 'preview'],
        website: [
          'trust',
          'boardChoices',
          'importTitle',
          'importBody',
          'importLink',
          'sprayTitle',
          'sprayLead',
          'sprayRoute',
          'photoGuide',
          'proofNote',
          'runWall',
          'gymCard',
          'gymBody',
          'forGymsTitle',
          'claimGym',
          'wallCard',
          'sprayNoLights',
          'partnerCard',
          'partnerBody',
          'contact',
        ],
      }}
    >
      {/* The English hero preloads its poster on desktop; the localized app
          captures and below-fold thumbnails keep their default lazy loading. */}
      <SiteJsonLd />
      {/* The hero video is English-only (its text is burned in), so only the
          English page describes it to crawlers. */}
      {locale === 'en-US' ? <ShowcaseVideoJsonLd /> : null}
      {/* Counts a phone that scanned the hero's laptop code as `Home QR Scanned`. */}
      <QrLandingTracker kind="home" boardType={null} />
      {/* The three marketing sections are async server components, so they are
          rendered HERE and handed down as slots: HomePageContent is a client
          component (the hero reads the visitor's platform) and cannot await
          them. This keeps their markup — the gym links especially — in the
          first HTML a crawler sees. */}
      <HomePageContent
        heroProof={heroProof}
        desktopInstall={
          <PhoneQrCard
            url={homeQrUrl(locale)}
            title={t('home.hero.qrTitle')}
            body={t('home.hero.qrBody')}
            imageLabel={t('home.hero.qrImageLabel')}
            placement="home-qr-card"
            storeLabels={storeLabels}
            qrLanding="home"
          />
        }
        initialRecentBeta={recentBeta}
        gymSearch={<HomeGymSearch />}
        featureStrip={<HomeFeatureStrip />}
        supportBlock={<HomeSupportBlock />}
        trustFaq={
          <I18nProvider locale={locale} namespaces={['marketing']} resourceKeys={{ marketing: ['funding', 'trust'] }}>
            <TrustFaq limit={6} />
          </I18nProvider>
        }
        supportBanner={showSupportBanner ? <HomeSupportBanner /> : null}
      />
    </I18nProvider>
  );
}
