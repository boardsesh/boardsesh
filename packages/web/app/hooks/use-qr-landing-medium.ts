'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { captureQrLandingMedium, type QrLandingKind, type QrLandingMedium } from '@/app/lib/qr-landing';

/**
 * The medium of the code this page was reached through, for a store button's
 * link id or a line meant only for someone who scanned (#4415). `kind` says
 * which code can land here: `board` for a printed code on a board list, `list`
 * for a board list's laptop code, `climb` on a climb page, `setter` and
 * `playlist` for those pages' laptop codes.
 *
 * `null` on the server AND on the hydration render, then the real value: the
 * page is shared at the edge, so its HTML has to be the same for a scan and a
 * plain visit. Read in an effect rather than during render because Next moves
 * the address bar to a new page in an insertion effect, after render, so only
 * an effect is sure to see this page's URL.
 *
 * Read again on every pathname change. A component that outlives a
 * client-side navigation (one board list to another) must not keep the last
 * page's medium, or a "Scan again" line and a `.board` link id would show on a
 * page nobody scanned; `captureQrLandingMedium` answers null there.
 *
 * Pass `null` on a page no code points at; the hook then never reads the URL.
 */
export function useQrLandingMedium(kind: QrLandingKind | null): QrLandingMedium | null {
  const pathname = usePathname();
  const [landingMedium, setLandingMedium] = useState<QrLandingMedium | null>(null);
  useEffect(() => {
    if (kind) setLandingMedium(captureQrLandingMedium(kind));
  }, [kind, pathname]);
  return kind ? landingMedium : null;
}
