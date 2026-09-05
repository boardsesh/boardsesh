// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { MOONBOARD_CELL_SETS } from './generated/moonboard-cell-sets';

export { MOONBOARD_CELL_SETS };

// Frames encode holds as `p{holdId}r{roleCode}` (e.g. "p5r42p45r43"). Pull out
// the hold ids — the same `p(\d+)r` shape the Aurora denormalizer keys off.
const HOLD_ID_PATTERN = /p(\d+)r/g;

/** Extract the grid-cell hold ids from a MoonBoard `frames` string. */
export function parseHoldIdsFromFrames(frames: string): number[] {
  const holdIds: number[] = [];
  for (const match of frames.matchAll(HOLD_ID_PATTERN)) {
    holdIds.push(Number(match[1]));
  }
  return holdIds;
}

/** The hold set a grid cell belongs to on a layout, or undefined if uncovered. */
export function moonBoardCellSet(layoutId: number, holdId: number): number | undefined {
  return MOONBOARD_CELL_SETS[layoutId]?.[holdId];
}

/**
 * The distinct hold sets a MoonBoard climb needs, derived from the cells its
 * holds occupy (see MOONBOARD_CELL_SETS). Mirrors Aurora's `required_set_ids`:
 * a climb is climbable with a given set selection iff its required sets are a
 * subset of the selected sets. Returns a sorted, deduped array; cells with no
 * known set (uncovered positions) contribute nothing.
 */
export function requiredSetIdsForMoonBoard(layoutId: number, frames: string): number[] {
  const cells = MOONBOARD_CELL_SETS[layoutId];
  if (!cells) return [];
  const setIds = new Set<number>();
  for (const holdId of parseHoldIdsFromFrames(frames)) {
    const setId = cells[holdId];
    if (setId !== undefined) setIds.add(setId);
  }
  return [...setIds].sort((a, b) => a - b);
}
