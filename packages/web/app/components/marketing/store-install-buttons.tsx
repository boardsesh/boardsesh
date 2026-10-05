'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { resolveHeroInstall } from '@/app/lib/hero-install';
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
};

// Both halves of the brand pair come off the SAME size step, which is the whole
// reason they match.
const BRAND_PRIMARY_SX = brandCtaSx({ size: 'large' });
const BRAND_SECONDARY_SX = brandCtaOutlinedSx({ size: 'large' });
const PLAIN_SX = { textTransform: 'none' };

/**
 * The store button for the phone in the visitor's hand, on any www page (#6027).
 *
 * WHICH STORE. `useInstallPlatform` decides after hydration: Google Play on
 * Android, the App Store on an iPhone or iPad, both on a desktop. The server
 * render is not a guess about the visitor. It comes from the layout's own
 * classification, which is in the page payload, so a page served from the shared
 * CDN cache hydrates against the same markup it was rendered with, and the
 * effect then corrects the button for this visitor. A crawler, and anyone with
 * JavaScript off, always gets at least one real store anchor.
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
}: StoreInstallButtonsProps) {
  const inboundCampaign = useInboundCampaign();
  const { platform, nativeStore } = useInstallPlatform();
  const { stores, mode } = resolveHeroInstall(platform, nativeStore);

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
