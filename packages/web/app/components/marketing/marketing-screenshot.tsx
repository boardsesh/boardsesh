'use client';

import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useTranslation } from 'react-i18next';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { isSupportedLocale } from '@/app/lib/i18n/config';
import { marketingScreenshot, type MarketingShot } from '@/app/lib/marketing-screenshots';
import { useMarketingPreview } from './marketing-preview-provider';
import styles from './marketing-screenshot.module.css';

export type { MarketingShot } from '@/app/lib/marketing-screenshots';

/** Captures are English when the platform has no published localized equivalent. */
export function MarketingScreenshot({
  shot,
  alt,
  className,
  detail = false,
  preload = false,
  sizes = '(max-width: 760px) 80vw, 360px',
}: {
  shot: MarketingShot;
  alt: string;
  className?: string;
  detail?: boolean;
  preload?: boolean;
  sizes?: string;
}) {
  const { i18n } = useTranslation('marketing');
  const platform = useMarketingPreview()?.platform ?? 'android';
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'en-US';
  const capture = marketingScreenshot(platform, locale, shot);
  return (
    <Box
      className={`${styles.frame} ${detail ? styles.detail : ''} ${className ?? ''}`}
      data-marketing-shot={shot}
      data-preview-platform={platform}
    >
      <Image
        src={resolveStaticAssetUrl(capture.src)}
        alt={alt}
        width={capture.width}
        height={capture.height}
        sizes={sizes}
        preload={preload}
        className={styles.image}
      />
    </Box>
  );
}

export function MarketingPreviewSwitch() {
  const { t } = useTranslation('marketing');
  const preview = useMarketingPreview();
  if (!preview?.browser.desktop) return null;

  return (
    <ToggleButtonGroup
      className={styles.switch}
      value={preview.platform}
      exclusive
      size="small"
      aria-label={t('preview.label')}
      onChange={(_event, platform: unknown) => {
        if (platform === 'ios' || platform === 'android') preview.selectPlatform(platform);
      }}
    >
      <ToggleButton value="ios">{t('preview.ios')}</ToggleButton>
      <ToggleButton value="android">{t('preview.android')}</ToggleButton>
    </ToggleButtonGroup>
  );
}
