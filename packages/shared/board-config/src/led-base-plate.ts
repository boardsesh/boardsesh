// Which board layouts mount their holds on a lit LED base plate.
//
// On a Kilter Homewall the LED sits under a translucent plate the hold is bolted
// through, so the board lights a RING of plate around the hold rather than the
// hold itself. That is the only geometry in the catalogue with two boundaries
// worth tracing: an OUTER edge around hold + plate, and an INNER edge where the
// plate stops and the hold body begins. Every other layout has one boundary —
// the hold — and asking someone to trace an inner edge there is asking for a
// polygon with nothing on the other side of it.
//
// A DECLARED FLAG, NOT A MEASUREMENT. The board-art generator decides whether to
// emit a `ledInner` table by whether enough holds happened to yield a ring from
// the image extractor, which answers "did extraction work here" and not "does
// this board have a plate". Those differ in both directions: an extractor that
// fails on a plated layout would hide the editor's inner-edge mode on a board
// that needs it, and one that succeeds on unplated art would offer a mode that
// traces nothing. So the answer is declared here and the extractor is told,
// rather than the other way round.
//
// Deliberately keyed by LAYOUT, not by board: Kilter ships both the Homewall
// (layout 8, plated) and the Original (layout 1, not), so a board-level answer
// would be wrong for one of them. That is also why this is not a row in
// `getBoardCapabilities` — that table answers per-board product questions.
//
// Not in the database either: `board_layouts` is a sync mirror of Aurora's own
// catalogue, so a Boardsesh-owned column there is overwritten by the next sync,
// and the code-driven boards (MoonBoard, Woods) are not populated into it the
// same way. Adding a layout here is a one-line reviewable change that both the
// mobile editor and the offline generator read.

import type { BoardName } from '@boardsesh/shared-schema';

/**
 * Layout ids, per board, whose art carries a two-tone LED base plate.
 *
 * Absent board → no plated layouts, which is the honest default: a board earns a
 * row here by someone looking at its art and seeing a plate.
 */
const PLATED_LAYOUTS_BY_BOARD: Partial<Record<BoardName, ReadonlySet<number>>> = {
  // Kilter Board Homewall (layout 8). The Original (layout 1) bolts its holds
  // straight to the panel and has no plate.
  kilter: new Set([8]),
};

/**
 * Does this board layout mount its holds on a lit LED base plate?
 *
 * Drives whether the hold-outline editor offers the inner-edge mode at all, and
 * whether the generator's plate extractor runs. Case-insensitive on the board
 * name; an unknown board answers `false`.
 */
export function hasLedBasePlate(boardName: string | undefined, layoutId: number): boolean {
  if (!boardName) return false;
  const platedLayouts = PLATED_LAYOUTS_BY_BOARD[boardName.toLowerCase() as BoardName];
  return platedLayouts?.has(layoutId) ?? false;
}
