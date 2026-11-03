import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { helpScreenshot, type HelpShot } from '@/app/lib/help-screenshots';
import styles from './help-screenshot.module.css';

/**
 * A help capture with its caption, framed as a phone so the near-black app UI
 * has an edge against the reading surface.
 *
 * It resolves its own `/images/help/*` source: these shots follow one flow
 * rather than selling a platform, so there is no iOS/Android switch to honour
 * and nothing here reads the preview context.
 *
 * Strings arrive already resolved by the caller's `t()`, like PageShell's do.
 */
export function HelpScreenshot({
  shot,
  alt,
  caption,
  cropped = false,
}: {
  shot: HelpShot;
  alt: string;
  caption?: string;
  /** Shows the top 440px of the phone only: enough to say "this is the app" beside a short band. */
  cropped?: boolean;
}) {
  const capture = helpScreenshot(shot);
  return (
    <Box component="figure" className={styles.figure}>
      <Box className={cropped ? `${styles.bezel} ${styles.cropped}` : styles.bezel}>
        <Image
          src={resolveStaticAssetUrl(capture.src)}
          alt={alt}
          width={capture.width}
          height={capture.height}
          sizes="340px"
          className={styles.screen}
        />
      </Box>
      {caption ? (
        <Typography component="figcaption" variant="body2" className={styles.caption}>
          {caption}
        </Typography>
      ) : null}
    </Box>
  );
}

/** Two captures side by side inside a band's body; one per row on a phone. */
export function HelpShots({ children }: { children: React.ReactNode }) {
  return <Box className={styles.shots}>{children}</Box>;
}
