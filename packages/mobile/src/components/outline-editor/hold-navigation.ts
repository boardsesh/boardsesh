/**
 * Walking the board hold by hold, and framing the one you land on.
 *
 * Correcting outlines is a mass-edit job — a Kilter 12x12 carries hundreds of
 * placements — so the editor has to answer two questions without the user
 * hunting: which hold comes next, and how do I get a close look at it.
 *
 * Both answers are pure functions here so they can be tested without a board on
 * screen. The transform maths mirrors `use-zoom-pan-gesture`; see
 * {@link zoomTargetForHold} for the exact relationship and why it has to stay in
 * step.
 */

import { MAX_SCALE, MIN_SCALE } from '@boardsesh/play-view';
import type { BoardHoldTarget } from '../../lib/create-board-holds';

/**
 * How far apart two holds' centres may sit vertically and still count as the
 * same row, in units of the row's own placement radius.
 *
 * Aurora boards lay holds out on an even grid, so anything under a radius is
 * comfortably "same row" and the next row up is several radii away. Measured
 * against the row's ANCHOR rather than the previous hold, so a row that drifts
 * gradually across the board can't chain one tolerance into the next and
 * swallow the row above it.
 */
export const ROW_TOLERANCE_RADII = 0.8;

/**
 * How much board around the hold to keep in frame, in units of its radius. The
 * hold plus this much context is what the zoom tries to fill the viewport with.
 */
export const ZOOM_CONTEXT_RADII = 1.5;

/**
 * Every placement in reading order: rows top to bottom, and left to right
 * within each row.
 *
 * `cy` grows downward (it is board-image space, not climbing-wall space — see
 * `holdGeometry`), so ascending `cy` really is top-first.
 */
export function spatialPlacementOrder(
  holds: readonly BoardHoldTarget[],
  rowToleranceRadii: number = ROW_TOLERANCE_RADII,
): number[] {
  if (holds.length === 0) return [];

  // Ties broken by cx so the row-bucketing walk is deterministic for holds that
  // share a cy exactly — which on a grid-laid-out board is most of them.
  const byRowThenColumn = [...holds].sort((left, right) => left.cy - right.cy || left.cx - right.cx);

  const rows: BoardHoldTarget[][] = [];
  let currentRow: BoardHoldTarget[] = [];
  let anchor: BoardHoldTarget | null = null;

  for (const hold of byRowThenColumn) {
    const belongsToCurrentRow = anchor != null && Math.abs(hold.cy - anchor.cy) <= anchor.r * rowToleranceRadii;
    if (belongsToCurrentRow) {
      currentRow.push(hold);
      continue;
    }
    if (currentRow.length > 0) rows.push(currentRow);
    currentRow = [hold];
    anchor = hold;
  }
  if (currentRow.length > 0) rows.push(currentRow);

  const ordered: number[] = [];
  for (const row of rows) {
    for (const hold of [...row].sort((left, right) => left.cx - right.cx)) {
      ordered.push(hold.id);
    }
  }
  return ordered;
}

/**
 * The placement one step forward (`1`) or back (`-1`) from `current`, wrapping
 * at both ends so a long correction pass never dead-ends.
 *
 * With nothing selected, stepping forward starts at the first hold and stepping
 * back starts at the last — so either button is a valid way in. A `current` that
 * isn't in the order (a stale selection after a config change) is treated the
 * same way.
 */
export function stepPlacement(order: readonly number[], current: number | null, delta: 1 | -1): number | null {
  if (order.length === 0) return null;
  const currentIndex = current == null ? -1 : order.indexOf(current);
  if (currentIndex === -1) return delta === 1 ? order[0] : order[order.length - 1];
  const nextIndex = (currentIndex + delta + order.length) % order.length;
  return order[nextIndex];
}

/** A board zoom transform, in the shape `use-zoom-pan-gesture` holds it. */
export type BoardZoomTarget = {
  scale: number;
  translateX: number;
  translateY: number;
};

/**
 * Worklet-free twin of `clampTranslation` in `use-zoom-pan-gesture`. Keeping the
 * board inside its own frame is the pan gesture's rule, and a programmatic zoom
 * has to obey it too or the first manual pan afterwards would snap.
 */
function clampTranslation(translation: number, scale: number, extent: number): number {
  if (scale <= MIN_SCALE) return 0;
  const limit = (extent * (scale - 1)) / 2;
  return Math.max(-limit, Math.min(limit, translation));
}

/**
 * The transform that puts one hold in the middle of the viewport at a scale you
 * can trace at.
 *
 * The board is drawn `transform: [translateX, translateY, scale]` about a centre
 * origin, so a board-local point maps to the screen as
 *
 *     screen = centre + scale * (local - centre) + translate
 *
 * Setting `screen = centre` and solving gives `translate = -scale * (local -
 * centre)`, which is the whole of the centring maths below. The result is then
 * clamped exactly as a manual pan would be, so a hold near an edge frames as far
 * as the board allows and no further.
 *
 * NOTE on the scale: for every Aurora config in the catalogue the ideal scale
 * works out well above `MAX_SCALE`, so the answer saturates at the gesture
 * system's ceiling of 4 and `contextRadii` never bites. That is deliberate —
 * this stays clamped to the same range pinch-to-zoom uses rather than giving the
 * editor a private zoom range — but it does mean "how close do we get" is
 * currently a property of `MAX_SCALE`, not of this function.
 */
export function zoomTargetForHold({
  hold,
  boardWidth,
  renderWidth,
  renderHeight,
  contextRadii = ZOOM_CONTEXT_RADII,
  minScale = MIN_SCALE,
  maxScale = MAX_SCALE,
}: {
  hold: BoardHoldTarget;
  boardWidth: number;
  renderWidth: number;
  renderHeight: number;
  contextRadii?: number;
  minScale?: number;
  maxScale?: number;
}): BoardZoomTarget {
  if (boardWidth <= 0 || renderWidth <= 0 || renderHeight <= 0) {
    return { scale: minScale, translateX: 0, translateY: 0 };
  }

  // The board is drawn to its own aspect ratio, so one factor converts both axes.
  const renderScale = renderWidth / boardWidth;
  const holdRadiusRenderPx = hold.r * renderScale;

  // Half-extent we want visible: the hold plus its context ring.
  const desiredHalfExtent = holdRadiusRenderPx * (1 + contextRadii);
  const viewportHalfExtent = Math.min(renderWidth, renderHeight) / 2;
  const idealScale = desiredHalfExtent > 0 ? viewportHalfExtent / desiredHalfExtent : maxScale;
  const scale = Math.max(minScale, Math.min(maxScale, idealScale));

  const localX = hold.cx * renderScale;
  const localY = hold.cy * renderScale;
  const centreX = renderWidth / 2;
  const centreY = renderHeight / 2;

  return {
    scale,
    translateX: clampTranslation(-scale * (localX - centreX), scale, renderWidth),
    translateY: clampTranslation(-scale * (localY - centreY), scale, renderHeight),
  };
}
