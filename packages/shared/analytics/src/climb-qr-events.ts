// Climb QR scans: the code a climb page shows on a laptop, beside "Open in your
// browser", so a climber can carry the climb to the phone in their pocket.
//
// The same contract as board-qr-events.ts:
//
//  * The name lives in `SHARED_EVENTS` (events.ts). www fires it today; the
//    `surface` union already has the app's value, so the app's own landing can
//    fire the SAME event later and one funnel reads both.
//  * The builder returns `{ name, properties }` TOGETHER.
//  * Nothing identifies the climb. No uuid, no name, no setter: the web SDK
//    already stamps the page URL on every event, and a property naming the
//    climb would only make a second, unscrubbed copy of it.
//  * The medium vocabulary is the gym funnel's (`GYM_QR_MEDIUMS`), parsed by the
//    same strict `parseQrLanding`, narrowed to the one medium a climb page
//    prints (`CLIMB_QR_MEDIUMS`). A poster's or a board code's medium on a climb
//    page is a hand-edited link, not a scan of anything we made.
//
// Which code fires which scan event: docs/analytics/gym-funnel-analytics.md
// ("Which code fires which event").

import { boardTypeProperty, type BoardTypeProperty } from './board-type-property';
import { SHARED_EVENTS } from './events';
import { parseQrLanding, type GymQrMedium, type GymQrSearchParams } from './gym-funnel';

/** The medium a climb page's code says: `desktop`, the code beside the browser button on a laptop. */
export const CLIMB_QR_MEDIUMS = ['desktop'] as const satisfies readonly GymQrMedium[];
export type ClimbQrMedium = (typeof CLIMB_QR_MEDIUMS)[number];

export type ClimbQrLanding = { medium: ClimbQrMedium };

function isClimbQrMedium(medium: GymQrMedium): medium is ClimbQrMedium {
  return (CLIMB_QR_MEDIUMS as readonly GymQrMedium[]).includes(medium);
}

/**
 * Recognise a scan of a CLIMB code, or return `null`. `parseQrLanding`'s
 * strict rules, then one more: the medium must be one a climb page prints.
 */
export function parseClimbQrLanding(searchParams: GymQrSearchParams): ClimbQrLanding | null {
  const landing = parseQrLanding(searchParams);
  if (!landing || !isClimbQrMedium(landing.medium)) return null;
  return { medium: landing.medium };
}

/**
 * Where the scan landed. `web` is the www climb page a phone's browser opens;
 * `app` is the store app opening the code's link itself (not built yet).
 */
export type ClimbQrSurface = 'web' | 'app';

export type ClimbQrScannedInput = {
  medium: ClimbQrMedium;
  surface: ClimbQrSurface;
  /** The climb's board type (`kilter`, `moonboard`, …). Anything outside the nine is sent as null. */
  boardType: string | null | undefined;
};

export type ClimbQrScannedProps = BoardTypeProperty & {
  medium: ClimbQrMedium;
  surface: ClimbQrSurface;
};

/** A climb page's code was scanned and the climb page loaded on the phone. Once per landing. */
export function climbQrScanned(input: ClimbQrScannedInput): {
  name: typeof SHARED_EVENTS.ClimbQrScanned;
  properties: ClimbQrScannedProps;
} {
  return {
    name: SHARED_EVENTS.ClimbQrScanned,
    properties: {
      medium: input.medium,
      surface: input.surface,
      ...boardTypeProperty(input.boardType),
    },
  };
}
