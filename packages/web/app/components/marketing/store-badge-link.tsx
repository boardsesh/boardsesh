'use client';

import React from 'react';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';
import type { HeroInstallStore } from '@/app/lib/hero-install';
import { DEFAULT_LOCALE, type Locale, isSupportedLocale } from '@/app/lib/i18n/config';
import { storeBadgeImage, type AppStoreBadgeTone } from '@/app/lib/store-badges';
import type { StoreButtonLabels } from './store-install-buttons';

/**
 * Badge heights. A lone badge is the phone's one install action, so it is a
 * size up; a pair stays at 44 so two of them fit a 280px column (the QR card's
 * text column) side by side. Both clear the 44px target and Apple's 40px floor.
 */
export const LONE_BADGE_HEIGHT = 48;
export const PAIRED_BADGE_HEIGHT = 44;

/**
 * The anchor around a badge. The badge already draws its own edge, so the
 * anchor adds nothing but a focus ring shaped to its corners. Hover changes
 * nothing: the stores ask that their artwork not be altered.
 */
const BADGE_LINK_SX = {
  display: 'inline-flex',
  flexShrink: 0,
  lineHeight: 0,
  borderRadius: '8px',
  '&:focus-visible': {
    outline: '2px solid var(--color-primary)',
    outlineOffset: '2px',
  },
  '& > img': { display: 'block' },
} as const;

type StoreBadgeLinkProps = {
  store: HeroInstallStore;
  /** The store URL, already built by the caller with `buildStoreUrl` and its own placement. */
  href: string;
  /** The badge's own words (its alt text) and the language that picks the artwork. */
  labels: StoreButtonLabels;
  /** `LONE_BADGE_HEIGHT` or `PAIRED_BADGE_HEIGHT`. */
  height: number;
  /**
   * The App Store badge's colour. `white` only where this is the one store
   * badge visible on the layout; Google Play has one badge and ignores it.
   */
  tone?: AppStoreBadgeTone;
  /** Adds the click event; never prevents the navigation. */
  onClick: () => void;
  /** Where the anchor sits in its parent (a grid cell, say). Never anything that alters the badge. */
  sx?: SxProps<Theme>;
  /** For a parent that shows one store with CSS: `MobileStorePrimary`'s stacked cell. */
  'data-store-link'?: HeroInstallStore;
};

/**
 * One official store badge as a link: the artwork Apple or Google publishes, in
 * the page's language, unaltered ("Store badges" in
 * docs/web/public-page-design.md). Every www store badge goes through here, so
 * the rules live in one place.
 *
 * `data-store-badge` names the store on every badge anchor, for anything that
 * needs to find the page's badges (`main a[data-store-badge]`).
 *
 * The link opens a new tab, so the document stays and the click's `track()`
 * lands without a flush.
 */
export default function StoreBadgeLink({
  store,
  href,
  labels,
  height,
  tone = 'black',
  onClick,
  sx,
  'data-store-link': dataStoreLink,
}: StoreBadgeLinkProps) {
  // A caller that lost the locale (a test double, say) gets English artwork, never a broken image.
  const locale: Locale = isSupportedLocale(labels.locale) ? labels.locale : DEFAULT_LOCALE;
  const badge = storeBadgeImage(store, locale, height, tone);
  return (
    <Box
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-store-badge={store}
      data-store-link={dataStoreLink}
      sx={[BADGE_LINK_SX, ...(Array.isArray(sx) ? sx : [sx])]}
      onClick={onClick}
    >
      {/* A plain <img>, not MUI's Box: Box reads `width` and `height` as
          style props and drops them from the HTML, and the attributes
          are what reserve the badge's box before the SVG loads.
          Lazy, because most badges sit far down a page, and because an
          eager <img> makes React's server render add a
          <link rel="preload"> for it: two per page, competing with the
          page's own hero image and using up React's first ten image
          preloads. A lazy image already on screen still starts loading
          at first layout, so the phone hero's badge is not held back. */}
      <img
        src={badge.src}
        alt={labels[store]}
        width={badge.width}
        height={badge.height}
        loading="lazy"
        decoding="async"
      />
    </Box>
  );
}
