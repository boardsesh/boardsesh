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
 * Root chrome for www.
 *
 * Replaces the old `PersistentSessionWrapper`, which mounted the whole
 * interactive climbing stack — a party-session WebSocket, the queue bridge, the
 * BLE provider, the queue control bar and the bottom tab bar — on *every*
 * route, `/about` and `/legal` included. Climbing lives in the app now, so the
 * root keeps only what the surviving marketing and account surfaces need:
 *
 *  - `StatsFilterBridgeProvider` — the profile/`/you` statistics filter button
 *    in the header talks to the page through this bridge.
 *  - `ProfileHeaderShareProvider` — the viewed-profile share button, same shape.
 * Playlist pages inject their own transport and need no global adapter.
 *
 * `AuthModalProvider` deliberately stays where it already is in
 * `app/layout.tsx` — it was never inside the old wrapper, and moving it under
 * `FeatureFlagsProvider` would reorder providers for no gain.
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
