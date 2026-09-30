/**
 * The screen-reader path through the spray-wall hold editor, as pure functions.
 *
 * The rings are one drawing, not one view each (a wall can carry 1500 holds),
 * so VoiceOver and TalkBack cannot focus a single hold. Instead the wall is one
 * adjustable element whose swipe up / swipe down walks a cursor through the
 * holds in reading order, and the screen selects each one it lands on — which
 * is what brings up the chip bar, the editor's accessible set of hold tools.
 */

import { ROW_TOLERANCE_RADII, spatialPlacementOrder, stepPlacement } from './hold-navigation';
import type { HoldGeometry } from './spray-hold-tools';

/**
 * Every hold in reading order: rows top to bottom, left to right within a row.
 *
 * Rows are bucketed against ONE radius — the wall's median hold radius — rather
 * than each row's first hold, as the catalogue editor's walk does. A spray wall
 * mixes crimps and jugs, and anchoring the tolerance on whichever hold happens
 * to start a row would make a row that starts on a crimp split in two and one
 * that starts on a jug swallow the row below it.
 */
export function sprayHoldReadingOrder(
  holds: readonly (HoldGeometry & { id: number })[],
  rowRadius: number,
  rowToleranceRadii: number = ROW_TOLERANCE_RADII,
): number[] {
  const radius = rowRadius > 0 ? rowRadius : 0;
  return spatialPlacementOrder(
    holds.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy, r: radius })),
    rowToleranceRadii,
  );
}

/** Hold id → its index in a reading order, so a swipe and the spoken position are O(1). */
export function readingOrderIndex(order: readonly number[]): Map<number, number> {
  const indexById = new Map<number, number>();
  order.forEach((id, index) => indexById.set(id, index));
  return indexById;
}

/**
 * The hold one swipe forward (`1`) or back (`-1`) from `currentId`, wrapping at
 * both ends. No cursor yet — or a cursor on a hold that has since gone (removed,
 * joined, hidden) — enters at the first hold going forward and the last going
 * back. `null` only when there are no holds at all.
 */
export function stepReadingCursor(
  order: readonly number[],
  indexById: ReadonlyMap<number, number>,
  currentId: number | null,
  delta: 1 | -1,
): number | null {
  const currentIndex = currentId != null ? (indexById.get(currentId) ?? null) : null;
  return stepPlacement(order, currentIndex, delta);
}

/** Where a hold sits in the walk, 1-based, for "Hold 12 of 213". `null` when it is not in it. */
export function readingCursorPosition(
  indexById: ReadonlyMap<number, number>,
  id: number | null,
): { position: number; total: number } | null {
  if (id == null) return null;
  const index = indexById.get(id);
  if (index == null) return null;
  return { position: index + 1, total: indexById.size };
}
