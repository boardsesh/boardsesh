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
//    payload back field by field.
//  * The medium vocabulary is the gym funnel's (`GYM_QR_MEDIUMS`), parsed by the
//    same strict `parseGymQrLanding`: one printed-code param contract for every
//    poster, whichever page it lands on.
//
// Which code fires which scan event: docs/gym-funnel-analytics.md ("Which code
// fires which event").

import { boardTypeProperty, type BoardTypeProperty } from './board-type-property';
import { SHARED_EVENTS } from './events';
import type { GymQrMedium } from './gym-funnel';

/**
 * Where the scan landed. `web` is the www board page a browser opens; `app` is
 * the store app opening the code's link itself.
 */
export type BoardQrSurface = 'web' | 'app';

export type BoardQrScannedInput = {
  medium: GymQrMedium;
  surface: BoardQrSurface;
  /** The board's type (`kilter`, `spray`, …). Anything outside the nine is sent as null. */
  boardType: string | null | undefined;
};

export type BoardQrScannedProps = BoardTypeProperty & {
  medium: GymQrMedium;
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
