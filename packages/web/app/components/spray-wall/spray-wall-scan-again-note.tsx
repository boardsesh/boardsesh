'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import { useBoardQrLandingMedium } from '@/app/hooks/use-board-qr-landing-medium';

type SprayWallScanAgainNoteProps = {
  /** "Just installed? Scan again to open this Spraywall.", already translated. */
  text: string;
};

const noteSx = { color: 'var(--neutral-400)' };

/**
 * The line under a Spraywall's store buttons for someone who scanned its code.
 *
 * Shown only after a scan (#4415). Somebody who followed a shared link has no
 * code to scan again, and the same page reaches both, so the line waits for
 * the browser to say this visit came off a printed code. Nothing in the shared
 * HTML, which is the same for everyone.
 */
export default function SprayWallScanAgainNote({ text }: SprayWallScanAgainNoteProps) {
  const qrMedium = useBoardQrLandingMedium();
  if (!qrMedium) return null;
  return (
    <Typography variant="body2" sx={noteSx}>
      {text}
    </Typography>
  );
}
