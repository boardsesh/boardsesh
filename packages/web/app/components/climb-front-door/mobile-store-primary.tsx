'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { useQrLandingMedium } from '@/app/hooks/use-qr-landing-medium';
import { resolveHeroInstall, type HeroInstallStore } from '@/app/lib/hero-install';
import { buildStoreUrl } from '@/app/lib/store-links';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import StoreBadgeLink, { LONE_BADGE_HEIGHT } from '@/app/components/marketing/store-badge-link';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { trackAppInstallClick } from '@/app/lib/track-app-install-click';

type MobileStorePrimaryProps = {
  placement: AppInstallPlacement;
  /** The badges' own words (their alt text) and the page's language, translated by the server page. */
  labels: StoreButtonLabels;
  /** Which kind of code lands on this page, so the link id names it after a scan. */
  qrLanding?: QrLandingKind;
};

const STORES: readonly HeroInstallStore[] = ['ios', 'android'];

/** Both anchors share the one cell, so swapping them cannot move anything. */
const CELL_SX = { gridArea: '1 / 1' };

const UPDATE_BUTTON_SX = { ...brandCtaSx({ size: 'large' }), ...CELL_SX };

/**
 * The store anchor that is NOT this visitor's is `display: none`. Before
 * hydration the browser picks with CSS alone: `-webkit-touch-callout` exists
 * only in Safari's engine on iOS and iPadOS, where every browser is Safari's
 * engine, so an iPhone shows the App Store from the first paint and everything
 * else shows Google Play. After mount, when `useInstallPlatform` names ONE
 * store (a phone, or the retired app's update), `data-store` names it and wins
 * over the guess. A desktop browser narrower than md names both stores, so it
 * gets no `data-store` and the CSS guess stands: no badge swaps under the
 * reader at hydration.
 *
 * The cell is centred, like the helper line under it: a badge keeps its own
 * width, never stretched.
 */
const WRAPPER_SX = {
  display: 'grid',
  justifyItems: 'center',
  '&:not([data-store]) > [data-store-link="ios"]': { display: 'none' },
  '@supports (-webkit-touch-callout: none)': {
    '&:not([data-store]) > [data-store-link="ios"]': { display: 'inline-flex' },
    '&:not([data-store]) > [data-store-link="android"]': { display: 'none' },
  },
  '&[data-store="ios"] > [data-store-link="android"]': { display: 'none' },
  '&[data-store="android"] > [data-store-link="ios"]': { display: 'none' },
};

/**
 * The phone's one store link on a climb, board-list or playlist page: the
 * official badge for the store of the phone in the reader's hand.
 *
 * Why the store and not the hand-off: a phone with Boardsesh opens climb links
 * straight in the app, so a phone that is reading this page almost never has
 * it. Sending it to the browser app instead (the old primary) cannot light a
 * board on an iPhone, which has no Web Bluetooth.
 *
 * The page's HTML is stored at the edge and handed to everyone, so BOTH store
 * badges are always in it, with no campaign and no `data-store`. The visitor's
 * store, their inbound campaign and a scanned code's medium all arrive after
 * mount, like `StoreInstallButtons`' `sharedHtml` mode. Unlike that pair, the
 * two anchors stack in one grid cell and CSS picks one before hydration, so the
 * phone never sees two badges, and the pick cannot shift the layout.
 *
 * BLACK, 48PX. The CSS above shows exactly one of the two anchors, so this is
 * the lone badge's 48px. It is still the black badge: the same page shows
 * another store pair further down (the climb page's app module, the board
 * list's QR card), and Apple allows its white badge only when it is the one
 * store badge on the page. The badges' markup never changes at hydration; only
 * `data-store` may arrive, and only when the platform names one store.
 *
 * A visitor still in the retired Capacitor app gets a filled "Update the app"
 * button after mount instead: "Download on the App Store" would be the wrong
 * words for them.
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
  // Only a platform that names one store overrides the CSS guess. A desktop
  // window under md names both, and swapping its Google Play guess for the App
  // Store badge would change the badge, and its width, under the reader.
  const namesOneStore = stores.length === 1 || mode === 'update';
  const chosenStore = decided && namesOneStore ? stores[0] : undefined;
  const asksForUpdate = decided && mode === 'update';

  return (
    <Box sx={WRAPPER_SX} data-store={chosenStore}>
      {STORES.map((store) => {
        const href = buildStoreUrl(store, { placement, inbound: inboundCampaign, qrMedium });
        const trackClick = () => {
          trackAppInstallClick({
            platform: store,
            source: store === 'ios' ? 'app-store' : 'google-play',
            placement,
            mode: decided ? mode : 'install',
            ...(qrMedium ? { qrMedium } : {}),
          });
        };
        if (asksForUpdate) {
          return (
            <Button
              key={store}
              data-store-link={store}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              variant="contained"
              sx={UPDATE_BUTTON_SX}
              onClick={trackClick}
            >
              {labels.update}
            </Button>
          );
        }
        return (
          <StoreBadgeLink
            key={store}
            store={store}
            href={href}
            labels={labels}
            height={LONE_BADGE_HEIGHT}
            onClick={trackClick}
            sx={CELL_SX}
            data-store-link={store}
          />
        );
      })}
    </Box>
  );
}
