'use client';

import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import { useTranslation } from 'react-i18next';
import { resolveMarketingStaticAssetUrl } from '@/app/lib/marketing-static-asset-url';
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
  // The default namespace, which the root layout loads on every page: only the
  // language is read here, and asking for `marketing` would make a page that
  // has no marketing catalog (the climb page) fetch it after hydration.
  const { i18n } = useTranslation();
  const preview = useMarketingPreview();
  const platform = preview?.platform ?? 'android';
  const isWaitingForPlatform = preview?.isPlatformResolved === false;
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'en-US';
  const capture = marketingScreenshot(platform, locale, shot);
  return (
    <Box
      className={`${styles.frame} ${detail ? styles.detail : ''} ${className ?? ''}`}
      data-marketing-shot={shot}
      data-preview-platform={platform}
      sx={isWaitingForPlatform && !detail ? { aspectRatio: `${capture.width} / ${capture.height}` } : undefined}
    >
      {isWaitingForPlatform ? (
        <noscript>
          <img
            src={resolveMarketingStaticAssetUrl(capture.src)}
            alt={alt}
            width={capture.width}
            height={capture.height}
            loading="lazy"
            className={styles.image}
          />
        </noscript>
      ) : (
        <Image
          src={resolveMarketingStaticAssetUrl(capture.src)}
          alt={alt}
          width={capture.width}
          height={capture.height}
          sizes={sizes}
          preload={preload}
          className={styles.image}
        />
      )}
    </Box>
  );
}
