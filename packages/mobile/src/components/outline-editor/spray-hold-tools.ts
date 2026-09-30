/**
 * The hold tools' geometry, as pure functions.
 *
 * Everything here works in BOARD pixels — which on a spray wall are the
 * photograph's own pixels (`getSprayRenderData`: the frame is the photo, there
 * are no wall dimensions). Canonical coordinates are the WRITE path's problem
 * and live in `lib/spray/spray-hold-canonical.ts`; nothing in this file knows a
 * homography exists.
 *
 * The tools are split out from the screen for the same reason `stroke.ts` was:
 * a gesture that produces a hold in the wrong place looks exactly like a gesture
 * that produces one in the right place until somebody taps the wall, and the
 * only way to catch that is a test that never mounts a board.
 */

import { MAX_RING_COORDINATE, type RingPoint } from '@boardsesh/board-art-geometry/ring';
import { buildOutlineRing, radiusRingToBoardPx, type StrokeRejection } from './stroke';

/**
 * Detector confidence at or above which a candidate opens ON — drawn as a solid
 * ring and written on Publish unless the climber switches it off.
 *
 * The band this cut sits in is set by the WORKER, not by the app: the hold
 * detector keeps only detections at or above its manifest's
 * `thresholds.default`, which is 0.6 for `2026-09-18-seg` (`detect()` in
 * `packages/hold-detector/src/detect.ts` falls back to it and
 * `inference-thread.ts` passes no override). Every candidate this screen ever
 * sees therefore scores 0.6–1.0, and a cut below 0.6 would make every find ON
 * and the maybe state unreachable.
 *
 * 0.75 splits that band where the old editor already drew its dashed
 * "low confidence" rings. On a 240-hold validation spray wall
 * (`roboflow-1class/valid/IMG_8992`) the deployed model returned 224 finds,
 * median 0.84; this cut opens 189 of them ON and 35 as maybes. No precision
 * curve for the seg model is checked in yet — re-derive this once one lands in
 * `ml/holds/results/`, and lower the worker's threshold if more maybes are wanted.
 */
export const SPRAY_ON_CUTOFF = 0.75;

/**
 * Candidates between this and {@link SPRAY_ON_CUTOFF} open as MAYBES: a dashed
 * amber ring that is drawn but not written until the climber taps it on.
 * Anything below is never shown at all.
 *
 * Matches the worker's own 0.6 floor, so today every candidate it sends is
 * shown; the floor only bites if a future model ships a lower default.
 */
export const SPRAY_MAYBE_FLOOR = 0.6;

/**
 * The smallest a hold's grab area gets on SCREEN, in points, before it is
 * converted to board px at the current zoom. A fingertip is ~44 pt across, so
 * half of that is the radius a tap can reasonably be expected to land within.
 */
export const HIT_FALLBACK_SCREEN_PT = 22;

/**
 * How far past its own radius a hold still claims a tap that landed on bare
 * wall, as a multiple of that radius.
 */
export const HIT_RADIUS_MULTIPLE = 1.4;

/**
 * Radius a hold gets when there is nothing to take a median from — the very
 * first hold on a wall with no detections, in board px.
 *
 * A wall photo's holds run around 2% of its width, so this is quoted against the
 * frame rather than fixed: {@link defaultHoldRadius} scales it.
 */
export const DEFAULT_RADIUS_FRACTION_OF_WIDTH = 0.02;

/**
 * The four sizes Smaller and Bigger step through, as multiples of the wall's own
 * median hold radius. A wall's holds are all roughly one size, so "medium" IS the median and
 * the others are the jug / crimp spread around it.
 */
export const SIZE_PRESETS = [
  { key: 'S', scale: 0.62 },
  { key: 'M', scale: 1 },
  { key: 'L', scale: 1.45 },
  { key: 'XL', scale: 2.1 },
] as const;

/** Smallest radius a hold may be left at, in board px. Below this it is not a tap target. */
export const MIN_HOLD_RADIUS_BOARD_PX = 2;

/** A hold as the editor holds it, before anything knows whether it is stored. */
export type HoldGeometry = {
  cx: number;
  cy: number;
  r: number;
  /** Radius-unit ring, or null for a plain circle at `r`. */
  outline: number[] | null;
};

export type HoldFromStrokeResult = { ok: true; hold: HoldGeometry } | { ok: false; reason: StrokeRejection };

/** Flat `[x0, y0, ...]` → the `[x, y]` pairs every function here takes. */
export function toRingPoints(flat: readonly number[]): RingPoint[] {
  const points: RingPoint[] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    points.push([flat[index], flat[index + 1]]);
  }
  return points;
}

