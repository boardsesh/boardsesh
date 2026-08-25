/**
 * True when a board can answer a hold-type or board-region (zone) search.
 *
 * Woods can't yet, for two independent reasons:
 *
 * 1. Online hold search resolves the picked hold ids against `board_placements`,
 *    and Woods has no rows there — it is code-driven geometry, imported without
 *    hardware. Every Woods hold search would come back empty with nothing on
 *    screen to explain why.
 * 2. The zone box is expressed in placement-grid space (`edge_left`/`edge_top`
 *    and friends). Woods hold centres are CV-detected board-art PIXELS, so a box
 *    dragged over the art doesn't map to the coordinates the query filters on.
 *
 * So the Holds and Zone rows are HIDDEN for Woods rather than left to return
 * silent zero results, and the two full-screen picker routes bail out if a
 * hand-built link reaches them anyway.
 *
 * Follow-up: seed `board_placements` for Woods the way
 * `packages/db/scripts/backfill-moonboard-hardware.ts` seeds MoonBoard, and give
 * the zone box a Woods-native (pixel-space) mapping. Both filters light up for
 * Woods the moment that lands — this gate is the only thing holding them back.
 *
 * Every other board keeps both filters exactly as they were.
 */
export function supportsHoldFilters(boardName: string | undefined): boolean {
  return boardName !== 'woods';
}
