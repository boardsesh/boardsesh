/**
 * The outline editor's coordinate chain, as pure functions.
 *
 * A stylus sample arrives in screen px relative to the board container and has
 * to end up as a stored ring in units of the placement radius. Four frames are
 * involved and mixing them silently produces a plausible-looking ring in the
 * wrong place, so each hop lives here as its own named function with a test:
 *
 *   1. screen px  → board-local RENDER px   `screenToRenderPoint` (invert zoom)
 *   2. render px  → BOARD px                `renderToBoardScale`
 *   3. board px   → a simplified ring       `buildOutlineRing`
 *   4. board px   → RADIUS units            (inside `buildOutlineRing`)
 *
 * Step 1 has a worklet twin in `DrawStrokeOverlay` (reanimated can't reliably
 * call a cross-module worklet — the same split `use-zoomed-hold-tap-gesture`
 * makes against `inverseTransformPoint`). Keep the two in sync; the round-trip
 * test in `__tests__/stroke.test.ts` pins the algebra either way.
 *
 * MIND THE UNITS. `SIMPLIFY_EPSILON_BOARD_PX` is quoted in BOARD pixels, which
 * is why simplification happens BEFORE the divide-through by the placement
 * radius, not after — see the constant's own note in
 * `@boardsesh/board-art-geometry/ring`.
 */

import {
  CENTRE_TOLERANCE_RADII,
  MAX_RING_COORDINATE,
  MAX_RING_NUMBERS,
  MIN_RING_NUMBERS,
  SIMPLIFY_EPSILON_BOARD_PX,
  closeRing,
  distanceToRing,
  pointInRing,
  roundRing,
  simplifyRing,
  type RingPoint,
} from '@boardsesh/board-art-geometry/ring';
import { inverseTransformPoint } from '../create-climb/holdLayout';
import type { BoardHoldTarget } from '../../lib/create-board-holds';

/** The board's live zoom transform, as the overlay's shared values read it. */
export type BoardZoomTransform = {
  scale: number;
  translateX: number;
  translateY: number;
  containerWidth: number;
  containerHeight: number;
};

/**
 * Minimum movement (in BOARD px) before a stroke keeps another sample.
 *
 * Gates the worklet's shared-value append so a resting stylus doesn't push a
 * point per frame. Comfortably finer than the 1.6 board-px simplification
 * tolerance the ring is decimated at, so nothing a human draws is lost to it.
 */
export const STROKE_MIN_SAMPLE_BOARD_PX = 0.8;

/**
 * How close a stroke's last sample has to land to its first before we treat the
 * loop as closed and drop the tail, in BOARD px.
 *
 * Rings are stored implicitly closed. A freehand loop almost never ends on the
 * exact pixel it started from, so `closeRing`'s equality test alone would leave
 * a duplicate head point and a near-zero-length final edge.
 */
export const STROKE_CLOSE_TOLERANCE_BOARD_PX = 3;

/**
 * Decimal places a stored ring is rounded to. Matches `OUTLINE_DECIMALS` in the
 * backend's upsert resolver — the two have to agree or the editor previews a
 * ring the server rewrites.
 */
export const OUTLINE_DECIMALS = 4;

/** Why a drawn stroke can't be stored. The editor keeps drawing on any of these. */
export type StrokeRejection = 'too-few-points' | 'too-complex' | 'centre-outside' | 'out-of-bounds';

export type StrokeResult = { ok: true; outline: number[] } | { ok: false; reason: StrokeRejection };

/**
 * Invert the board's zoom transform: a point in container/screen px becomes a
 * point in board-local, untransformed RENDER px.
 *
 * Thin wrapper over the create-board's `inverseTransformPoint` so the editor
 * reads as one chain — and so a change to the board's transform origin can only
 * be made in one place.
 */
export function screenToRenderPoint(screenX: number, screenY: number, transform: BoardZoomTransform): RingPoint {
  const { x, y } = inverseTransformPoint(
    screenX,
    screenY,
    transform.scale,
    transform.translateX,
    transform.translateY,
    transform.containerWidth,
    transform.containerHeight,
  );
  return [x, y];
}