/** Signed shoelace area and centroid of a polygon. Zero area falls back to the vertex mean. */
export function polygonCentroidAndArea(points: RingPoint[]): { cx: number; cy: number; area: number } {
  if (points.length === 0) return { cx: 0, cy: 0, area: 0 };
  let twiceArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [currentX, currentY] = points[index];
    const [nextX, nextY] = points[(index + 1) % points.length];
    const cross = currentX * nextY - nextX * currentY;
    twiceArea += cross;
    centroidX += (currentX + nextX) * cross;
    centroidY += (currentY + nextY) * cross;
  }
  const area = Math.abs(twiceArea) / 2;
  if (twiceArea === 0) {
    let sumX = 0;
    let sumY = 0;
    for (const [x, y] of points) {
      sumX += x;
      sumY += y;
    }
    return { cx: sumX / points.length, cy: sumY / points.length, area: 0 };
  }
  return { cx: centroidX / (3 * twiceArea), cy: centroidY / (3 * twiceArea), area };
}

/**
 * The radius to hang a ring off, in board px.
 *
 * The equivalent-area radius — the radius of the circle with the same area — is
 * the honest answer: it is what the hold "is" as far as anything drawing a plain
 * circle for it is concerned, and it is invariant to how lumpy the trace was.
 *
 * The floor exists because a stored ring is in RADIUS units and may not reach
 * past {@link MAX_RING_COORDINATE} of them. A long thin union — the far edge of
 * a two-hold merge — can sit six equivalent-area radii from its own centroid, and
 * the ring would then be refused by the same contract the backend applies. Rather
 * than lose the silhouette, the radius grows until the ring fits, with a margin
 * so rounding at the 4th decimal cannot push a coordinate back over the line.
 */
export function radiusForRing(points: RingPoint[], cx: number, cy: number, area: number): number {
  let farthest = 0;
  for (const [x, y] of points) {
    farthest = Math.max(farthest, Math.hypot(x - cx, y - cy));
  }
  const areaRadius = Math.sqrt(area / Math.PI);
  const ringFitRadius = farthest / (MAX_RING_COORDINATE * 0.95);
  return Math.max(areaRadius, ringFitRadius, MIN_HOLD_RADIUS_BOARD_PX);
}

/**
 * A drawn loop → a whole hold: centre, radius and silhouette.
 *
 * The silhouette goes through `buildOutlineRing` unchanged, which is the point —
 * the decimation, the round-before-close order and the coordinate bound are the
 * catalogue editor's, tested by its own round-trip test, and a wall gets exactly
 * the same ring a board would.
 */
export function holdFromStroke(points: RingPoint[]): HoldFromStrokeResult {
  if (points.length < 3) return { ok: false, reason: 'too-few-points' };
  const { cx, cy, area } = polygonCentroidAndArea(points);
  const r = radiusForRing(points, cx, cy, area);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) {
    return { ok: false, reason: 'out-of-bounds' };
  }
  const result = buildOutlineRing(points, { id: 0, cx, cy, r });
  if (!result.ok) return result;
  return { ok: true, hold: { cx, cy, r, outline: result.outline } };
}

/** A hold placed by a tap: a plain circle, which is what the renderer draws for a null outline. */
export function holdFromTap(x: number, y: number, radius: number): HoldGeometry {
  return { cx: x, cy: y, r: Math.max(MIN_HOLD_RADIUS_BOARD_PX, radius), outline: null };
}

/** The wall's own hold size, for a hold placed where there is nothing to measure. */
export function defaultHoldRadius(holds: readonly HoldGeometry[], boardWidth: number): number {
  const radii = holds.map((hold) => hold.r).filter((radius) => radius > 0);
  if (radii.length === 0) return Math.max(MIN_HOLD_RADIUS_BOARD_PX, boardWidth * DEFAULT_RADIUS_FRACTION_OF_WIDTH);
  radii.sort((left, right) => left - right);
  const middle = Math.floor(radii.length / 2);
  return radii.length % 2 === 0 ? (radii[middle - 1] + radii[middle]) / 2 : radii[middle];
}

/** The hold's absolute board-px boundary: its traced ring, or its circle sampled. */
export function holdBoundaryPoints(hold: HoldGeometry, circleSamples = 24): RingPoint[] {
  if (hold.outline) {
    const flat = radiusRingToBoardPx(hold.outline, { id: 0, cx: hold.cx, cy: hold.cy, r: hold.r });
    return toRingPoints(flat);
  }
  const points: RingPoint[] = [];
  for (let index = 0; index < circleSamples; index += 1) {
    const angle = (index / circleSamples) * Math.PI * 2;
    points.push([hold.cx + Math.cos(angle) * hold.r, hold.cy + Math.sin(angle) * hold.r]);
  }
  return points;
}

