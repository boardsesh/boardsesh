'use client';

import React, { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import styles from './climb-app-showcase.module.css';

type BetaFanCardProps = {
  thumbnail: string;
  /** `@handle` of whoever filmed it, when the link names one. */
  handle: string | null;
};

/**
 * One card in the app module's beta fan: the video's thumbnail with the
 * filmer's handle across the top.
 *
 * A plain `<img>`, as in the beta grid: the thumbnails live on the platforms'
 * CDNs (or our copy of them), which `next/image` has no business proxying. One
 * that fails, an expired Instagram link say, becomes the play tile instead of
 * a broken-image icon, the beta grid's own fallback.
 */
export default function BetaFanCard({ thumbnail, handle }: BetaFanCardProps) {
  const [failed, setFailed] = useState(false);
  // A cached failure can finish before hydration attaches onError: look at the
  // image itself when React attaches it, as the beta grid's card does.
  const checkThumbnail = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth === 0) setFailed(true);
  }, []);

  return (
    <Box component="figure" className={styles.fanCard}>
      {failed ? (
        <Box component="span" className={styles.playMark}>
          <PlayArrowRounded fontSize="inherit" />
        </Box>
      ) : (
        <Box
          component="img"
          ref={checkThumbnail}
          src={thumbnail}
          alt=""
          width={120}
          height={190}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
      {handle ? (
        <Box component="figcaption" className={styles.fanCaption}>
          {handle}
        </Box>
      ) : null}
    </Box>
  );
}
