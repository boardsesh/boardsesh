'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LOCALE, isSupportedLocale } from '@/app/lib/i18n/config';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import StoreInstallButtons from './store-install-buttons';

type MarketingInstallLinksProps = {
  /**
   * Which surface this store pair sits on. It names the click in PostHog and is
   * the link id in the store URL, so each surface has to pass its own.
   */
  placement: AppInstallPlacement;
  /** Centred by default; `start` lines the pair up with left-aligned copy. */
  align?: 'center' | 'start';
};

/**
 * `StoreInstallButtons` for a client page that already ships the `marketing`
 * namespace (/help and its sub-pages). A server-rendered page passes the labels
 * in instead: see `getStoreButtonLabels`.
 */
export default function MarketingInstallLinks({ placement, align }: MarketingInstallLinksProps) {
  const { t, i18n } = useTranslation('marketing');
  return (
    <StoreInstallButtons
      placement={placement}
      align={align}
      labels={{
        ios: t('home.hero.ctaInstallIos'),
        android: t('home.hero.ctaInstallAndroid'),
        update: t('home.hero.ctaUpdate'),
        locale: isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE,
      }}
    />
  );
}
