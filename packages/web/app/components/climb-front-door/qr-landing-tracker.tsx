'use client';

import { useEffect, useRef } from 'react';
import {
  boardQrScanned,
  climbQrScanned,
  listQrScanned,
  playlistQrScanned,
  homeQrScanned,
  setterQrScanned,
  stripGymQrParams,
  type AnalyticsBoardType,
} from '@boardsesh/analytics';
import { useConsent } from '@/app/components/consent/consent-state-provider';
import { track } from '@/app/lib/analytics';
import { captureQrLanding, type QrLanding, type QrLandingKind } from '@/app/lib/qr-landing';

type QrLandingTrackerProps = {
  /**
   * Which code lands on this page: `board` on `/b/{slug}/{angle}/list` (a
   * printed board poster or the kiosk's install code), `climb` on a climb page,
   * `list` on a board's climb list, `setter` on a setter's page and `playlist`
   * on a public playlist (the laptop code each of those pages shows from md).
   */
  kind: QrLandingKind;
  /**
   * The board's type, already narrowed to the nine (`boardTypeProperty`), or
   * null. Never a slug, name or uuid: no scan event names a board.
   */
  boardType: AnalyticsBoardType | null;
};

/**
 * Which landings have already been REPORTED, by pathname. React StrictMode
 * mounts every effect twice in development, and a client-side visit back to the
 * scanned page would otherwise count the code again. Module scope (not a ref)
 * because the second StrictMode pass runs against a fresh component instance.
 */
const reportedLandings = new Set<string>();

/** Test-only: the dedupe Set outlives every unmount, so a suite reusing a path would silently pass. */
export function __resetReportedQrLandingsForTests(): void {
  reportedLandings.clear();
}

function scanEvent(landing: QrLanding, boardType: AnalyticsBoardType | null) {
  switch (landing.kind) {
    case 'board':
      return boardQrScanned({ medium: landing.medium, surface: 'web', boardType });
    case 'climb':
      return climbQrScanned({ medium: landing.medium, surface: 'web', boardType });
    case 'list':
      return listQrScanned({ medium: landing.medium, surface: 'web', boardType });
    case 'setter':
      return setterQrScanned({ medium: landing.medium, surface: 'web', boardType });
    case 'playlist':
      return playlistQrScanned({ medium: landing.medium, surface: 'web', boardType });
    case 'home':
      return homeQrScanned({ medium: landing.medium, surface: 'web', boardType });
  }
}

/**
 * Counts a scan of a code that lands on a shared page. Renders nothing.
 *
 *  - `board` (#4415): mounted on both branches of `/b/{slug}/{angle}/list`, the
 *    page a board QR lands on after the `/b/{slug}` hop: the Spraywall front
 *    door and the catalogue board list. Per-board posters say `medium=board`;
 *    the kiosk screen's install code says `medium=kiosk`. Fires
 *    `Board QR Scanned`.
 *  - `climb`: mounted on the climb page in both route trees. The code beside
 *    "Open in your browser" says `medium=desktop`. Fires `Climb QR Scanned`.
 *  - `list`: mounted on the catalogue board list in both route trees, the same
 *    laptop code pointed at the list. Fires `List QR Scanned`. On `/b` it sits
 *    beside the `board` tracker; each reads only its own mediums.
 *  - `setter` and `playlist`: mounted on a setter's page and on a public
 *    playlist, the same laptop code pointed at that page. Fire
 *    `Setter QR Scanned` and `Playlist QR Scanned`.
 *  - `home`: mounted on the home page, whose hero shows the same laptop code
 *    from md. Fires `Home QR Scanned` with a null board type.
 *
 * Unlike `GymQrLandingTracker`, the medium is read here in the browser and not
 * passed by the server: these pages' HTML is shared at the edge, so it cannot
 * know whether this visit came off a code. `captureQrLanding` applies the
 * strict gym parser narrowed to the mediums this kind of code prints, so a gym
 * poster's `medium=poster` on a board or climb page counts nothing, and
 * remembers the answer for this page.
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
 *    remembered landing is still readable after the strip. Its only deps are
 *    `granted` and `kind`: the board type is read through a ref, so whether the
 *    scan is sent once cannot hinge on that prop staying stable.
 *
 * By design, a scan whose page the climber has already left when consent
 * settles is not counted. The landing belongs to its pathname, and an event
 * fired on another page would carry that page's URL. Consent settles soon
 * after hydration (a session read and a region lookup), so this costs a scan
 * only for someone who leaves the page before then; coming back to the
 * scanned page counts it.
 */
export default function QrLandingTracker({ kind, boardType }: QrLandingTrackerProps) {
  const { granted } = useConsent();
  const boardTypeRef = useRef(boardType);
  useEffect(() => {
    boardTypeRef.current = boardType;
  }, [boardType]);

  useEffect(() => {
    // Read before the strip below runs, so the landing is remembered for this page.
    if (!captureQrLanding(kind)) return;

    const stripTimer = setTimeout(() => {
      const cleanedSearch = stripGymQrParams(window.location.search);
      if (cleanedSearch !== window.location.search) {
        window.history.replaceState(null, '', `${window.location.pathname}${cleanedSearch}${window.location.hash}`);
      }
    }, 0);
    return () => clearTimeout(stripTimer);
  }, [kind]);

  useEffect(() => {
    if (!granted) return;
    const landing = captureQrLanding(kind);
    if (!landing) return;

    const landingKey = window.location.pathname;
    if (reportedLandings.has(landingKey)) return;
    reportedLandings.add(landingKey);

    const { name, properties } = scanEvent(landing, boardTypeRef.current);
    track(name, properties);
  }, [granted, kind]);

  return null;
}
