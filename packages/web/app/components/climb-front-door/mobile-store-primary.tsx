'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InstallMobileIcon from '@mui/icons-material/InstallMobile';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { useQrLandingMedium } from '@/app/hooks/use-qr-landing-medium';
import { resolveHeroInstall, type HeroInstallStore } from '@/app/lib/hero-install';
import { buildStoreUrl } from '@/app/lib/store-links';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { trackAppInstallClick } from '@/app/lib/track-app-install-click';

/** The wording, translated by the server page so this island needs no i18n bundle. */
export type MobileStorePrimaryLabels = {
  /** What both buttons say: "Get the free app". */
  install: string;
  /** For someone still on the retired Capacitor app, who needs an update and not an install. */
  update: string;
  /** Which store the button opens, for a screen reader: the two look the same. */
  installAria: Record<HeroInstallStore, string>;
};

type MobileStorePrimaryProps = {
  placement: AppInstallPlacement;
  labels: MobileStorePrimaryLabels;
  /** Which kind of code lands on this page, so the link id names it after a scan. */
  qrLanding?: QrLandingKind;
};

const STORES: readonly HeroInstallStore[] = ['ios', 'android'];

const BUTTON_SX = {
  ...brandCtaSx({ size: 'large', glow: true }),
  // Both anchors share the one cell, so swapping them cannot move anything.
  gridArea: '1 / 1',
  width: '100%',
};

/**
 * The store anchor that is NOT this visitor's is `display: none`. Before
 * hydration the browser picks with CSS alone: `-webkit-touch-callout` exists
 * only in Safari's engine on iOS and iPadOS, where every browser is Safari's
 * engine, so an iPhone shows the App Store from the first paint and everything
 * else shows Google Play. After mount `data-store` names the store
 * `useInstallPlatform` chose and wins over the guess.
 *
 * A guess that turns out wrong costs nothing visible: both anchors carry the
 * same words, the same icon and the same size in the same cell.
 */
const WRAPPER_SX = {
  display: 'grid',
  '&:not([data-store]) > [data-store-link="ios"]': { display: 'none' },
  '@supports (-webkit-touch-callout: none)': {
    '&:not([data-store]) > [data-store-link="ios"]': { display: 'inline-flex' },
    '&:not([data-store]) > [data-store-link="android"]': { display: 'none' },
  },
  '&[data-store="ios"] > [data-store-link="android"]': { display: 'none' },
  '&[data-store="android"] > [data-store-link="ios"]': { display: 'none' },
};

/**
 * The one filled button a phone sees on a climb page: "Get the free app", to
 * the store for the phone in the reader's hand.
 *
 * Why the store and not the hand-off: a phone with Boardsesh opens climb links
 * straight in the app, so a phone that is reading this page almost never has
 * it. Sending it to the browser app instead (the old primary) cannot light a
 * board on an iPhone, which has no Web Bluetooth.
 *
 * The page's HTML is stored at the edge and handed to everyone, so BOTH store
 * links are always in it, with no campaign and no `data-store`. The visitor's
 * store, their inbound campaign and a scanned code's medium all arrive after
 * mount, like `StoreInstallButtons`' `sharedHtml` mode. Unlike that pair, the
 * two anchors stack in one grid cell and CSS picks one before hydration, so the
 * phone never sees two buttons, and the pick cannot shift the layout.
 *
 * The click only adds the event; the link opens in a new tab, so the document
 * stays and a plain `track()` lands.
 */
export default function MobileStorePrimary({ placement, labels, qrLanding }: MobileStorePrimaryProps) {
  const inboundCampaign = useInboundCampaign();
  const qrMedium = useQrLandingMedium(qrLanding ?? null);
  const { platform, nativeStore } = useInstallPlatform();
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);

  // `unknown` is still waiting for a Capacitor bridge; the CSS guess stands until it answers.
  const decided = hasMounted && platform !== 'unknown';
  const { stores, mode } = resolveHeroInstall(platform, nativeStore);
  const chosenStore = decided ? stores[0] : undefined;

  return (
    <Box sx={WRAPPER_SX} data-store={chosenStore}>
      {STORES.map((store) => (
        <Button
          key={store}
          data-store-link={store}
          href={buildStoreUrl(store, { placement, inbound: inboundCampaign, qrMedium })}
          target="_blank"
          rel="noopener noreferrer"
          variant="contained"
          startIcon={<InstallMobileIcon aria-hidden />}
          aria-label={decided && mode === 'update' ? undefined : labels.installAria[store]}
          sx={BUTTON_SX}
          onClick={() => {
            trackAppInstallClick({
              platform: store,
              source: store === 'ios' ? 'app-store' : 'google-play',
              placement,
              mode: decided ? mode : 'install',
              ...(qrMedium ? { qrMedium } : {}),
            });
          }}
        >
          {decided && mode === 'update' ? labels.update : labels.install}
        </Button>
      ))}
    </Box>
  );
}