/**
 * Render px → board px. The board is drawn to its own aspect ratio, so one
 * uniform factor covers both axes.
 */
export function renderToBoardScale(boardWidth: number, renderWidth: number): number {
  return renderWidth > 0 ? boardWidth / renderWidth : 0;
}

/** The full step-1+2 hop, for the test's round-trip and for any JS-side caller. */
export function screenToBoardPoint(
  screenX: number,
  screenY: number,
  transform: BoardZoomTransform,
  boardWidth: number,
  renderWidth: number,
): RingPoint {
  const [renderX, renderY] = screenToRenderPoint(screenX, screenY, transform);
  const scale = renderToBoardScale(boardWidth, renderWidth);
  return [renderX * scale, renderY * scale];
}

/** Drop consecutive samples closer together than `minDistance`. */
export function dedupeStrokePoints(points: RingPoint[], minDistance: number): RingPoint[] {
  const kept: RingPoint[] = [];
  const minDistanceSquared = minDistance * minDistance;
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous) {
      const deltaX = point[0] - previous[0];
      const deltaY = point[1] - previous[1];
      if (deltaX * deltaX + deltaY * deltaY < minDistanceSquared) continue;
    }
    kept.push(point);
  }
  return kept;
}

/**
 * Drop the tail of a freehand loop that has come back around onto its own head,
 * so the ring closes implicitly instead of storing a stub edge. Never eats the
 * whole stroke — the first two points always survive.
 */
export function closeStrokeLoop(points: RingPoint[], tolerance: number): RingPoint[] {
  if (points.length < 3) return points;
  const [headX, headY] = points[0];
  let end = points.length;
  while (end > 2) {
    const [tailX, tailY] = points[end - 1];
    if (Math.hypot(tailX - headX, tailY - headY) > tolerance) break;
    end -= 1;
  }
  return end === points.length ? points : points.slice(0, end);
}

/** Flatten `[[x, y], ...]` to the stored `[x0, y0, x1, y1, ...]` shape. */
export function flattenRing(points: RingPoint[]): number[] {
  const flat: number[] = [];
  for (const [x, y] of points) {
    flat.push(x, y);
  }
  return flat;
}

/** Board px → units of a placement's radius, relative to its centre. */
export function boardRingToRadiusUnits(ring: number[], hold: BoardHoldTarget): number[] {
  const radius = hold.r;
  const converted: number[] = [];
  for (let index = 0; index < ring.length; index += 2) {
    converted.push((ring[index] - hold.cx) / radius, (ring[index + 1] - hold.cy) / radius);
  }
  return converted;
}

/** The inverse of {@link boardRingToRadiusUnits} — what the SVG layer draws. */
export function radiusRingToBoardPx(ring: number[], hold: BoardHoldTarget): number[] {
  const radius = hold.r;
  const converted: number[] = [];
  for (let index = 0; index < ring.length; index += 2) {
    converted.push(hold.cx + ring[index] * radius, hold.cy + ring[index + 1] * radius);
  }
  return converted;
}

/**
 * Does this ring enclose the placement it was drawn for?
 *
 * Mirrors the backend's softened gate exactly (`pointInRing` OR within
 * {@link CENTRE_TOLERANCE_RADII}) so the client never rejects a ring the server
 * would have accepted — a hold whose bolt sits under a concave underside
 * genuinely traces without containing its own centre.
 */
export function ringCoversCentre(radiusRing: number[]): boolean {
  return pointInRing(radiusRing, 0, 0) || distanceToRing(radiusRing, 0, 0) <= CENTRE_TOLERANCE_RADII;
}

/**
 * Turn a freehand stroke, already in board px, into a storable ring in radius
 * units — or say why it can't be one.
 *
 * Simplification runs in BOARD px, before the divide-through by the placement
 * radius: the tracer's 1.6 epsilon is quoted in board pixels, and applying it to
 * a radius-unit ring would collapse every hold to a triangle. The tail — radius
 * units, rounding, closing and the validity gates — is `finishOutlineRing`,
 * shared with the brush.
 */
