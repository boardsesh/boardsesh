'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useTranslation } from 'react-i18next';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { resolveHeroInstall } from '@/app/lib/hero-install';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { track } from '@/app/lib/analytics';
import { APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties } from '@/app/lib/app-install-event';

export default function MarketingInstallLinks() {
  const { t } = useTranslation('marketing');
  const { platform, nativeStore } = useInstallPlatform();
  const { stores, mode } = resolveHeroInstall(platform, nativeStore);
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center' }}>
      {stores.map((store, index) => (
        <Button
          key={store}
          href={store === 'ios' ? IOS_APP_STORE_URL : ANDROID_PLAY_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          variant={index === 0 ? 'contained' : 'outlined'}
          sx={
            index === 0
              ? brandCtaSx({ size: 'large' })
              : {
                  borderRadius: 'var(--border-radius-full)',
                  minHeight: 44,
                  px: 3,
                  color: 'var(--color-primary)',
                  borderColor: 'var(--control-border)',
                  textTransform: 'none',
                  fontSize: 'var(--font-size-base)',
                }
          }
          onClick={() => {
            track(
              APP_INSTALL_CLICK_EVENT,
              buildAppInstallClickProperties({
                platform: store,
                source: store === 'ios' ? 'app-store' : 'google-play',
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
