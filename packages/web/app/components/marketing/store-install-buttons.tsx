'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import SystemUpdateOutlined from '@mui/icons-material/SystemUpdateOutlined';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { useQrLandingMedium } from '@/app/hooks/use-qr-landing-medium';
import { resolveHeroInstall, type HeroInstall } from '@/app/lib/hero-install';
import { buildStoreUrl } from '@/app/lib/store-links';
import { brandCtaSx, brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { type AppInstallPlacement } from '@/app/lib/app-install-event';
import { trackAppInstallClick } from '@/app/lib/track-app-install-click';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import type { Locale } from '@/app/lib/i18n/config';
import StoreBadgeLink, { LONE_BADGE_HEIGHT, PAIRED_BADGE_HEIGHT } from './store-badge-link';

/**
 * The three things a store link can say, already translated by whoever
 * renders the island. Passed in rather than read with `useTranslation` so the
 * island works on pages whose client i18n bundle has no `marketing` namespace:
 * the climb front doors and the gym directory. See `getStoreButtonLabels`.
 */
export type StoreButtonLabels = {
  /** The App Store badge's own words in this language ("Download on the App Store"): its image's alt text. */
  ios: string;
  /** The Google Play badge's own words ("Get it on Google Play"): its image's alt text. */
  android: string;
  /** For someone still on the retired Capacitor app, who needs an update and not an install. */
  update: string;
  /**
   * The language these words are in, which picks the badge artwork too. Carried
   * here rather than read from `useTranslation()` in the island: whoever
   * translated the words already knows it, and a bare `useTranslation()` can
   * suspend on a page that loaded no default namespace.
   */
  locale: Locale;
};

/**
 * How the UPDATE button looks. An install is always the official store badge,
 * whatever the appearance; only a visitor still on the retired Capacitor app
 * gets a text button ("Update the app"), since "Download on the App Store"
 * would be the wrong words for them.
 *
 * `brand` is the violet pair of the marketing pages: filled first, outlined
 * second. `plain` is for a page that already has a filled primary action next
 * to it (the climb front door's "Climb this"): outlined, so the page keeps one
 * primary. `brand-outlined` is the brand button, outlined and with the update
 * icon: a page's second store block that should look like the brand's without
 * adding a filled button (the climb page's app module).
 */
export type StoreButtonAppearance = 'brand' | 'plain' | 'brand-outlined';

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
  /**
   * Which kind of code lands on this page: `board` on a page a printed board
   * code lands on (`/b/{slug}/{angle}/list`), `climb` on a climb page, whose
   * desktop layout shows a code for the phone. After a scan, the link id and
   * the click say which code it was (`spray-wall.board`, `climb-view.desktop`),
   * read in the browser after mount, so the shared HTML stays the same for
   * everyone. Leave it out on a page no code points at.
   */
  qrLanding?: QrLandingKind;
};

/** What a shared page says before the browser has been asked: both stores, App Store first. */
const SHARED_HTML_INSTALL: HeroInstall = { mode: 'install', stores: ['ios', 'android'] };

// Both halves of the brand pair come off the SAME size step, which is the whole
// reason they match.
const BRAND_PRIMARY_SX = brandCtaSx({ size: 'large' });
const BRAND_SECONDARY_SX = brandCtaOutlinedSx({ size: 'large' });
const PLAIN_SX = { textTransform: 'none' };

/**
 * The official store badge for the phone in the visitor's hand, on any www
 * page (#6027). A text button only in update mode.
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
 * the server), which is what keeps the cached HTML the same for everyone. On a
 * page a printed board code lands on (`qrLanding`), the code's medium is added
 * the same way, after hydration.
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
  qrLanding,
}: StoreInstallButtonsProps) {
  const inboundCampaign = useInboundCampaign();
  const qrMedium = useQrLandingMedium(qrLanding ?? null);
  const { platform, nativeStore } = useInstallPlatform();
  // Flips in the same commit as `useInstallPlatform`'s own effect, so the pair
  // goes straight from both stores to this visitor's, with no frame in between
  // showing the store the layout guessed.
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);
  const { stores, mode } = sharedHtml && !hasMounted ? SHARED_HTML_INSTALL : resolveHeroInstall(platform, nativeStore);
  // Whether the FIRST render, the one in the server HTML, showed one store. A
  // pair that narrows after mount keeps the pair's look: an iPad's Safari sends
  // a Mac user agent, so its server render is a desktop pair, and only the
  // browser's touch points say iPad. Without this the App Store badge would
  // turn white and grow as Google Play disappears.
  const [firstRenderWasLone] = useState(stores.length === 1);
  const justifyContent = align === 'center' ? 'center' : 'flex-start';

  const trackClick = (store: 'ios' | 'android') => {
    trackAppInstallClick({
      platform: store,
      source: store === 'ios' ? 'app-store' : 'google-play',
      placement,
      mode,
      ...(qrMedium ? { qrMedium } : {}),
    });
  };

  if (mode === 'install') {
    // A lone badge on a page rendered for this visitor is the phone's install
    // action: a size up, and on an iPhone the white App Store badge, which reads
    // far better on the dark page and which Apple allows only when it stands
    // alone. A badge that started as one of a pair keeps the paired size and the
    // black artwork: shared HTML starts as a pair for everyone, and so does an
    // iPad's server render, and a badge that grew or turned white at hydration
    // would jump.
    const isLoneBadge = stores.length === 1 && firstRenderWasLone && !sharedHtml;
    const badgeHeight = isLoneBadge ? LONE_BADGE_HEIGHT : PAIRED_BADGE_HEIGHT;
    return (
      // 12px between badges is more than the quarter-height clear space both stores ask for.
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, justifyContent }}>
        {stores.map((store) => (
          <StoreBadgeLink
            key={store}
            store={store}
            href={buildStoreUrl(store, { placement, inbound: inboundCampaign, qrMedium })}
            labels={labels}
            height={badgeHeight}
            tone={isLoneBadge ? 'white' : 'black'}
            onClick={() => trackClick(store)}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent }}>
      {stores.map((store, index) => {
        const isPrimary = appearance === 'brand' && index === 0;
        const brandSx = isPrimary ? BRAND_PRIMARY_SX : BRAND_SECONDARY_SX;
        const usesBrandSize = appearance !== 'plain';
        return (
          <Button
            key={store}
            href={buildStoreUrl(store, { placement, inbound: inboundCampaign, qrMedium })}
            target="_blank"
            rel="noopener noreferrer"
            variant={isPrimary ? 'contained' : 'outlined'}
            // The brand recipe carries its own size step; the plain one takes MUI's.
            size={usesBrandSize ? undefined : 'large'}
            sx={usesBrandSize ? brandSx : PLAIN_SX}
            startIcon={appearance === 'brand-outlined' ? <SystemUpdateOutlined aria-hidden /> : undefined}
            onClick={() => trackClick(store)}
          >
            {labels.update}
          </Button>
        );
      })}
    </Box>
  );
}
