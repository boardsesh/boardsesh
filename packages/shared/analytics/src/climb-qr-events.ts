// Climb QR scans: the code a climb page shows on a laptop, beside "Open in your
// browser", so a climber can carry the climb to the phone in their pocket. A
// board's climb list, a setter's page, a playlist and the home page show the
// same code for the same reason; each of their scans has its own name
// (`List QR Scanned`, `Setter QR Scanned`, `Playlist QR Scanned`,
// `Home QR Scanned`, built below), so no funnel counts another page's scans.
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

/**
 * The medium a climb page's code says: `desktop`, the code beside the browser
 * button on a laptop. A board list's code prints the same medium.
 */
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

/**
 * A board list's code was scanned and the list loaded on the phone. Once per
 * landing.
 *
 * The same code as a climb page's, on `/…/{angle}/list`: `medium=desktop`,
 * parsed by `parseClimbQrLanding`, and the same three properties. Its own name
 * so `Climb QR Scanned` stays a count of climb pages. Nothing names the board;
 * the page URL the SDK stamps on every event says which list it was.
 */
export function listQrScanned(input: ClimbQrScannedInput): {
  name: typeof SHARED_EVENTS.ListQrScanned;
  properties: ClimbQrScannedProps;
} {
  return {
    name: SHARED_EVENTS.ListQrScanned,
    properties: {
      medium: input.medium,
      surface: input.surface,
      ...boardTypeProperty(input.boardType),
    },
  };
}

/**
 * A setter page's code was scanned and the setter's page loaded on the phone.
 * Once per landing.
 *
 * The laptop code beside a setter's store buttons, on `/setter/{name}`:
 * `medium=desktop`, parsed by `parseClimbQrLanding`, the same three properties.
 * `boardType` is the board most of the page's climbs sit on. Nothing names the
 * setter; the page URL the SDK stamps on every event says whose page it was.
 */
export function setterQrScanned(input: ClimbQrScannedInput): {
  name: typeof SHARED_EVENTS.SetterQrScanned;
  properties: ClimbQrScannedProps;
} {
  return {
    name: SHARED_EVENTS.SetterQrScanned,
    properties: {
      medium: input.medium,
      surface: input.surface,
      ...boardTypeProperty(input.boardType),
    },
  };
}

/**
 * A public playlist's code was scanned and the playlist loaded on the phone.
 * Once per landing.
 *
 * The laptop code under a playlist's "Open in your browser", on
 * `/playlists/{uuid}`: `medium=desktop`, parsed by `parseClimbQrLanding`, the
 * same three properties. `boardType` is the playlist's own board. Nothing names
 * the playlist; the page URL says which one it was.
 */
export function playlistQrScanned(input: ClimbQrScannedInput): {
  name: typeof SHARED_EVENTS.PlaylistQrScanned;
  properties: ClimbQrScannedProps;
} {
  return {
    name: SHARED_EVENTS.PlaylistQrScanned,
    properties: {
      medium: input.medium,
      surface: input.surface,
      ...boardTypeProperty(input.boardType),
    },
  };
}

/**
 * The home page's code was scanned and the home page loaded on the phone.
 * Once per landing.
 *
 * The laptop code in the home hero, beside the two store badges, on `/`:
 * `medium=desktop`, parsed by `parseClimbQrLanding`, the same three properties.
 * The home page shows no board, so callers pass `boardType: null`.
 */
export function homeQrScanned(input: ClimbQrScannedInput): {
  name: typeof SHARED_EVENTS.HomeQrScanned;
  properties: ClimbQrScannedProps;
} {
  return {
    name: SHARED_EVENTS.HomeQrScanned,
    properties: {
      medium: input.medium,
      surface: input.surface,
      ...boardTypeProperty(input.boardType),
    },
  };
}
