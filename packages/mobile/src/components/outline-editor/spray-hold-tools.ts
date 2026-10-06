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

import {
  MAX_RING_COORDINATE,
  MAX_RING_NUMBERS,
  MIN_RING_NUMBERS,
  closeRing,
  isValidOutlineRing,
  roundRing,
  type RingPoint,
} from '@boardsesh/board-art-geometry/ring';
import {
  OUTLINE_DECIMALS,
  boardRingToRadiusUnits,
  buildOutlineRing,
  flattenRing,
  radiusRingToBoardPx,
  ringCoversCentre,
  type StrokeRejection,
} from './stroke';

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

/**
 * How close to the first corner, in screen points, a tap closes a Corners
 * outline — the ring drawn round that corner.
 */
export const CORNERS_CLOSE_TARGET_PT = 11;

/**
 * The close target never reaches past this fraction of the outline's own size
 * (the farthest corner from the first). Without it, the fourth corner of a small
 * hold at 1× — 16pt across — lands inside an 11pt target and closes a triangle.
 */
export const CORNERS_CLOSE_EXTENT_FRACTION = 0.35;

/**
 * Most corners a tapped-out polygon may have: one stored ring's worth.
 *
 * Derived from the shared ring contract (`MAX_RING_NUMBERS`, two numbers a
 * point) rather than restated. `closeRing` only ever DROPS a trailing point that
 * repeats the first — it never appends one — so a polygon of this many corners
 * stores as exactly this many points and still fits.
 */
export const POLYGON_MAX_VERTICES = Math.floor(MAX_RING_NUMBERS / 2);

/**
 * Two corners closer than this, in board px, are one corner tapped twice. Far
 * below anything a fingertip places on purpose, even at the editor's deepest zoom.
 */
export const POLYGON_DUPLICATE_BOARD_PX = 0.5;

/**
 * A polygon enclosing less than this, in square board px, has no inside — its
 * corners are collinear, or as near as floating point gets.
 */
export const POLYGON_MIN_AREA_BOARD_PX2 = 1;

/** Twice the signed area of triangle (origin, from, to); its sign is the turn direction. */
function turn(origin: RingPoint, from: RingPoint, to: RingPoint): number {
  return (from[0] - origin[0]) * (to[1] - origin[1]) - (from[1] - origin[1]) * (to[0] - origin[0]);
}

/** Does `point`, already known to be collinear with the segment, sit within its bounding box? */
function onSegment(start: RingPoint, end: RingPoint, point: RingPoint): boolean {
  return (
    Math.min(start[0], end[0]) <= point[0] &&
    point[0] <= Math.max(start[0], end[0]) &&
    Math.min(start[1], end[1]) <= point[1] &&
    point[1] <= Math.max(start[1], end[1])
  );
}

/** Closed-segment intersection: touching at a point or overlapping along a line both count. */
function segmentsIntersect(firstStart: RingPoint, firstEnd: RingPoint, secondStart: RingPoint, secondEnd: RingPoint) {
  const turnA = turn(firstStart, firstEnd, secondStart);
  const turnB = turn(firstStart, firstEnd, secondEnd);
  const turnC = turn(secondStart, secondEnd, firstStart);
  const turnD = turn(secondStart, secondEnd, firstEnd);
  if (
    ((turnA > 0 && turnB < 0) || (turnA < 0 && turnB > 0)) &&
    ((turnC > 0 && turnD < 0) || (turnC < 0 && turnD > 0))
  ) {
    return true;
  }
  if (turnA === 0 && onSegment(firstStart, firstEnd, secondStart)) return true;
  if (turnB === 0 && onSegment(firstStart, firstEnd, secondEnd)) return true;
  if (turnC === 0 && onSegment(secondStart, secondEnd, firstStart)) return true;
  if (turnD === 0 && onSegment(secondStart, secondEnd, firstEnd)) return true;
  return false;
}

/**
 * Do these corners all sit within {@link POLYGON_DUPLICATE_BOARD_PX} of one
 * line? Measured against the line from the first corner to the corner farthest
 * from it, so the answer doesn't depend on which two corners happen to be close.
 */
function cornersAreCollinear(points: RingPoint[]): boolean {
  const origin = points[0];
  let farthest = origin;
  let farthestDistance = 0;
  for (const point of points) {
    const distance = Math.hypot(point[0] - origin[0], point[1] - origin[1]);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = point;
    }
  }
  if (farthestDistance === 0) return true;
  for (const point of points) {
    if (Math.abs(turn(origin, farthest, point)) / farthestDistance > POLYGON_DUPLICATE_BOARD_PX) return false;
  }
  return true;
}

