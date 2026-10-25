// Board QR scans (#4415): the printed per-board poster, and the kiosk screen's
// install code, both point at a board rather than at a gym.
//
// The contract, one paragraph, mirrors spray-wall-events.ts:
//
//  * The name lives in `SHARED_EVENTS` (events.ts). www fires it today; the
//    `surface` union already has the app's value so the app's own landing can
//    fire the SAME event, and one funnel reads both.
//  * The builder returns `{ name, properties }` TOGETHER, so a call site cannot
//    pair these props with another event's name.
//  * **Nothing identifies the board.** No slug, no name, no uuid, no gym. A
//    Spraywall's slug is made from its name, and its uuid is the capability
//    that opens an unlisted one, so either would put somebody's home wall in
//    PostHog. Every property is a closed union, and `boardType` comes through
//    `boardTypeProperty`, so a slug handed over by mistake arrives as null.
//    The spray payload check in `__tests__/spray-wall-events.test.ts` reads this
//    payload back field by field. That covers the PROPERTIES only: the web SDK
//    also stamps the page URL (`$current_url`, `$pathname`) on every event,
//    and keeping a wall's `?wall=` capability out of it is web's URL scrub.
//  * The medium vocabulary is the gym funnel's (`GYM_QR_MEDIUMS`), parsed by the
//    same strict `parseGymQrLanding`: one printed-code param contract for every
//    poster, whichever page it lands on. A board landing accepts only the two
//    mediums a board code prints (`BOARD_QR_MEDIUMS`); `poster` is the gym
//    poster's, which never points at a board, so `parseBoardQrLanding` refuses it.
//
// Which code fires which scan event: docs/gym-funnel-analytics.md ("Which code
// fires which event").

import { boardTypeProperty, type BoardTypeProperty } from './board-type-property';
import { SHARED_EVENTS } from './events';
import { parseGymQrLanding, type GymQrMedium, type GymQrSearchParams } from './gym-funnel';

/**
 * The mediums a board code prints: `kiosk` (the kiosk screen's install code) and
 * `board` (the per-board poster). A subset of `GYM_QR_MEDIUMS`, so a board code
 * still parses with the one strict parser.
 */
export const BOARD_QR_MEDIUMS = ['kiosk', 'board'] as const satisfies readonly GymQrMedium[];
export type BoardQrMedium = (typeof BOARD_QR_MEDIUMS)[number];

export type BoardQrLanding = { medium: BoardQrMedium };

function isBoardQrMedium(medium: GymQrMedium): medium is BoardQrMedium {
  return (BOARD_QR_MEDIUMS as readonly GymQrMedium[]).includes(medium);
}

/**
 * Recognise a scan of a BOARD code, or return `null`. `parseGymQrLanding`'s
 * strict rules, then one more: the medium must be one a board code prints.
 * `?src=qr&medium=poster` on a board page is a hand-edited or misprinted link,
 * not a scan of anything we made, so it is not counted.
 */
export function parseBoardQrLanding(searchParams: GymQrSearchParams): BoardQrLanding | null {
  const landing = parseGymQrLanding(searchParams);
  if (!landing || !isBoardQrMedium(landing.medium)) return null;
  return { medium: landing.medium };
}

/**
 * Where the scan landed. `web` is the www board page a browser opens; `app` is
 * the store app opening the code's link itself.
 */
export type BoardQrSurface = 'web' | 'app';

export type BoardQrScannedInput = {
  medium: BoardQrMedium;
  surface: BoardQrSurface;
  /** The board's type (`kilter`, `spray`, …). Anything outside the nine is sent as null. */
  boardType: string | null | undefined;
};

export type BoardQrScannedProps = BoardTypeProperty & {
  medium: BoardQrMedium;
  surface: BoardQrSurface;
};

/** A name paired with the exact properties that name expects. */
export type BoardQrPayload<TName extends string, TProperties extends BoardQrScannedProps> = {
  name: TName;
  properties: TProperties;
};

/** A printed board code was scanned and its landing loaded. Once per landing. */
export function boardQrScanned(
  input: BoardQrScannedInput,
): BoardQrPayload<typeof SHARED_EVENTS.BoardQrScanned, BoardQrScannedProps> {
  return {
    name: SHARED_EVENTS.BoardQrScanned,
    properties: {
      medium: input.medium,
      surface: input.surface,
      ...boardTypeProperty(input.boardType),
    },
  };
}
