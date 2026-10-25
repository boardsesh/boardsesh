'use client';

import { useEffect, useState } from 'react';
import type { GymQrMedium } from '@boardsesh/analytics';
import { captureBoardQrLandingMedium } from '@/app/lib/board-qr-landing';

/**
 * The printed medium this board page was reached through, for a store button's
 * link id or a line meant only for someone who scanned (#4415).
 *
 * `null` on the server AND on the hydration render, then the real value: the
 * page is shared at the edge, so its HTML has to be the same for a scan and a
 * plain visit. Read in an effect rather than during render because Next moves
 * the address bar to a new page in an insertion effect, after render, so only
 * an effect is sure to see this page's URL.
 *
 * Pass `false` on a page no code points at; the hook then never reads the URL.
 */
export function useBoardQrLandingMedium(enabled = true): GymQrMedium | null {
  const [landingMedium, setLandingMedium] = useState<GymQrMedium | null>(null);
  useEffect(() => {
    if (enabled) setLandingMedium(captureBoardQrLandingMedium());
  }, [enabled]);
  return enabled ? landingMedium : null;
}
