'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InstallMobileOutlined from '@mui/icons-material/InstallMobileOutlined';
import { track } from '@/app/lib/analytics';
import { APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties } from '@/app/lib/app-install-event';
import { buildStoreUrl, type StoreLinkInput } from '@/app/lib/store-links';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
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
   * Store button labels, already translated by the server component that
   * renders this island — same arrangement as `GymPageCtaLink`. Passing them in
   * keeps this island off the client i18n bundle for a page that is otherwise
   * server-rendered, and store button wording is the store's own localised
   * naming rather than our voice.
   */
  googlePlayLabel: string;
  appStoreLabel: string;
};

/**
 * The gym page's install CTA — the producer #4374's AC2 was waiting on.
 *
 * BOTH stores render, always. No platform sniffing: a `useEffect` that picks
 * one store leaves the server HTML with zero install links, so a crawler (and
 * anyone reading the page before hydration) sees nothing. Two real anchors with
 * real `href`s cost one extra button and keep the page complete without JS.
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
 *
 * TWO DELIBERATE VISUAL RULES, both of which look like polish and are not:
 *
 *  - NO MANUFACTURER GLYPH. An Apple mark or an Android robot beside our own
 *    text is not what either company's guidelines sanction — those cover the
 *    official "Download on the App Store" / "Get it on Google Play" badges, used
 *    whole. `home-page-content.tsx` sidesteps this the same way, putting the
 *    Boardsesh mark on its iOS card. One neutral install icon on both.
 *  - IDENTICAL VARIANTS. `App Install Click` exists to be broken down by
 *    platform (PH-13), so a filled Play button next to an outlined App Store one
 *    would tilt the split this CTA was built to measure.
 */
export default function GymInstallCta({ gymSlug, qrMedium, googlePlayLabel, appStoreLabel }: GymInstallCtaProps) {
  const inboundCampaign = useInboundCampaign();
  const storeLink: StoreLinkInput = { placement: 'gym-page', gymSlug, qrMedium, inbound: inboundCampaign };
  // Absent, not `null`, when there was no scan: the click payload of a plain
  // gym-page visit stays exactly what it was.
  const scanProperties = qrMedium ? { qrMedium } : {};

  const handlePlayClick = () => {
    track(
      APP_INSTALL_CLICK_EVENT,
      buildAppInstallClickProperties({
        platform: 'android',
        source: 'google-play',
        placement: 'gym-page',
        gymSlug,
        ...scanProperties,
      }),
    );
  };

  const handleAppStoreClick = () => {
    track(
      APP_INSTALL_CLICK_EVENT,
      buildAppInstallClickProperties({
        platform: 'ios',
        source: 'app-store',
        placement: 'gym-page',
        gymSlug,
        ...scanProperties,
      }),
    );
  };

  return (
    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
      <Button
        component="a"
        href={buildStoreUrl('android', storeLink)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handlePlayClick}
        variant="contained"
        startIcon={<InstallMobileOutlined />}
        sx={{ textTransform: 'none' }}
      >
        {googlePlayLabel}
      </Button>
      <Button
        component="a"
        href={buildStoreUrl('ios', storeLink)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleAppStoreClick}
        variant="contained"
        startIcon={<InstallMobileOutlined />}
        sx={{ textTransform: 'none' }}
      >
        {appStoreLabel}
      </Button>
    </Box>
  );
}
