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
 *
 * `live`, when given as `[id, cx, cy, r]`, stands in for that hold's entry in
 * the list — the selected hold's preview can be a frame ahead of the list the
 * screen last mirrored (a move folds into it before JS re-renders).
 */
export function holdIdAtPoint(
  flat: readonly number[],
  x: number,
  y: number,
  fallbackRadius: number,
  live?: readonly number[],
): number {
  'worklet';
  const liveId = live !== undefined && live.length >= HIT_STRIDE ? live[0] : 0;
  let containingId = 0;
  let containingRadius = Infinity;
  let nearestId = 0;
  let nearestDistance = Infinity;
  // Index -HIT_STRIDE is the live hold (when there is one); the rest is the list.
  for (let index = liveId !== 0 ? -HIT_STRIDE : 0; index + HIT_STRIDE - 1 < flat.length; index += HIT_STRIDE) {
    // Read the live hold from its own array, never from `flat`.
    const source = index < 0 && live !== undefined ? live : flat;
    const offset = index < 0 ? 0 : index;
    const id = source[offset];
    if (source === flat && id === liveId) continue;
    const radius = source[offset + 3];
    const distance = Math.hypot(x - source[offset + 1], y - source[offset + 2]);
    if (distance <= radius) {
      if (radius < containingRadius) {
        containingRadius = radius;
        containingId = id;
      }
      continue;
    }
    if (containingId !== 0) continue;
    if (distance > Math.max(radius * HIT_RADIUS_MULTIPLE, fallbackRadius)) continue;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestId = id;
    }
  }
  return containingId !== 0 ? containingId : nearestId;
}

/**
 * The selected hold's id when a touch at this board point should DRAG it, or 0.
 *
 * The touch has to land within the selected hold's grab radius (its own radius
 * or a fingertip, whichever is bigger) AND the full hit test at that point has
 * to name the selected hold. The second half is what stops a touch on a
 * neighbour that happens to sit inside a big selection's grab radius from
 * claiming a drag of the selection: that touch belongs to the neighbour — a
 * tap toggles it, a long press picks it up — and a drag started there must
 * never move a hold the finger is not on.
 */
export function selectedDragIdAt(
  flat: readonly number[],
  selected: readonly number[],
  x: number,
  y: number,
  fallbackRadius: number,
): number {
  'worklet';
  if (selected.length < HIT_STRIDE) return 0;
  if (Math.hypot(x - selected[1], y - selected[2]) > Math.max(selected[3], fallbackRadius)) return 0;
  return holdIdAtPoint(flat, x, y, fallbackRadius, selected) === selected[0] ? selected[0] : 0;
}

/**
 * A board point → a screen point on the gesture overlay. The exact inverse of
 * {@link screenToBoard}: board → render px, then the board's
 * `animatedZoomStyle` (scale about the container centre, then translate).
 */
export function boardToScreen(
  boardX: number,
  boardY: number,
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
  const renderX = boardScale > 0 ? boardX / boardScale : 0;
  const renderY = boardScale > 0 ? boardY / boardScale : 0;
  return {
    x: (renderX - centreX) * scale + centreX + translateX,
    y: (renderY - centreY) * scale + centreY + translateY,
  };
}

/**
 * A hold's farthest reach from its centre, in board px: its traced ring can
 * stick out past `r`, a plain circle cannot.
 */
export function holdReach(hold: HoldGeometry): number {
  'worklet';
  let reach = hold.r;
  const outline = hold.outline;
  if (outline) {
    for (let index = 0; index + 1 < outline.length; index += 2) {
      reach = Math.max(reach, Math.hypot(outline[index], outline[index + 1]) * hold.r);
    }
  }
  return reach;
}

/** An axis-aligned box in overlay points. */
export type ScreenRect = { x: number; y: number; width: number; height: number };

/** The resize handle's dot: where it sits and the outward direction a drag is measured along. */
export type ResizeHandleAnchor = { x: number; y: number; ux: number; uy: number };

/** Gap between the hold's farthest point and the handle's dot, in screen points. */
export const RESIZE_HANDLE_GAP_PT = 10;
/** The handle's touch box, in screen points: the 44 pt floor, whatever the zoom. */
export const RESIZE_HANDLE_HIT_PT = 44;

const DIAGONAL = Math.SQRT1_2;
/** The diagonals the handle tries, in order: bottom-right first, where a right thumb reaches. */
const HANDLE_DIRECTIONS: readonly (readonly [number, number])[] = [
  [DIAGONAL, DIAGONAL],
  [-DIAGONAL, DIAGONAL],
  [DIAGONAL, -DIAGONAL],
  [-DIAGONAL, -DIAGONAL],
];

function boxOverlaps(centreX: number, centreY: number, half: number, rect: ScreenRect): boolean {
  'worklet';
  return (
    centreX + half > rect.x &&
    centreX - half < rect.x + rect.width &&
    centreY + half > rect.y &&
    centreY - half < rect.y + rect.height
  );
}

/**
 * Where the resize handle goes for a hold whose centre is at `centre` on screen
 * and whose farthest point is `reachPt` screen points out.
 *
 * It sits {@link RESIZE_HANDLE_GAP_PT} outside that point on the bottom-right
 * diagonal, and flips to the next diagonal (bottom-left, top-right, top-left)
 * whenever its 44 pt touch box would leave the viewport or touch one of
 * `avoidRects` (the chip bar and the bottom bar). When no diagonal is clear it
 * takes the first whose dot is at least on screen and uncovered, and failing
 * even that, bottom-right. Placed in screen space, so it is the same size at any
 * zoom.
 */
export function resizeHandleAnchor(
  centre: { x: number; y: number },
  reachPt: number,
  viewport: { width: number; height: number },
  avoidRects: readonly ScreenRect[],
): ResizeHandleAnchor {
  'worklet';
  const distance = Math.max(0, reachPt) + RESIZE_HANDLE_GAP_PT;
  const half = RESIZE_HANDLE_HIT_PT / 2;
  let fallbackIndex = -1;
  for (let index = 0; index < HANDLE_DIRECTIONS.length; index += 1) {
    const [ux, uy] = HANDLE_DIRECTIONS[index];
    const x = centre.x + ux * distance;
    const y = centre.y + uy * distance;
    let covered = false;
    let dotCovered = false;
    for (let rectIndex = 0; rectIndex < avoidRects.length; rectIndex += 1) {
      if (boxOverlaps(x, y, half, avoidRects[rectIndex])) covered = true;
      if (boxOverlaps(x, y, 0, avoidRects[rectIndex])) dotCovered = true;
    }
    const boxInside = x - half >= 0 && y - half >= 0 && x + half <= viewport.width && y + half <= viewport.height;
    if (boxInside && !covered) return { x, y, ux, uy };
    const dotInside = x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
    if (fallbackIndex < 0 && dotInside && !dotCovered) fallbackIndex = index;
  }
  const [ux, uy] = HANDLE_DIRECTIONS[fallbackIndex < 0 ? 0 : fallbackIndex];
  return { x: centre.x + ux * distance, y: centre.y + uy * distance, ux, uy };
}

/** A drag `(dx, dy)` measured along the unit vector `(ux, uy)`: positive is outward. */
export function projectOnto(dx: number, dy: number, ux: number, uy: number): number {
  'worklet';
  return dx * ux + dy * uy;
}
