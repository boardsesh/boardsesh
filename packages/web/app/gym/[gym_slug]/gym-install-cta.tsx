'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Android from '@mui/icons-material/Android';
import Apple from '@mui/icons-material/Apple';
import { track } from '@/app/lib/analytics';
import { APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties } from '@/app/lib/app-install-event';
import { playStoreUrlForGym } from '@/app/lib/gym-attribution';
import { IOS_APP_STORE_URL } from '@/app/lib/store-urls';

type GymInstallCtaProps = {
  /**
   * The CANONICAL gym slug, not the slug in the address bar. A poster printed
   * for a since-merged gym 308s onto the canonical slug, and the campaign value
   * has to be the same string either way or one gym's installs land in two
   * campaigns.
   */
  gymSlug: string;
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
 * Only the Play link carries attribution. Play reads it back through the
 * Install Referrer API; Apple has no equivalent here and iOS attribution is
 * explicitly out of scope (#3402), so the App Store URL is unchanged.
 */
export default function GymInstallCta({ gymSlug, googlePlayLabel, appStoreLabel }: GymInstallCtaProps) {
  const handlePlayClick = () => {
    track(
      APP_INSTALL_CLICK_EVENT,
      buildAppInstallClickProperties({
        platform: 'android',
        source: 'google-play',
        placement: 'gym-page',
        gymSlug,
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
      }),
    );
  };

  return (
    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
      <Button
        component="a"
        href={playStoreUrlForGym(gymSlug)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handlePlayClick}
        variant="contained"
        startIcon={<Android />}
        sx={{ textTransform: 'none' }}
      >
        {googlePlayLabel}
      </Button>
      <Button
        component="a"
        href={IOS_APP_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleAppStoreClick}
        variant="outlined"
        startIcon={<Apple />}
        sx={{ textTransform: 'none' }}
      >
        {appStoreLabel}
      </Button>
    </Box>
  );
}
