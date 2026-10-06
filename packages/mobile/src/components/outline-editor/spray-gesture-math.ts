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

/** The handle's touch box, in screen points: the 44 pt floor, whatever the zoom. */
export const RESIZE_HANDLE_HIT_PT = 44;
/** Bare space between the hold's own disc and the handle's touch box, in screen points. */
export const RESIZE_HANDLE_CLEARANCE_PT = 2;

/**
 * {@link HIT_FALLBACK_SCREEN_PT} as it lands on screen at a zoom: a fingertip
 * at 1x and above, shrinking with the board below it (the same `max(1, scale)`
 * as {@link fallbackRadiusAt}).
 */
export function fingertipScreenPt(scale: number): number {
  'worklet';
  return (HIT_FALLBACK_SCREEN_PT * scale) / Math.max(1, scale);
}

/**
 * How far the handle's dot sits from the hold's centre, in screen points.
 *
 * The touch box is turned 45° so a flat face looks at the hold, and that face
 * stays {@link RESIZE_HANDLE_CLEARANCE_PT} outside the hold's own disc: its
 * farthest point, or a fingertip, whichever is bigger. That disc is where a
 * tap, a pick-up or a drag of the selected ring lands, so the handle never sits
 * over the ring it resizes, at any zoom. The dot is the box's centre, so a
 * small hold at 1x gets its dot 46 pt out, and a big or zoomed one 24 pt past
 * its farthest point.
 */
export function resizeHandleDistance(reachPt: number, fingertipPt: number): number {
  'worklet';
  return Math.max(0, reachPt, fingertipPt) + RESIZE_HANDLE_HIT_PT / 2 + RESIZE_HANDLE_CLEARANCE_PT;
}

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
 * Where the resize handle goes for a hold whose centre is at `centre` on screen,
 * whose farthest point is `reachPt` screen points out, and whose fingertip grab
 * radius is `fingertipPt`.
 *
 * It sits {@link resizeHandleDistance} out on the bottom-right diagonal, and
 * flips to the next diagonal (bottom-left, top-right, top-left) whenever its
 * touch box — a 44 pt square turned 45°, so 62 pt across corner to corner —
 * would leave the viewport or touch one of `avoidRects` (the chip bar and the
 * bottom bar). When no diagonal is clear it
 * takes the first whose dot is at least on screen and uncovered, and failing
 * even that, bottom-right. Placed in screen space, so it is the same size at any
 * zoom.
 */