export function buildOutlineRing(strokeBoardPoints: RingPoint[], hold: BoardHoldTarget): StrokeResult {
  const deduped = dedupeStrokePoints(strokeBoardPoints, STROKE_MIN_SAMPLE_BOARD_PX);
  const looped = closeStrokeLoop(deduped, STROKE_CLOSE_TOLERANCE_BOARD_PX);
  if (looped.length < 3) return { ok: false, reason: 'too-few-points' };

  // Decimate at the tracer's tolerance, then keep doubling it if the result is
  // still longer than a stored ring may be. A hand-drawn hold lands far under
  // the cap on the first pass; the loop only exists so a pathological scribble
  // degrades into a coarser ring rather than a dead end.
  let simplified = simplifyRing(looped, SIMPLIFY_EPSILON_BOARD_PX);
  let epsilon = SIMPLIFY_EPSILON_BOARD_PX;
  while (simplified.length * 2 > MAX_RING_NUMBERS && epsilon < SIMPLIFY_EPSILON_BOARD_PX * 64) {
    epsilon *= 2;
    simplified = simplifyRing(looped, epsilon);
  }
  // Still too many points after six doublings (epsilon 102 board px, far coarser
  // than any hold). Its own reason: the failure is the opposite of a short
  // stroke, and reporting "too short" here would send the editor the wrong way.
  if (simplified.length * 2 > MAX_RING_NUMBERS) return { ok: false, reason: 'too-complex' };

  return finishOutlineRing(flattenRing(simplified), hold);
}

/**
 * The last hop shared by every path that produces an outline: board px in,
 * a storable ring in radius units out, or the reason it is not one.
 *
 * SHARED ON PURPOSE. The freehand loop and the brush both end here, and this is
 * the only place on the client where the `closeRing(roundRing(...))` order that
 * mirrors the backend's upsert resolver is written down. Two copies of it drift,
 * and the failure is silent: the editor previews a ring the server rewrites.
 *
 * Rounding runs BEFORE the implicit close, mirroring `closeRing(roundRing(...))`
 * in the resolver. Rounding to 4 decimals can newly equate a head and tail that
 * differed in the 5th, so closing first would leave a duplicate point the server
 * then drops — and the editor would preview a ring one point longer than the one
 * actually stored.
 */
export function finishOutlineRing(simplifiedBoardPx: number[], hold: BoardHoldTarget): StrokeResult {
  const radiusRing = closeRing(roundRing(boardRingToRadiusUnits(simplifiedBoardPx, hold), OUTLINE_DECIMALS));
  if (radiusRing.length < MIN_RING_NUMBERS) return { ok: false, reason: 'too-few-points' };
  if (radiusRing.some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_RING_COORDINATE)) {
    return { ok: false, reason: 'out-of-bounds' };
  }
  if (!ringCoversCentre(radiusRing)) return { ok: false, reason: 'centre-outside' };

  return { ok: true, outline: radiusRing };
}

/**
 * An SVG `d` for one implicitly-closed flat ring, in whatever units the ring is
 * in. Empty string for a ring too short to draw, so a caller can concatenate
 * without guarding.
 */
export function ringToPathData(ring: number[]): string {
  if (ring.length < MIN_RING_NUMBERS) return '';
  let path = `M${ring[0]} ${ring[1]}`;
  for (let index = 2; index < ring.length; index += 2) {
    path += `L${ring[index]} ${ring[index + 1]}`;
  }
  return `${path}Z`;
}

/** A circle at the placement radius, as an SVG `d` in board px. The renderer's
 *  fallback for a placement with no art of its own — and what the editor draws
 *  dashed to say "nothing traced here yet". */
export function placementRingPathData(hold: BoardHoldTarget): string {
  const { cx, cy, r } = hold;
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
}
