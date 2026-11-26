import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import type { Locale } from '@/app/lib/i18n/config';
import SiteJsonLd from '@/app/components/seo/site-json-ld';
import ShowcaseVideoJsonLd from '@/app/components/seo/showcase-video-json-ld';
import HomePageContent from '@/app/home-page-content';
import MarketingTrustFaq from '@/app/components/marketing/marketing-trust-faq';
import HomeGymSearch from '@/app/components/home/home-gym-search';
import { cachedCommunityStats } from '@/app/lib/graphql/server-cached-client';
import { formatCommunityProof } from '@/app/lib/community-proof';
import HomeFeatureStrip from '@/app/components/home/home-feature-strip';
import HomeSupportBlock from '@/app/components/home/home-support-block';
import RuntimeHomeSupportBanner from '@/app/components/home/runtime-home-support-banner';
import PhoneQrCard from '@/app/components/climb-front-door/phone-qr-card';
import QrLandingTracker from '@/app/components/climb-front-door/qr-landing-tracker';
import { homeQrUrl } from '@/app/lib/gym-attribution';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { SMART_APP_BANNER_META_NAME, smartAppBannerContent } from '@/app/lib/smart-app-banner';

export async function getHomePageMetadata(locale: Locale) {
  const { t } = await getServerTranslationForLocale(locale, 'marketing');
  return {
    ...createPageMetadata({
      title: t('metadata.home.title'),
      description: t('metadata.home.description'),
      ogTitle: t('metadata.home.ogTitle'),
      ogDescription: t('metadata.home.ogDescription'),
      path: '/',
      locale,
      // "Climbing App That Works with Kilter, Tension & MoonBoard" is 56 characters:
      // the suffix would only cut the board names off the result.
      brandSuffix: 'if-fits',
    }),
    other: { [SMART_APP_BANNER_META_NAME]: smartAppBannerContent('/', locale)! },
  };
}

export default async function HomePage({ locale }: { locale: Locale }) {
  const [communityStats, storeLabels] = await Promise.all([cachedCommunityStats(), getStoreButtonLabels(locale)]);

  // Formatted here rather than in the client hero: the numbers are server data,
  // and `Intl.NumberFormat` on the locale we already resolved keeps 132,341 from
  // rendering as 132341 in English or 132.341 in German by accident.
  const { t } = await getServerTranslationForLocale(locale, 'marketing');
  const heroProof = communityStats ? formatCommunityProof(communityStats, t, locale) : undefined;

  return (
    <>
      {/* The English hero preloads its poster on desktop; the localized app
          captures and below-fold thumbnails keep their default lazy loading. */}
      <SiteJsonLd locale={locale} />
      {/* The hero video is English-only (its text is burned in), so only the
          English page describes it to crawlers. */}
      {locale === 'en-US' ? <ShowcaseVideoJsonLd /> : null}
      {/* Counts a phone that scanned the hero's laptop code as `Home QR Scanned`. */}
      <QrLandingTracker kind="home" boardType={null} />
      {/* Static copy is translated on the server; interactive controls receive labels. */}
      <HomePageContent
        locale={locale}
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
        gymSearch={<HomeGymSearch locale={locale} />}
        featureStrip={<HomeFeatureStrip locale={locale} />}
        supportBlock={<HomeSupportBlock locale={locale} />}
        trustFaq={<MarketingTrustFaq locale={locale} limit={6} />}
        supportBanner={
          <RuntimeHomeSupportBanner
            copy={{
              text: t('home.supportBanner.text'),
              cta: t('home.supportBanner.cta'),
              close: t('home.supportBanner.close'),
            }}
          />
        }
      />
    </>
  );
}