/**
 * Is this implicitly-closed polygon anything but simple?
 *
 * Two kinds of failure: any two NON-adjacent edges meeting at all, and two
 * adjacent edges folding straight back over each other (a spike, whose shared
 * corner has a zero-area turn and the next edge running backwards). O(n²) on at
 * most {@link POLYGON_MAX_VERTICES} corners — about eleven thousand pair tests,
 * once, on commit.
 */
export function polygonSelfOverlaps(points: RingPoint[]): boolean {
  const count = points.length;
  if (count < 3) return false;
  for (let first = 0; first < count; first += 1) {
    const firstStart = points[first];
    const firstEnd = points[(first + 1) % count];
    const following = points[(first + 2) % count];
    // Adjacent pair (first, first + 1): only a fold-back can overlap them.
    const foldX = (firstEnd[0] - firstStart[0]) * (following[0] - firstEnd[0]);
    const foldY = (firstEnd[1] - firstStart[1]) * (following[1] - firstEnd[1]);
    if (turn(firstStart, firstEnd, following) === 0 && foldX + foldY < 0) return true;
    for (let second = first + 2; second < count; second += 1) {
      // The closing edge (count - 1) shares corner 0 with edge 0.
      if (first === 0 && second === count - 1) continue;
      if (segmentsIntersect(firstStart, firstEnd, points[second], points[(second + 1) % count])) return true;
    }
  }
  return false;
}

/**
 * Tapped-out corners → a whole hold: centre, radius and silhouette.
 *
 * The sibling of {@link holdFromStroke} with the opposite attitude to the input.
 * A freehand stroke is a noisy trace, so it is sampled, loop-closed and
 * decimated; a polygon is a handful of corners the climber placed one at a time
 * on a zoomed photo, and every one of them is meant. So nothing here moves or
 * drops a corner except an exact-enough repeat (a double tap, or a closing tap
 * that landed back on the first corner) — no stroke dedupe, no loop closing, no
 * Douglas-Peucker. What stays shared is the tail every stored ring goes through:
 * radius units, round-before-close in the backend's order, the shared contract,
 * and the centre-cover gate.
 *
 * Crossing edges are refused as `'self-overlap'` rather than repaired: there is
 * no one right polygon for a bow-tie, and guessing would store a shape the
 * climber never drew.
 */
export function holdFromPolygon(vertices: RingPoint[]): HoldFromStrokeResult {
  const duplicateSquared = POLYGON_DUPLICATE_BOARD_PX * POLYGON_DUPLICATE_BOARD_PX;
  const isDuplicate = (left: RingPoint, right: RingPoint) => {
    const deltaX = left[0] - right[0];
    const deltaY = left[1] - right[1];
    return deltaX * deltaX + deltaY * deltaY < duplicateSquared;
  };

  const corners: RingPoint[] = [];
  for (const vertex of vertices) {
    const previous = corners[corners.length - 1];
    if (previous && isDuplicate(previous, vertex)) continue;
    corners.push(vertex);
  }
  // A trailing corner on top of the first is the ring closing itself — stored
  // rings are implicitly closed, so it would only add a zero-length edge.
  while (corners.length > 1 && isDuplicate(corners[corners.length - 1], corners[0])) corners.pop();

  // Corners on one line are too few for a hold however many there are — checked
  // before the overlap test, which would otherwise read the line doubling back
  // on itself as a fold.
  if (corners.length < 3 || cornersAreCollinear(corners)) return { ok: false, reason: 'too-few-points' };
  if (corners.length > POLYGON_MAX_VERTICES) return { ok: false, reason: 'too-complex' };
  // Before the area test: a symmetric bow-tie's two lobes cancel to zero signed
  // area, and "too few corners" would send the climber the wrong way.
  if (polygonSelfOverlaps(corners)) return { ok: false, reason: 'self-overlap' };
  const { cx, cy, area } = polygonCentroidAndArea(corners);
  if (!(area >= POLYGON_MIN_AREA_BOARD_PX2)) return { ok: false, reason: 'too-few-points' };

  const r = radiusForRing(corners, cx, cy, area);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) {
    return { ok: false, reason: 'out-of-bounds' };
  }

  // Round, THEN close — the backend's order; see `buildOutlineRing`.
  const radiusRing = closeRing(
    roundRing(boardRingToRadiusUnits(flattenRing(corners), { id: 0, cx, cy, r }), OUTLINE_DECIMALS),
  );
  if (radiusRing.length < MIN_RING_NUMBERS) return { ok: false, reason: 'too-few-points' };
  if (!isValidOutlineRing(radiusRing)) return { ok: false, reason: 'out-of-bounds' };
  if (!ringCoversCentre(radiusRing)) return { ok: false, reason: 'centre-outside' };

  return { ok: true, hold: { cx, cy, r, outline: radiusRing } };
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
 * One resize step: every size a hold can be given by hand is the wall's median
 * radius times a whole power of this. The handle and the − / + steppers share
 * the grid, so a drag and a run of presses land on the same sizes and "+" can
 * never make a hold smaller.
 */