/**
 * Andrew's monotone-chain convex hull, counter-clockwise, no repeated endpoint.
 *
 * The union of two overlapping silhouettes is not generally convex, and a proper
 * polygon union is a clipping library this app does not carry and will not grow
 * for one tool. A hull is the honest approximation: it always contains both
 * holds, it is always a simple polygon (so the ring contract is satisfiable),
 * and it always contains its own centroid. What it costs is a concave notch
 * between two holds merged across a gap, which is a cosmetic loss on a
 * photograph.
 *
 * Note that it is the SILHOUETTE that covers both, not the merged hold's circle:
 * `radiusForRing` reports the equivalent-area radius, which for two holds merged
 * across a gap is smaller than the distance to either original. That is the
 * right trade — the renderer draws the silhouette whenever there is one, and a
 * circle sized to span the gap would report a hold twice the size of its
 * neighbours to everything that reads `r`.
 */
export function convexHull(points: RingPoint[]): RingPoint[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const cross = (origin: RingPoint, from: RingPoint, to: RingPoint): number =>
    (from[0] - origin[0]) * (to[1] - origin[1]) - (from[1] - origin[1]) * (to[0] - origin[0]);

  const build = (ordered: RingPoint[]): RingPoint[] => {
    const chain: RingPoint[] = [];
    for (const point of ordered) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };

  const hull = [...build(sorted), ...build([...sorted].reverse())];
  return hull.length >= 3 ? hull : [...points];
}

/**
 * Two holds → one, with a silhouette that covers both.
 *
 * Returns `null` only when the two together describe no polygon at all, which
 * takes two degenerate holds; the screen leaves the selection alone in that case
 * rather than silently dropping a hold.
 */
export function mergeHoldGeometry(first: HoldGeometry, second: HoldGeometry): HoldGeometry | null {
  const hull = convexHull([...holdBoundaryPoints(first), ...holdBoundaryPoints(second)]);
  if (hull.length < 3) return null;
  const { cx, cy, area } = polygonCentroidAndArea(hull);
  const r = radiusForRing(hull, cx, cy, area);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return null;
  const result = buildOutlineRing(hull, { id: 0, cx, cy, r });
  // A hull too detailed to store is not a reason to refuse the merge: the two
  // holds still become one, drawn as the circle that covers them both.
  return { cx, cy, r, outline: result.ok ? result.outline : null };
}

/**
 * The hold a tap at (x, y) means, or null for bare wall.
 *
 * Two passes, in order:
 *
 *  1. The SMALLEST hold whose own radius contains the point. On a busy wall a
 *     crimp often sits inside the circle of the jug beside it, and "nearest
 *     centre" would hand the tap to whichever centre happened to be closer —
 *     which makes the crimp unreachable from half its own area.
 *  2. Otherwise the nearest centre within `max(1.4r, fallback)`. The fallback
 *     is {@link HIT_FALLBACK_SCREEN_PT} converted to board px at the current
 *     zoom by the caller, so a tiny hold is still a fingertip wide on screen at
 *     1x, and the grab area shrinks back to the hold itself as you zoom in.
 */
export function holdAtPoint<T extends HoldGeometry & { id: number }>(
  holds: readonly T[],
  x: number,
  y: number,
  fallbackRadius = 0,
): T | null {
  let smallestContaining: T | null = null;
  let nearest: T | null = null;
  let nearestDistance = Infinity;
  for (const hold of holds) {
    const distance = Math.hypot(x - hold.cx, y - hold.cy);
    if (distance <= hold.r) {
      if (!smallestContaining || hold.r < smallestContaining.r) smallestContaining = hold;
      continue;
    }
    if (smallestContaining) continue;
    if (distance > Math.max(hold.r * HIT_RADIUS_MULTIPLE, fallbackRadius)) continue;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = hold;
    }
  }
  return smallestContaining ?? nearest;
}

/**
 * The next size preset up or down from a hold's current radius, or null at the
 * end of the ladder.
 *
 * Measured against the wall's median radius, because that is what the presets
 * are multiples of. A hold that sits between two presets (a traced one, or one
 * the detector sized) steps to the next preset strictly past it rather than to
 * the nearest, so "Bigger" never makes a hold smaller.
 */
export function stepHoldSize(radius: number, medianRadius: number, direction: 1 | -1): number | null {
  if (!(medianRadius > 0) || !(radius > 0)) return null;
  const current = radius / medianRadius;
  // Two percent of slack, so a hold sitting exactly on a preset is read as ON it.
  const slack = 0.02;
  const ladder = direction === 1 ? SIZE_PRESETS : [...SIZE_PRESETS].reverse();
  for (const preset of ladder) {
    const beyond = direction === 1 ? preset.scale > current * (1 + slack) : preset.scale < current * (1 - slack);
    if (beyond) return Math.max(MIN_HOLD_RADIUS_BOARD_PX, medianRadius * preset.scale);
  }
  return null;
}
