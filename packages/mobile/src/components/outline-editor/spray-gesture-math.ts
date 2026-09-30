/**
 * The hold editor's UI-thread math, as pure functions.
 *
 * Each one carries the `'worklet'` directive so the gesture overlay can call it
 * from a gesture callback without a hop to JS (the directive is an inert string
 * in plain JS and in the test runner) — the same pattern as
 * `play-drawer/queue-drag-math.ts`. Split out so the parity with the JS-side
 * hit test (`holdAtPoint`) is a unit test rather than a hope.
 */

import { HIT_FALLBACK_SCREEN_PT, HIT_RADIUS_MULTIPLE, type HoldGeometry } from './spray-hold-tools';

/** Numbers per hold in a flat hit list: id, cx, cy, r. */
export const HIT_STRIDE = 4;

/**
 * A screen point on the gesture overlay → board px.
 *
 * The inverse of the board's `animatedZoomStyle` (translate, then scale about
 * the container centre), followed by the render → board scale. The tested twin
 * of this is `screenToBoardPoint` in `stroke.ts`; `DrawStrokeOverlay` inlines
 * the same arithmetic.
 */
export function screenToBoard(
  screenX: number,
  screenY: number,
  scale: number,
  translateX: number,
  translateY: number,
  containerWidth: number,
  containerHeight: number,
  boardScale: number,
): { x: number; y: number } {
  'worklet';
  const centreX = containerWidth / 2;
  const centreY = containerHeight / 2;
  const renderX = (screenX - translateX - centreX) / scale + centreX;
  const renderY = (screenY - translateY - centreY) / scale + centreY;
  return { x: renderX * boardScale, y: renderY * boardScale };
}

/**
 * {@link HIT_FALLBACK_SCREEN_PT} as a radius in board px, at a board-per-render
 * scale and a zoom. The grab area of a tiny hold stays a fingertip wide on
 * screen, and shrinks back towards the hold itself as the climber zooms in.
 */
export function fallbackRadiusAt(boardScale: number, scale: number): number {
  'worklet';
  return (HIT_FALLBACK_SCREEN_PT * boardScale) / Math.max(1, scale);
}

/** Holds → the flat `[id, cx, cy, r, ...]` list a worklet can scan without allocating. */
export function flattenHitHolds(holds: readonly (HoldGeometry & { id: number })[]): number[] {
  const flat: number[] = [];
  for (const hold of holds) flat.push(hold.id, hold.cx, hold.cy, hold.r);
  return flat;
}

/**
 * The hold id at a board point, or 0 for bare wall.
 *
 * The UI-thread twin of `holdAtPoint` (smallest containing hold first, then the
 * nearest centre within `max(1.4r, fallback)`), over the flat list. 0 is safe as
 * "none": stored ids are positive and local ones negative.
 */
export function holdIdAtPoint(flat: readonly number[], x: number, y: number, fallbackRadius: number): number {
  'worklet';
  let containingId = 0;
  let containingRadius = Infinity;
  let nearestId = 0;
  let nearestDistance = Infinity;
  for (let index = 0; index + HIT_STRIDE - 1 < flat.length; index += HIT_STRIDE) {
    const radius = flat[index + 3];
    const distance = Math.hypot(x - flat[index + 1], y - flat[index + 2]);
    if (distance <= radius) {
      if (radius < containingRadius) {
        containingRadius = radius;
        containingId = flat[index];
      }
      continue;
    }
    if (containingId !== 0) continue;
    if (distance > Math.max(radius * HIT_RADIUS_MULTIPLE, fallbackRadius)) continue;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestId = flat[index];
    }
  }
  return containingId !== 0 ? containingId : nearestId;
}

/**
 * Does a touch at a board point land on the selected hold (`[id, cx, cy, r]`)?
 *
 * Generous on purpose — the hold's own radius or a fingertip, whichever is
 * bigger — because this only decides whether a DRAG moves the hold. A touch
 * that turns out to be a tap is still resolved by the full hit test.
 */
export function landsOnSelected(selected: readonly number[], x: number, y: number, fallbackRadius: number): boolean {
  'worklet';
  if (selected.length < HIT_STRIDE) return false;
  return Math.hypot(x - selected[1], y - selected[2]) <= Math.max(selected[3], fallbackRadius);
}
