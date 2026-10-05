'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { resolveHeroInstall, type HeroInstall } from '@/app/lib/hero-install';
import { buildStoreUrl } from '@/app/lib/store-links';
import { brandCtaSx, brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { track } from '@/app/lib/analytics';
import {
  APP_INSTALL_CLICK_EVENT,
  buildAppInstallClickProperties,
  type AppInstallPlacement,
} from '@/app/lib/app-install-event';

/**
 * The three things a store button can say, already translated by whoever
 * renders the island. Passed in rather than read with `useTranslation` so the
 * island works on pages whose client i18n bundle has no `marketing` namespace:
 * the climb front doors and the gym directory. See `getStoreButtonLabels`.
 */
export type StoreButtonLabels = {
  ios: string;
  android: string;
  /** For someone still on the retired Capacitor app, who needs an update and not an install. */
  update: string;
};

/**
 * `brand` is the violet pill pair of the marketing pages: filled first, outlined
 * second. `plain` is for a page that already has a filled primary action next
 * to it (the climb front door's "Climb this"): every store button is outlined,
 * so the page keeps one primary, and on a desktop both stores weigh the same.
 */
export type StoreButtonAppearance = 'brand' | 'plain';

type StoreInstallButtonsProps = {
  /**
   * Which surface this is. It names the click in PostHog and is the link id in
   * the store URL, so each surface passes its own.
   */
  placement: AppInstallPlacement;
  labels: StoreButtonLabels;
  appearance?: StoreButtonAppearance;
  align?: 'center' | 'start';
  /**
   * Set on a page whose HTML is stored once at the edge and handed to everyone:
   * the climb, list and spray climb front doors. The server render and the
   * hydration render then carry BOTH stores, whoever asked for the page, and
   * the pair narrows to this visitor's store only after mount.
   */
  sharedHtml?: boolean;
};

/** What a shared page says before the browser has been asked: both stores, App Store first. */
const SHARED_HTML_INSTALL: HeroInstall = { mode: 'install', stores: ['ios', 'android'] };

// Both halves of the brand pair come off the SAME size step, which is the whole
// reason they match.
const BRAND_PRIMARY_SX = brandCtaSx({ size: 'large' });
const BRAND_SECONDARY_SX = brandCtaOutlinedSx({ size: 'large' });
const PLAIN_SX = { textTransform: 'none' };

/**
 * The store button for the phone in the visitor's hand, on any www page (#6027).
 *
 * WHICH STORE. `useInstallPlatform` decides after hydration: Google Play on
 * Android, the App Store on an iPhone or iPad, both on a desktop.
 *
 * The first render is seeded from the root layout's reading of the REQUEST's
 * user agent. That is right for a page rendered per request (/gyms, /help), and
 * wrong for one the edge stores for 24 hours with no user-agent split: the
 * stored HTML would carry the store of whoever asked first, and Googlebot
 * Smartphone, whose user agent says Android, asks first for most climb pages.
 * An iPhone reader would then get a lone Google Play link until hydration, and
 * for good with JavaScript off. `sharedHtml` is for those pages: the seed is
 * ignored and both stores are in the markup until the effect has run, so a
 * crawler, a reader with JavaScript off and the hydration render all get the
 * same two real anchors.
 *
 * WHERE THE LINK SAYS IT CAME FROM. `buildStoreUrl` with this surface's
 * placement, the one link format www has. A visitor who arrived on a tagged
 * link has that source added after hydration (`useInboundCampaign` is `null` on
 * the server), which is what keeps the cached HTML the same for everyone.
 *
 * The click handler only adds the event. It never calls `preventDefault`, and
 * the link opens a new tab, so the document stays and a plain `track()` lands.
 */
export default function StoreInstallButtons({
  placement,
  labels,
  appearance = 'brand',
  align = 'center',
  sharedHtml = false,
}: StoreInstallButtonsProps) {
  const inboundCampaign = useInboundCampaign();
  const { platform, nativeStore } = useInstallPlatform();
  // Flips in the same commit as `useInstallPlatform`'s own effect, so the pair
  // goes straight from both stores to this visitor's, with no frame in between
  // showing the store the layout guessed.
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);
  const { stores, mode } = sharedHtml && !hasMounted ? SHARED_HTML_INSTALL : resolveHeroInstall(platform, nativeStore);

  return (
    <Box
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: align === 'center' ? 'center' : 'flex-start' }}
    >
      {stores.map((store, index) => {
        const isPrimary = appearance === 'brand' && index === 0;
        const brandSx = isPrimary ? BRAND_PRIMARY_SX : BRAND_SECONDARY_SX;
        return (
          <Button
            key={store}
            href={buildStoreUrl(store, { placement, inbound: inboundCampaign })}
            target="_blank"
            rel="noopener noreferrer"
            variant={isPrimary ? 'contained' : 'outlined'}
            // The brand recipe carries its own size step; the plain one takes MUI's.
            size={appearance === 'brand' ? undefined : 'large'}
            sx={appearance === 'brand' ? brandSx : PLAIN_SX}
            onClick={() => {
              track(
                APP_INSTALL_CLICK_EVENT,
                buildAppInstallClickProperties({
                  platform: store,
                  source: store === 'ios' ? 'app-store' : 'google-play',
                  placement,
                  mode,
                }),
              );
            }}
          >
            {mode === 'update' ? labels.update : labels[store]}
          </Button>
        );
      })}
    </Box>
  );
}
