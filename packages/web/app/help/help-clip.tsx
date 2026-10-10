'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { useAutoplayVideo } from '@/app/hooks/use-autoplay-video';
import { helpClip, helpWalkthrough, type HelpClipName, type HelpWalkthroughName } from '@/app/lib/help-clips';
import frame from '@/app/components/marketing/marketing-screenshot.module.css';
import styles from './help-clip.module.css';

/**
 * A short silent screen recording with its caption.
 *
 * Same frame, measure and caption as `HelpScreenshot`, because the two land in
 * the same rows: a clip is only used where the thing being taught is a gesture
 * — a long press, a swipe, a drag — that a still cannot hold.
 *
 * `alt` and `caption` arrive already resolved by the caller's `t()`, like
 * `HelpScreenshot`'s do. The strings this component owns are its own.
 */
export function HelpClip({ name, alt, caption }: { name: HelpClipName; alt: string; caption: string }) {
  const { t } = useTranslation('marketing');
  const clip = helpClip(name);
  const { videoRef, showsControls } = useAutoplayVideo();

  return (
    <Box component="figure" className={styles.figure}>
      <Box className={frame.frame}>
        <video
          ref={videoRef}
          className={styles.video}
          poster={clip.poster}
          width={clip.width}
          height={clip.height}
          aria-label={alt}
          muted
          loop
          playsInline
          preload="metadata"
          controls={showsControls}
        >
          {/* VP9 first: a browser takes the first source it can play, and the
              webm is the smaller file wherever it is understood. */}
          <source src={clip.webm} type="video/webm" />
          <source src={clip.mp4} type="video/mp4" />
          {t('help.clip.unsupported')}
        </video>
      </Box>
      <Typography component="figcaption" variant="body2" className={styles.caption}>
        {caption}
      </Typography>
      {showsControls ? (
        <Typography variant="body2" className={styles.hint}>
          {t('help.clip.playHint')}
        </Typography>
      ) : null}
    </Box>
  );
}

/** A longer walkthrough shows a poster and controls without autoplay or looping. */
export function HelpWalkthrough({ name, alt }: { name: HelpWalkthroughName; alt: string }) {
  const { t } = useTranslation('marketing');
  const { portrait, landscape } = helpWalkthrough(name);

  return (
    <Box component="figure" className={`${styles.figure} ${styles.walkthroughFigure}`}>
      <Box className={`${frame.frame} ${styles.landscapeFrame}`}>
        <video
          className={`${styles.video} ${styles.landscapeVideo}`}
          poster={landscape.poster}
          width={landscape.width}
          height={landscape.height}
          aria-label={alt}
          muted
          playsInline
          preload="none"
          controls
        >
          <source src={landscape.mp4} type="video/mp4" />
          <source src={landscape.webm} type="video/webm" />
          {t('help.clip.unsupported')}
        </video>
      </Box>
      <Box className={`${frame.frame} ${styles.portraitFrame}`}>
        <video
          className={`${styles.video} ${styles.portraitVideo}`}
          poster={portrait.poster}
          width={portrait.width}
          height={portrait.height}
          aria-label={alt}
          muted
          playsInline
          preload="none"
          controls
        >
          <source src={portrait.mp4} type="video/mp4" />
          <source src={portrait.webm} type="video/webm" />
          {t('help.clip.unsupported')}
        </video>
      </Box>
    </Box>
  );
}

/**
 * The row layout, re-exported rather than duplicated: a clip and a still belong
 * in the same grid, and the common case is a gesture clip beside the still of
 * where it lands. One import gives a page both.
 */
export { HelpShots } from './help-screenshot';