export const RESIZE_STEP_RATIO = 1.05;

/**
 * Screen points of handle travel per e-fold of size: `scale = exp(pt / gain)`.
 * One 5% step is `120 × ln 1.05` ≈ 5.9 pt, so the grid ticks under a fingertip
 * at a steady rate whatever the zoom or the hold's size.
 */
export const RESIZE_GAIN_PT = 120;

/** The smallest a resize leaves a hold, as a fraction of the median radius. */
export const RESIZE_MIN_MEDIAN_FRACTION = 0.3;
/** The biggest a resize makes a hold, as a multiple of the median radius. */
export const RESIZE_MAX_MEDIAN_MULTIPLE = 4;
/** …and never past this fraction of the photo's shorter side, so one ring cannot swallow the wall. */
export const RESIZE_MAX_PHOTO_FRACTION = 0.2;

/**
 * Grid positions within this many steps of a whole one count as ON it. A
 * hold sized on the grid drifts off it the moment the median moves (resizing
 * the median hold moves the median), and a stepper press must not then spend
 * itself on a 1% nudge to the grid point it was already sitting on.
 */
const GRID_SLACK_STEPS = 0.25;

/** Room for floating-point error when a bound sits exactly on a grid point. */
const GRID_EPSILON = 1e-9;

export type HoldRadiusBounds = { min: number; max: number };

export type ResizeMagnet = 'original' | 'median';

export type ResizeFromDragResult = {
  /** The radius to show, in board px. */
  r: number;
  /**
   * The grid step the radius sits on (`median × 1.05^stepIndex`), rounded for a
   * magnet or a bound that sits between two.
   */
  stepIndex: number;
  /** The snap point that captured the drag, if one did. */
  magnet: ResizeMagnet | null;
  /** The drag is pressing against a bound and the radius is clamped to it. */
  atBound: boolean;
};

/**
 * The sizes a hand resize may give a hold, in board px.
 *
 * Min: `max(MIN_HOLD_RADIUS_BOARD_PX, 0.3 × median)`, so a ring stays a tap
 * target. Max: `min(4 × median, 0.2 × the photo's shorter side)`. A photo with
 * no size yet (or a median of nothing) only loses the term it cannot supply;
 * with neither, and whenever the terms cross, the max collapses onto the min.
 *
 * None of this needs to guard the ring contract: an outline is stored in
 * radius units, so a resize changes `r` alone and the ring's coordinates —
 * and with them `MAX_RING_COORDINATE` — are untouched.
 */
export function holdRadiusBounds(median: number, photoWidth: number, photoHeight: number): HoldRadiusBounds {
  'worklet';
  const safeMedian = median > 0 ? median : 0;
  const min = Math.max(MIN_HOLD_RADIUS_BOARD_PX, safeMedian * RESIZE_MIN_MEDIAN_FRACTION);
  let max = safeMedian > 0 ? safeMedian * RESIZE_MAX_MEDIAN_MULTIPLE : Infinity;
  const shorterSide = Math.min(photoWidth, photoHeight);
  if (shorterSide > 0) max = Math.min(max, shorterSide * RESIZE_MAX_PHOTO_FRACTION);
  // Nothing to measure against at all is no room to resize, not unlimited room.
  if (!(max >= min) || !Number.isFinite(max)) max = min;
  return { min, max };
}

/** A radius's position on the grid, in steps from the median. Not rounded. */
function gridPosition(radius: number, median: number): number {
  'worklet';
  return Math.log(radius / median) / Math.log(RESIZE_STEP_RATIO);
}

