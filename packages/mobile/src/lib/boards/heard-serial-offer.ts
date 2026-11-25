// The serial the picker's In range slot hands the builder, held so the builder
// can tell it came from a scan. "It's my own board" on a box nobody has saved
// opens /boards/create with `presetBoardType` and `serial`; the builder fills
// the serial only when this phone just offered that same serial for that same
// board type. A link that names a serial by itself (a crafted
// /boards/create?preset=1&serial=X) opens with the field empty, so a board is
// never bound to a box nobody heard.
//
// Module state, like pending-board-recognition.ts: the picker and the builder
// share no provider, and the offer only has to outlive one push. Ten minutes,
// the same window as a held serial-less box. The picker drops it on its next
// unnamed-row tap and when it unmounts (use-in-range-actions.ts), so it never
// outlives the picker visit that heard the box.

import type { BoardName } from '@boardsesh/shared-schema';

export const HEARD_SERIAL_OFFER_TTL_MS = 10 * 60 * 1000;

type HeardSerialOffer = { serial: string; boardType: BoardName; expiresAt: number };

let offer: HeardSerialOffer | null = null;

/** Offer `serial` of `boardType` to the next builder, replacing any earlier offer. */
export function offerHeardSerial(
  { serial, boardType }: { serial: string; boardType: BoardName },
  nowMs: number = Date.now(),
): void {
  offer = { serial, boardType, expiresAt: nowMs + HEARD_SERIAL_OFFER_TTL_MS };
}

/** Drop the offer: the picker's next unnamed-row tap, or the picker unmounting. */
export function clearHeardSerialOffer(): void {
  offer = null;
}

/** Whether the picker just offered exactly this serial for exactly this board type. */
export function isHeardSerialOffered(
  { serial, boardType }: { serial: string; boardType: BoardName },
  nowMs: number = Date.now(),
): boolean {
  return offer !== null && nowMs < offer.expiresAt && offer.serial === serial && offer.boardType === boardType;
}
