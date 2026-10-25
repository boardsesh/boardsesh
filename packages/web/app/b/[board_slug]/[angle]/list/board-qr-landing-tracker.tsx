'use client';

import { useEffect } from 'react';
import { boardQrScanned, stripGymQrParams } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';
import { readBoardQrLandingMedium } from '@/app/lib/board-qr-landing';

type BoardQrLandingTrackerProps = {
  /** The board's type. Never its slug, name or uuid: `Board QR Scanned` names no board. */
  boardType: string;
};

/**
 * Which landings have already been REPORTED, by pathname. React StrictMode
 * mounts every effect twice in development, and a client-side visit back to the
 * scanned page would otherwise count the poster again. Module scope (not a ref)
 * because the second StrictMode pass runs against a fresh component instance.
 */
const reportedLandings = new Set<string>();

/** Test-only: the dedupe Set outlives every unmount, so a suite reusing a path would silently pass. */
export function __resetReportedBoardQrLandingsForTests(): void {
  reportedLandings.clear();
}

/**
 * Counts a scan of a printed board code (#4415). Renders nothing.
 *
 * Mounted on both branches of `/b/{slug}/{angle}/list`, the page a board QR
 * lands on after the `/b/{slug}` hop: the Spraywall front door and the
 * catalogue board list. Per-board posters say `medium=board`; the kiosk
 * screen's install code (`board-install-qr.tsx`) says `medium=kiosk` and is
 * counted here too.
 *
 * Unlike `GymQrLandingTracker`, the medium is read here in the browser and not
 * passed by the server: this page's HTML is shared at the edge, so it cannot
 * know whether this visit came off a code. `readBoardQrLandingMedium` applies
 * the same strict `parseGymQrLanding` and remembers the answer, so the store
 * buttons still read it after the strip below.
 *
 * Only `src` and `medium` leave the address bar. `?wall=` stays, because it is
 * what opens an unlisted Spraywall: drop it and a reload is a 404. The strip
 * waits one task, like `useClaimParamStrip`: on the hydration commit this
 * effect runs before Next has patched `history.replaceState`, and a native call
 * then would leave the router's own URL with the pair in it, to be written back.
 */
export default function BoardQrLandingTracker({ boardType }: BoardQrLandingTrackerProps) {
  useEffect(() => {
    const medium = readBoardQrLandingMedium();
    if (!medium) return;

    const stripTimer = setTimeout(() => {
      const cleanedSearch = stripGymQrParams(window.location.search);
      if (cleanedSearch !== window.location.search) {
        window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch}${window.location.hash}`);
      }
    }, 0);

    const landingKey = window.location.pathname;
    if (!reportedLandings.has(landingKey)) {
      reportedLandings.add(landingKey);
      const { name, properties } = boardQrScanned({ medium, surface: 'web', boardType });
      track(name, properties);
    }

    return () => clearTimeout(stripTimer);
  }, [boardType]);

  return null;
}
