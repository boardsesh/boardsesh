'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useTranslation } from 'react-i18next';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { resolveHeroInstall } from '@/app/lib/hero-install';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { buildStoreUrl } from '@/app/lib/store-links';
import { brandCtaSx, brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { track } from '@/app/lib/analytics';
import {
  APP_INSTALL_CLICK_EVENT,
  buildAppInstallClickProperties,
  type AppInstallPlacement,
} from '@/app/lib/app-install-event';

// The store pair, hoisted: both halves come off the SAME size step, which is the
// whole reason they match. They previously did not — the outlined half carried
// its own px/fontSize and rendered visibly smaller than the filled one.
const PRIMARY_STORE_SX = brandCtaSx({ size: 'large' });
const SECONDARY_STORE_SX = brandCtaOutlinedSx({ size: 'large' });

type MarketingInstallLinksProps = {
  /**
   * Which surface this store pair sits on. It names the click in PostHog and is
   * the link id in the store URL, so each surface has to pass its own.
   */
  placement: AppInstallPlacement;
};

export default function MarketingInstallLinks({ placement }: MarketingInstallLinksProps) {
  const { t } = useTranslation('marketing');
  const inboundCampaign = useInboundCampaign();
  const { platform, nativeStore } = useInstallPlatform();
  const { stores, mode } = resolveHeroInstall(platform, nativeStore);
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center' }}>
      {stores.map((store, index) => (
        <Button
          key={store}
          href={buildStoreUrl(store, { placement, inbound: inboundCampaign })}
          target="_blank"
          rel="noopener noreferrer"
          variant={index === 0 ? 'contained' : 'outlined'}
          sx={index === 0 ? PRIMARY_STORE_SX : SECONDARY_STORE_SX}
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
          {mode === 'update'
            ? t('home.hero.ctaUpdate')
            : store === 'ios'
              ? t('home.hero.ctaInstallIos')
              : t('home.hero.ctaInstallAndroid')}
        </Button>
      ))}
    </Box>
  );
}