function gridRadius(stepIndex: number, median: number): number {
  'worklet';
  return median * Math.pow(RESIZE_STEP_RATIO, stepIndex);
}

/** The nearest grid size to a radius: `median × 1.05ⁿ`. A radius or median of nothing comes back unchanged. */
export function snapRadiusToGrid(radius: number, median: number): number {
  'worklet';
  if (!(median > 0) || !(radius > 0)) return radius;
  return gridRadius(Math.round(gridPosition(radius, median)), median);
}

/**
 * One − or + press: the next grid size strictly past the hold's own, inside the
 * bounds, or null when there is none that way.
 *
 * "Strictly past" is what keeps a press honest. A hold that sits between two
 * grid sizes (traced, detected, or left behind by a median that moved) goes to
 * the next one in the direction pressed, never back to the one behind it, so
 * "+" can never shrink a hold. A hold already outside the bounds (a merge can
 * make one) steps back inside on the first press towards them.
 */
export function stepHoldRadius(
  radius: number,
  median: number,
  direction: 1 | -1,
  bounds: HoldRadiusBounds,
): number | null {
  if (!(median > 0) || !(radius > 0)) return null;
  const position = gridPosition(radius, median);
  const lowestStep = Math.ceil(gridPosition(bounds.min, median) - GRID_EPSILON);
  const highestStep = Math.floor(gridPosition(bounds.max, median) + GRID_EPSILON);
  if (direction === 1) {
    const target = Math.max(Math.floor(position + GRID_SLACK_STEPS) + 1, lowestStep);
    return target <= highestStep ? gridRadius(target, median) : null;
  }
  const target = Math.min(Math.ceil(position - GRID_SLACK_STEPS) - 1, highestStep);
  return target >= lowestStep ? gridRadius(target, median) : null;
}

/**
 * The resize handle's drag → a radius, on the UI thread.
 *
 * `projectedPt` is the finger's travel along the handle's outward direction, in
 * screen points (`projectOnto`); `exp(pt / RESIZE_GAIN_PT)` turns it into a
 * scale, so the same travel means the same change at any zoom and on any size
 * of hold. The answer snaps to the grid, with two magnets that each capture
 * within half a step: the size the hold had when it was grabbed (so a drag that
 * comes back changes nothing) and the median (the wall's typical hold). When
 * both are in reach the nearer wins, and on a tie the original does.
 *
 * Bounds clamp everything but the original: a hold that was already outside
 * them (a wide merge) can always be dragged back to the size it had.
 */
export function resizeFromDrag(
  projectedPt: number,
  startRadius: number,
  median: number,
  bounds: HoldRadiusBounds,
): ResizeFromDragResult {
  'worklet';
  if (!(median > 0) || !(startRadius > 0)) {
    return { r: startRadius, stepIndex: 0, magnet: 'original', atBound: false };
  }
  const raw = startRadius * Math.exp(projectedPt / RESIZE_GAIN_PT);
  const position = gridPosition(raw, median);
  const originalPosition = gridPosition(startRadius, median);
  const fromOriginal = Math.abs(position - originalPosition);
  const fromMedian = Math.abs(position);
  if (fromOriginal <= 0.5 && fromOriginal <= fromMedian) {
    return { r: startRadius, stepIndex: Math.round(originalPosition), magnet: 'original', atBound: false };
  }
  let stepIndex = Math.round(position);
  let magnet: ResizeMagnet | null = null;
  if (fromMedian <= 0.5) {
    stepIndex = 0;
    magnet = 'median';
  }
  const radius = gridRadius(stepIndex, median);
  if (radius < bounds.min) {
    return { r: bounds.min, stepIndex: Math.round(gridPosition(bounds.min, median)), magnet: null, atBound: true };
  }
  if (radius > bounds.max) {
    return { r: bounds.max, stepIndex: Math.round(gridPosition(bounds.max, median)), magnet: null, atBound: true };
  }
  return { r: radius, stepIndex, magnet, atBound: false };
}

/** The widest side of a flat point list's bounding box, in board px. Zero with no points. */
export function strokeExtent(flatPoints: readonly number[]): number {
  if (flatPoints.length < 2) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index + 1 < flatPoints.length; index += 2) {
    minX = Math.min(minX, flatPoints[index]);
    maxX = Math.max(maxX, flatPoints[index]);
    minY = Math.min(minY, flatPoints[index + 1]);
    maxY = Math.max(maxY, flatPoints[index + 1]);
  }
  return Math.max(maxX - minX, maxY - minY);
}
