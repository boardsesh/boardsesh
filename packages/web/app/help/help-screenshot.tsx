import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { helpScreenshot, type HelpShot } from '@/app/lib/help-screenshots';
import frame from '@/app/components/marketing/marketing-screenshot.module.css';
import styles from './help-screenshot.module.css';

/**
 * A help capture with its caption.
 *
 * It borrows the marketing screenshot's frame so a phone shot looks the same
 * wherever it lands, but resolves its own `/images/help/*` source: these shots
 * follow one flow rather than selling a platform, so there is no iOS/Android
 * switch to honour and nothing here reads the preview context.
 *
 * Strings arrive already resolved by the caller's `t()`, like PageShell's do.
 */
export function HelpScreenshot({ shot, alt, caption }: { shot: HelpShot; alt: string; caption: string }) {
  const capture = helpScreenshot(shot);
  return (
    <Box component="figure" className={styles.figure}>
      <Box className={frame.frame} data-help-shot={shot}>
        <Image
          src={resolveStaticAssetUrl(capture.src)}
          alt={alt}
          width={capture.width}
          height={capture.height}
          sizes="(max-width: 760px) 80vw, 320px"
          className={frame.image}
        />
      </Box>
      <Typography component="figcaption" variant="body2" className={styles.caption}>
        {caption}
      </Typography>
    </Box>
  );
}

/** A row of captures: two across a desktop measure, one across a phone. */
export function HelpShots({ children }: { children: React.ReactNode }) {
  return <Box className={styles.shots}>{children}</Box>;
}
