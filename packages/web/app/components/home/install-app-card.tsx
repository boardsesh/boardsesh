'use client';

import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Skeleton from '@mui/material/Skeleton';
import AndroidOutlined from '@mui/icons-material/AndroidOutlined';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';
import type { InstallPlatform } from '@/app/lib/hero-install';
import { track } from '@/app/lib/analytics';
import { APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties } from '@/app/lib/app-install-event';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import OnboardingCard from './onboarding-card';

function InstallAppShadowCard() {
  return (
    <Card
      variant="outlined"
      aria-hidden
      sx={{
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        border: '1px solid var(--neutral-200)',
        transition: themeTokens.transitions.fast,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2, px: 2.5 }}>
        <Skeleton
          variant="rounded"
          width={44}
          height={44}
          sx={{ borderRadius: `${themeTokens.borderRadius.md}px`, flexShrink: 0 }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Skeleton variant="text" width="60%" height={20} />
          <Skeleton variant="text" width="85%" height={18} />
        </Box>
      </Box>
    </Card>
  );
}

export default function InstallAppCard({ platform }: { platform: InstallPlatform }) {
  const { t } = useTranslation('marketing');

  if (platform === 'unknown') return <InstallAppShadowCard />;
  if (platform === 'native') return null;

  // 'desktop-web' falls through to the generic card below: the hero already
  // offers both stores, and a second place doing the same is noise. The card's
  // copy is store-agnostic ("Get the Boardsesh app"), so pointing it at the
  // App Store is a default rather than a claim about the visitor's phone.

  if (platform === 'android-web') {
    return (
      <OnboardingCard
        icon={<AndroidOutlined />}
        title={t('home.install.androidLiveTitle')}
        description={t('home.install.androidLiveDescription')}
        onClick={() => {
          track(
            APP_INSTALL_CLICK_EVENT,
            buildAppInstallClickProperties({ platform: 'android', source: 'google-play' }),
          );
          window.open(ANDROID_PLAY_STORE_URL, '_blank', 'noopener,noreferrer');
        }}
      />
    );
  }

  if (platform !== 'other-web' && platform !== 'desktop-web') {
    const exhaustivePlatform: never = platform;
    return exhaustivePlatform;
  }

  return (
    <OnboardingCard
      icon={
        <Image
          src={resolveShellStaticAssetUrl('/brand/boardsesh-mark.png')}
          width={44}
          height={44}
          alt=""
          style={{ borderRadius: themeTokens.borderRadius.md, display: 'block' }}
        />
      }
      title={t('home.install.iosTitle')}
      description={t('home.install.iosDescription')}
      accent="none"
      onClick={() => {
        track(APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties({ platform: 'ios', source: 'app-store' }));
        window.open(IOS_APP_STORE_URL, '_blank', 'noopener,noreferrer');
      }}
    />
  );
}
