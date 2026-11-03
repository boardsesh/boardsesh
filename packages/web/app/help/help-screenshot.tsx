import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { helpScreenshot, type HelpShot } from '@/app/lib/help-screenshots';
import styles from './help-screenshot.module.css';

/**
 * A help capture with its caption, in a bezel that gives the near-black app UI
 * an edge against the near-black page.
 *
 * It resolves its own `/images/help/*` source: these shots follow one flow
 * rather than selling a platform, so there is no iOS/Android switch to honour
 * and nothing here reads the preview context.
 *
 * Strings arrive already resolved by the caller's `t()`, like PageShell's do.
 */
export function HelpScreenshot({ shot, alt, caption }: { shot: HelpShot; alt: string; caption: string }) {
  const capture = helpScreenshot(shot);
  return (
    <Box component="figure" className={styles.figure}>
      <Box className={styles.bezel}>
        <Image
          src={resolveStaticAssetUrl(capture.src)}
          alt={alt}
          width={capture.width}
          height={capture.height}
          sizes="280px"
          className={styles.screen}
        />
      </Box>
      <Typography component="figcaption" variant="body2" className={styles.caption}>
        {caption}
      </Typography>
    </Box>
  );
}

/** A row of captures: side by side on a desktop measure, one per row on a phone. */
export function HelpShots({ children }: { children: React.ReactNode }) {
  return <Box className={styles.shots}>{children}</Box>;
}
