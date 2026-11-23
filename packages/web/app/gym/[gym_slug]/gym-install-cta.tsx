'use client';

import React from 'react';
import Box from '@mui/material/Box';
import { trackAppInstallClick } from '@/app/lib/track-app-install-click';
import { buildStoreUrl, type StoreLinkInput } from '@/app/lib/store-links';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import StoreBadgeLink, { PAIRED_BADGE_HEIGHT } from '@/app/components/marketing/store-badge-link';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { GymQrMedium } from '@boardsesh/analytics';

type GymInstallCtaProps = {
  /**
   * The CANONICAL gym slug, not the slug in the address bar. A poster printed
   * for a since-merged gym 308s onto the canonical slug, and the campaign value
   * has to be the same string either way or one gym's installs land in two
   * campaigns.
   */
  gymSlug: string;
  /**
   * The printed medium this page was reached through, parsed by the server from
   * `?src=qr&medium=…`, or `null` for a visit that did not come off a code. It
   * arrives as a prop because `GymQrLandingTracker` strips those params from the
   * address bar on mount, so reading them here would lose the scan.
   */
  qrMedium?: GymQrMedium | null;
  /**
   * The badges' own words (their alt text) and the page's language, which picks
   * the artwork: `getStoreButtonLabels()` in the server component that renders
   * this island, so it stays off the client i18n bundle.
   */
  labels: StoreButtonLabels;
};

/**
 * The gym page's install CTA — the producer #4374's AC2 was waiting on.
 *
 * BOTH stores render, always, as the official App Store and Google Play badges,
 * black and 44px tall, App Store first: the pair rule in "Store badges"
 * (docs/web/public-page-design.md). No platform sniffing: a `useEffect` that
 * picks one store leaves the server HTML with zero install links, so a crawler
 * (and anyone reading the page before hydration) sees nothing. Two real anchors
 * with real `href`s cost one extra badge and keep the page complete without JS.
 * The two badges are the same height and neither is styled as the primary, so
 * the look does not tilt the per-platform split `App Install Click` exists to
 * measure (PH-13).
 *
 * The click handler only adds the event — it never calls `preventDefault`, so
 * middle-click, long-press and "copy link" behave like the plain anchors these
 * are. Both open in a new tab, so the document is not unloading and a plain
 * `track()` lands without a flush-before-navigation dance.
 *
 * Both links say where they came from, through `buildStoreUrl` (#6027). A
 * click on the page reports `utm_medium=web`; a click after scanning a printed
 * code reports `utm_medium=qr` and names the code in the link id
 * (`gym-page.poster`), so a poster's installs can be told from the page's own.
 * Play reads its copy back through the Install Referrer API, per install. The
 * App Store gets a campaign token that App Analytics counts in aggregate.
 *
 * The server renders the link for the scan (or no scan) it saw. A visitor who
 * arrived on a tagged link gets that source added after hydration.
 */
export default function GymInstallCta({ gymSlug, qrMedium, labels }: GymInstallCtaProps) {
  const inboundCampaign = useInboundCampaign();
  const storeLink: StoreLinkInput = { placement: 'gym-page', gymSlug, qrMedium, inbound: inboundCampaign };
  // Absent, not `null`, when there was no scan: the click payload of a plain
  // gym-page visit stays exactly what it was.
  const scanProperties = qrMedium ? { qrMedium } : {};

  const handlePlayClick = () => {
    trackAppInstallClick({
      platform: 'android',
      source: 'google-play',
      placement: 'gym-page',
      gymSlug,
      ...scanProperties,
    });
  };

  const handleAppStoreClick = () => {
    trackAppInstallClick({
      platform: 'ios',
      source: 'app-store',
      placement: 'gym-page',
      gymSlug,
      ...scanProperties,
    });
  };

  return (
    // 12px between badges is more than the quarter-height clear space both stores ask for.
    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
      <StoreBadgeLink
        store="ios"
        href={buildStoreUrl('ios', storeLink)}
        labels={labels}
        height={PAIRED_BADGE_HEIGHT}
        onClick={handleAppStoreClick}
      />
      <StoreBadgeLink
        store="android"
        href={buildStoreUrl('android', storeLink)}
        labels={labels}
        height={PAIRED_BADGE_HEIGHT}
        onClick={handlePlayClick}
      />
    </Box>
  );
}
