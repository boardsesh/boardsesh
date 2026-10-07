/**
 * Walking the board hold by hold, and framing the one you land on.
 *
 * Correcting outlines is a mass-edit job — a Kilter 12x12 carries hundreds of
 * placements — so the editor has to answer two questions without the user
 * hunting: which hold comes next, and how do I get a close look at it.
 *
 * Both answers are pure functions here so they can be tested without a board on
 * screen. The transform maths mirrors `use-zoom-pan-gesture`, and the pan clamp
 * is the same function the gesture calls; see {@link zoomTargetForHold}.
 */

import { MAX_SCALE, MIN_SCALE } from '@boardsesh/play-view';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { clampAxisTranslation, type ZoomViewport } from '../play-drawer/zoom-viewport-clamp';

/**
 * How far apart two holds' centres may sit vertically and still count as the
 * same row, in units of the row's own placement radius.
 *
 * Aurora boards lay holds out on an even grid, so anything under a radius is
 * comfortably "same row" and the next row up is several radii away. Measured
 * against the row's ANCHOR rather than the previous hold, so a row that drifts
 * gradually across the board can't chain one tolerance into the next and
 * swallow the row above it.
 *
 * ASSUMES a roughly uniform placement radius: the tolerance comes from the
 * anchor, so a row whose first hold is unusually small would bucket tightly (and
 * one whose first hold is unusually large, loosely). Every board in the
 * catalogue derives `r` from a single grid spacing (`xSpacing * 4` in
 * `board-details`), so in practice every hold on a config shares one radius. A
 * future board with genuinely mixed hold sizes would want a per-config radius
 * (median, say) instead of the anchor's.
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
 * The placement one step forward (`1`) or back (`-1`) from the one at
 * `currentIndex`, wrapping at both ends so a long correction pass never
 * dead-ends.
 *
 * Takes the INDEX, not the placement id, so a button press stays O(1): the
 * caller already keeps a position-by-id Map for the "14 / 499" counter, and
 * looking the id up there beats scanning the order on every press of a
 * several-hundred-placement board.
 *
 * `null` means nothing is selected — or the selection is no longer on this board
 * (a stale id after a config change), which the caller's Map reports the same
 * way. Either enters at the first hold going forward and the last going back, so
 * both buttons are a valid way in.
 */
export function stepPlacement(order: readonly number[], currentIndex: number | null, delta: 1 | -1): number | null {
  if (order.length === 0) return null;
  if (currentIndex == null || currentIndex < 0 || currentIndex >= order.length) {
    return delta === 1 ? order[0] : order[order.length - 1];
  }
  return order[(currentIndex + delta + order.length) % order.length];
}

/** A board zoom transform, in the shape `use-zoom-pan-gesture` holds it. */
export type BoardZoomTarget = {
  scale: number;
  translateX: number;
  translateY: number;
};

/**
 * The transform that puts one hold in the middle of the viewport at a scale you
 * can trace at.
 *
 * The board is drawn `transform: [translateX, translateY, scale]` about a centre
 * origin, so a board-local point maps to the screen as
 *
 *     screen = offset + centre + scale * (local - centre) + translate
 *
 * where `offset` is where the unzoomed board sits in its viewport (0 without
 * one). Setting `screen` to the middle of the viewport's visible band and
 * solving gives `translate = bandMiddle - offset - centre - scale * (local -
 * centre)`; without a viewport the band's middle is the centre and that is
 * `-scale * (local - centre)`. The result is then clamped exactly as a manual
 * pan would be (`clampAxisTranslation`, the very function the pan calls), so a
 * hold near an edge frames as far as the board allows and no further.
 *
 * The scale still comes from the render box, not the viewport: the context ring
 * fits the photo's own frame, so a bigger viewport shows more wall round the
 * hold rather than zooming in further.
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
  viewport,
}: {
  hold: BoardHoldTarget;
  boardWidth: number;
  renderWidth: number;
  renderHeight: number;
  contextRadii?: number;
  minScale?: number;
  maxScale?: number;
  /** The board's zoom viewport, when it has one (see `useZoomPanGesture`). */
  viewport?: ZoomViewport;
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
  const offsetX = viewport?.offsetX ?? 0;
  const offsetY = viewport?.offsetY ?? 0;
  const bandStartX = viewport?.bandStartX ?? 0;
  const bandEndX = viewport?.bandEndX ?? renderWidth;
  const bandStartY = viewport?.bandStartY ?? 0;
  const bandEndY = viewport?.bandEndY ?? renderHeight;
  // How far the band's middle sits from the transform's origin: 0 without a viewport.
  const shiftX = (bandStartX + bandEndX) / 2 - offsetX - centreX;
  const shiftY = (bandStartY + bandEndY) / 2 - offsetY - centreY;

  return {
    scale,
    translateX: clampAxisTranslation(
      shiftX - scale * (localX - centreX),
      scale,
      renderWidth,
      offsetX,
      bandStartX,
      bandEndX,
    ),
    translateY: clampAxisTranslation(
      shiftY - scale * (localY - centreY),
      scale,
      renderHeight,
      offsetY,
      bandStartY,
      bandEndY,
    ),
  };
}
