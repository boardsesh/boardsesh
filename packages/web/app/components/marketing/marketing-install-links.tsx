'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import StoreInstallButtons from './store-install-buttons';

type MarketingInstallLinksProps = {
  /**
   * Which surface this store pair sits on. It names the click in PostHog and is
   * the link id in the store URL, so each surface has to pass its own.
   */
  placement: AppInstallPlacement;
};

/**
 * `StoreInstallButtons` for a client page that already ships the `marketing`
 * namespace (/help and its sub-pages). A server-rendered page passes the labels
 * in instead: see `getStoreButtonLabels`.
 */
export default function MarketingInstallLinks({ placement }: MarketingInstallLinksProps) {
  const { t } = useTranslation('marketing');
  return (
    <StoreInstallButtons
      placement={placement}
      labels={{
        ios: t('home.hero.ctaInstallIos'),
        android: t('home.hero.ctaInstallAndroid'),
        update: t('home.hero.ctaUpdate'),
      }}
    />
  );
}
