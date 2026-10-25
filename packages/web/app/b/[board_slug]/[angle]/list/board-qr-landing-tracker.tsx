'use client';

import { useEffect, useRef } from 'react';
import { boardQrScanned, stripGymQrParams, type AnalyticsBoardType } from '@boardsesh/analytics';
import { useConsent } from '@/app/components/consent/consent-provider';
import { track } from '@/app/lib/analytics';
import { captureBoardQrLandingMedium } from '@/app/lib/board-qr-landing';

type BoardQrLandingTrackerProps = {
  /**
   * The board's type, already narrowed to the nine (`boardTypeProperty`), or
   * null. Never a slug, name or uuid: `Board QR Scanned` names no board.
   */
  boardType: AnalyticsBoardType | null;
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
 * know whether this visit came off a code. `captureBoardQrLandingMedium` applies
 * `parseBoardQrLanding` (the strict gym parser, narrowed to `kiosk` and
 * `board`, so a gym poster's `medium=poster` on a board page counts nothing)
 * and remembers the answer for this page.
 *
 * Two effects, because the two jobs wait for different things:
 *
 *  - **The strip** runs on mount, consent or not, and one task later, like
 *    `useClaimParamStrip`: on the hydration commit this effect runs before Next
 *    has patched `history.replaceState`, and a native call then would leave the
 *    router's own URL holding the pair, to be written back. Only `src` and
 *    `medium` leave; `?wall=` stays, because it is what opens an unlisted
 *    Spraywall and a reload without it is a 404.
 *  - **The count** waits for `granted`. Consent settles after the hydration
 *    commit (the session and the region lookup are async), and `track()` drops
 *    an event sent before that, so counting on mount would lose nearly every
 *    cold scan. The landing is marked reported only when it is sent, and the
 *    remembered medium is still readable after the strip. Its only deps are
 *    `granted`: the board type is read through a ref, so whether the scan is
 *    sent once cannot hinge on that prop staying stable.
 *
 * By design, a scan whose page the climber has already left when consent
 * settles is not counted. The landing belongs to its pathname, and an event
 * fired on another page would carry that page's URL. Consent settles soon
 * after hydration (a session read and a region lookup), so this costs a scan
 * only for someone who leaves the page before then; coming back to the
 * scanned page counts it.
 */
export default function BoardQrLandingTracker({ boardType }: BoardQrLandingTrackerProps) {
  const { granted } = useConsent();
  const boardTypeRef = useRef(boardType);
  useEffect(() => {
    boardTypeRef.current = boardType;
  }, [boardType]);

  useEffect(() => {
    // Read before the strip below runs, so the landing is remembered for this page.
    if (!captureBoardQrLandingMedium()) return;

    const stripTimer = setTimeout(() => {
      const cleanedSearch = stripGymQrParams(window.location.search);
      if (cleanedSearch !== window.location.search) {
        window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch}${window.location.hash}`);
      }
    }, 0);
    return () => clearTimeout(stripTimer);
  }, []);

  useEffect(() => {
    if (!granted) return;
    const medium = captureBoardQrLandingMedium();
    if (!medium) return;

    const landingKey = window.location.pathname;
    if (reportedLandings.has(landingKey)) return;
    reportedLandings.add(landingKey);

    const { name, properties } = boardQrScanned({ medium, surface: 'web', boardType: boardTypeRef.current });
    track(name, properties);
  }, [granted]);

  return null;
}
