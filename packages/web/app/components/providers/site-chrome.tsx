'use client';

import React from 'react';
import ConsentBanner from '../consent/consent-banner';
import { StatsFilterBridgeProvider } from '../stats-filter-bridge/stats-filter-bridge-context';
import { ProfileHeaderShareProvider } from '../profile-header-bridge/profile-header-bridge-context';
import MarketingHeader from '../site-chrome/marketing-header';
import SiteFooter from '../site-chrome/site-footer';
import ChineseTranslationOnboarding from '../i18n/chinese-translation-onboarding';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';

/**
 * Application chrome for request-dependent www pages. Static marketing routes
 * use their own MarketingChrome and asynchronous account controls.
 *
 *  - `StatsFilterBridgeProvider` — the profile/`/you` statistics filter button
 *    in the header talks to the page through this bridge.
 *  - `ProfileHeaderShareProvider` — the viewed-profile share button, same shape.
 * Both bridges mount only for profile pages.
 * Playlist pages inject their own transport and need no global adapter.
 *
 * AuthModalProvider remains in ApplicationProviderStack above SiteChrome.
 */
export default function SiteChrome({
  children,
  developerHref,
}: {
  children: React.ReactNode;
  developerHref?: '/developers' | '/docs';
}) {
  const pathname = usePathnameWithoutLocale();
  const chrome = (
    <>
      <MarketingHeader />
      {children}
      <SiteFooter developerHref={developerHref} />
      <ConsentBanner>{(consentRegion) => <ChineseTranslationOnboarding consentRegion={consentRegion} />}</ConsentBanner>
    </>
  );
  if (!pathname.startsWith('/profile/')) return chrome;
  return (
    <StatsFilterBridgeProvider>
      <ProfileHeaderShareProvider>{chrome}</ProfileHeaderShareProvider>
    </StatsFilterBridgeProvider>
  );
}