export function resizeHandleAnchor(
  centre: { x: number; y: number },
  reachPt: number,
  fingertipPt: number,
  viewport: { width: number; height: number },
  avoidRects: readonly ScreenRect[],
): ResizeHandleAnchor {
  'worklet';
  const distance = resizeHandleDistance(reachPt, fingertipPt);
  // The turned box's corners reach this far along each axis.
  const half = RESIZE_HANDLE_HIT_PT * DIAGONAL;
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

/** The loupe's circle, in points. */
export const LOUPE_SIZE_PT = 112;
/** How far the loupe's centre sits from the touch: straight up, or out to one side. */
export const LOUPE_OFFSET_PT = 88;
/** The loupe shows the board this many times bigger than the zoom it is at… */
export const LOUPE_ZOOM_MULTIPLE = 2;
/** …up to this many times the unzoomed board. */
export const LOUPE_MAX_MAGNIFICATION = 12;
/** A touch this young that has not moved is still maybe a tap: no loupe yet. */
export const LOUPE_DELAY_MS = 120;
/** A touch that has moved this far is not a tap, however young. */
export const LOUPE_SLOP_PT = 4;
/**
 * Room needed above the touch, past a bare fit, before a loupe that went to the
 * side comes back above. Without it a finger resting right at the boundary
 * would flick the loupe between the two every frame.
 */
export const LOUPE_RETURN_MARGIN_PT = 12;

/** Where the loupe sits relative to the touch. */
export type LoupeSide = 'above' | 'left' | 'right';

/** The loupe's centre, in the host's points, and which side of the touch it is on. */
export type LoupePlacement = { x: number; y: number; side: LoupeSide };

/** How many times the loupe magnifies the unzoomed board, at a board zoom. */
export function loupeMagnification(scale: number): number {
  'worklet';
  return Math.min(Math.max(scale, 0) * LOUPE_ZOOM_MULTIPLE, LOUPE_MAX_MAGNIFICATION);
}

/** True once a touch has lasted {@link LOUPE_DELAY_MS} or moved {@link LOUPE_SLOP_PT}: a tap never flashes the loupe. */
export function loupeGateOpen(elapsedMs: number, movedPt: number): boolean {
  'worklet';
  return elapsedMs >= LOUPE_DELAY_MS || movedPt >= LOUPE_SLOP_PT;
}

function clampCentre(value: number, min: number, max: number): number {
  'worklet';
  // A host smaller than the loupe pins it to the near edge rather than inverting.
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where the loupe goes for a touch at `(touchX, touchY)` in a `width` × `height`
 * host, for a loupe `size` points across that must stay below `topSafe`.
 *
 * Its centre sits {@link LOUPE_OFFSET_PT} straight above the touch, so the
 * finger never covers it. When there is no room above it moves the same
 * distance out to one side, level with the touch: left by default, right when
 * left would leave the host. It keeps the side it had (`prevSide`) for as long
 * as that side fits, so it does not jump across the finger as the finger
 * slides, and it only comes back above once there is
 * {@link LOUPE_RETURN_MARGIN_PT} to spare. Whatever the side, it is clamped
 * inside the host.
 */
export function loupePlacement(
  touchX: number,
  touchY: number,
  width: number,
  height: number,
  size: number,
  topSafe: number,
  prevSide: LoupeSide,
): LoupePlacement {
  'worklet';
  const half = size / 2;
  const minX = half;
  const maxX = width - half;
  const minY = topSafe + half;
  const maxY = height - half;
  const aboveY = touchY - LOUPE_OFFSET_PT;
  const margin = prevSide === 'above' ? 0 : LOUPE_RETURN_MARGIN_PT;
  if (aboveY - half >= topSafe + margin) {
    return { x: clampCentre(touchX, minX, maxX), y: clampCentre(aboveY, minY, maxY), side: 'above' };
  }
  const leftX = touchX - LOUPE_OFFSET_PT;
  const rightX = touchX + LOUPE_OFFSET_PT;
  const leftFits = leftX - half >= 0;
  const rightFits = rightX + half <= width;
  let side: LoupeSide;
  if (prevSide === 'right' && rightFits) side = 'right';
  else if (leftFits) side = 'left';
  else if (rightFits) side = 'right';
  // Neither fits (a host under twice the offset plus the loupe): stay put.
  else side = prevSide === 'right' ? 'right' : 'left';
  return {
    x: clampCentre(side === 'left' ? leftX : rightX, minX, maxX),
    y: clampCentre(touchY, minY, maxY),
    side,
  };
}

/**
 * The translate that puts render point `(renderX, renderY)` of a board-sized
 * view, scaled by `magnification`, at the centre of a loupe `size` points
 * across.
 *
 * The view is laid out at the loupe's top-left and transformed with
 * `[translateX, translateY, scale]`. RN scales about the view's own centre `c`
 * and then translates, so a point `p` lands at `c + t + (p − c)·m`; setting
 * that to `size / 2` gives `t = size/2 − c − (p − c)·m`.
 */
export function loupeInnerTransform(
  renderX: number,
  renderY: number,
  magnification: number,
  size: number,
  renderWidth: number,
  renderHeight: number,
): { translateX: number; translateY: number } {
  'worklet';
  const centreX = renderWidth / 2;
  const centreY = renderHeight / 2;
  return {
    translateX: size / 2 - centreX - (renderX - centreX) * magnification,
    translateY: size / 2 - centreY - (renderY - centreY) * magnification,
  };
}
