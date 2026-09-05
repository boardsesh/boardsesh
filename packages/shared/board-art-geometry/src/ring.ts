// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

/**
 * Ring maths for hold outlines — the small, dependency-free half of this
 * package.
 *
 * Deliberately imports NOTHING from `loader`, `types` or `generated`. Both the
 * editor UI and the backend need to simplify, round and validate a ring, and
 * neither should have to pull the 3 MB shard set in to do it: Metro bundles what
 * it can reach, so a single import of the package index would put every board's
 * polygons in the mobile bundle to run a point-in-polygon test.
 *
 * `simplifyRing` is the tracer's own Douglas-Peucker, copied verbatim from
 * `scripts/generate-board-art-geometry.ts` so that a ring an editor redraws is
 * decimated by exactly the algorithm that produced the ring next to it. The
 * generator still holds its own copy today and switches to importing this one;
 * until then, a change here has to be made there too or the two drift apart.
 *
 * MIND THE UNITS. `simplifyRing` is unit-agnostic — the epsilon is whatever the
 * points are in — but the shipped tolerance below is quoted in BOARD PIXELS,
 * because that is the frame the tracer works in. Everything else in this file
 * (the coordinate bound, the centre tolerance, stored rings) is in units of the
 * placement RADIUS. Passing {@link SIMPLIFY_EPSILON_BOARD_PX} to a radius-unit
 * ring would decimate it to a triangle; see the constant's own note for the
 * conversion.
 */

/** A point as `[x, y]`, in whatever units the caller's ring is in. */
export type RingPoint = [number, number];

/**
 * Douglas-Peucker tolerance the tracer simplifies at, **in board pixels**.
 * Bigger = fewer points, blockier outline.
 *
 * Stored rings are in radius units, not board pixels, so this value is NOT the
 * epsilon to use on one. For a ring already divided through by a placement
 * radius of `radiusPx` board pixels the equivalent tolerance is
 * `SIMPLIFY_EPSILON_BOARD_PX / radiusPx` — around 0.08 at the catalogue's
 * typical ~20 px radius, and passing 1.6 instead would collapse the whole hold.
 */
export const SIMPLIFY_EPSILON_BOARD_PX = 1.6;

/**
 * How far outside its own ring a placement centre may sit and still count as
 * enclosed, in radius units.
 *
 * Not zero, because a strict test would make exactly the holds most in need of
 * correction un-correctable: two shipped outlines (kilter/1-28 placements 4800
 * and 4810 — hooks whose bolt sits under a deeply concave underside) do not
 * contain their own centre, by 0.0008 and 0.03 radii. It was five while the
 * tracer cut on the COMPOSITE; three of those five were the cut rather than the
 * art — the boundary ran between the bolt and the hold it belongs to because a
 * neighbouring SET's art was stacked on top of it — and they went to zero when
 * the tracer moved per image. Generous enough to admit the two that remain and
 * anything an editor traces the same way; far tighter than the failure it exists
 * to catch, which is a ring drawn around the NEIGHBOURING hold and therefore
 * roughly 2 radii away.
 */
export const CENTRE_TOLERANCE_RADII = 0.25;

/**
 * Bounds a stored outline has to sit inside, in units of the placement radius.
 *
 * Four radii is far outside any real hold — the tracer's own search box is 2.6 —
 * so the check is a "this is not a silhouette at all" backstop rather than a
 * shape opinion.
 */
export const MAX_RING_COORDINATE = 4;
/** A ring needs at least a triangle: 3 points, 6 numbers. */
export const MIN_RING_NUMBERS = 6;
/**
 * Ceiling on stored ring length. The largest shipped shard outline is well under
 * this; past it the ring is an un-simplified trace, not something a human drew.
 */
export const MAX_RING_NUMBERS = 300;

function perpendicularDistance(point: RingPoint, lineStart: RingPoint, lineEnd: RingPoint): number {
  const deltaX = lineEnd[0] - lineStart[0];
  const deltaY = lineEnd[1] - lineStart[1];
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  return (
    Math.abs(deltaY * point[0] - deltaX * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]) / length
  );
}

/**
 * Douglas-Peucker decimation. Copied verbatim from the tracer — behaviour here
 * is a contract, not an implementation detail, because the shards an override
 * sits alongside were produced by this exact algorithm.
 */
export function simplifyRing(points: RingPoint[], epsilon: number): RingPoint[] {
  if (points.length < 3) return points;
  let worstIndex = 0;
  let worstDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (distance > worstDistance) {
      worstDistance = distance;
      worstIndex = index;
    }
  }
  if (worstDistance <= epsilon) return [points[0], points[points.length - 1]];
  return [
    ...simplifyRing(points.slice(0, worstIndex + 1), epsilon).slice(0, -1),
    ...simplifyRing(points.slice(worstIndex), epsilon),
  ];
}

/**
 * Drop a trailing point that repeats the first one.
 *
 * Rings are stored implicitly closed — the last point joins the first — so an
 * editor that hands back an explicitly closed ring would otherwise store a
 * zero-length final edge.
 */
export function closeRing(ring: number[]): number[] {
  if (ring.length < 4) return ring;
  const firstX = ring[0];
  const firstY = ring[1];
  const lastX = ring[ring.length - 2];
  const lastY = ring[ring.length - 1];
  return firstX === lastX && firstY === lastY ? ring.slice(0, -2) : ring;
}

/**
 * Round every coordinate to `decimals` places. Shards store 4, which is 0.005
 * board px at the catalogue's smallest radius.
 *
 * `-0` collapses to `0`: it serialises as `-0` and would otherwise be a
 * pointless diff against a value that rounded the other way.
 */
export function roundRing(ring: number[], decimals: number): number[] {
  const scale = 10 ** decimals;
  return ring.map((value) => {
    const rounded = Math.round(value * scale) / scale;
    return rounded === 0 ? 0 : rounded;
  });
}

/**
 * Even-odd point-in-polygon against an implicitly-closed flat ring.
 *
 * Used to reject an outline that does not contain its own placement centre,
 * which is the one thing every real silhouette does and the cheapest way to
 * catch a ring drawn against the wrong hold.
 */
export function pointInRing(ring: number[], x: number, y: number): boolean {
  const pointCount = Math.floor(ring.length / 2);
  if (pointCount < 3) return false;
  let inside = false;
  for (let index = 0, previous = pointCount - 1; index < pointCount; previous = index, index += 1) {
    const currentX = ring[index * 2];
    const currentY = ring[index * 2 + 1];
    const previousX = ring[previous * 2];
    const previousY = ring[previous * 2 + 1];
    const crossesRay = currentY > y !== previousY > y;
    if (!crossesRay) continue;
    const intersectX = ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;
    if (x < intersectX) inside = !inside;
  }
  return inside;
}

/**
 * Shortest distance from a point to the ring's boundary, in the ring's own
 * units. Unsigned: a point well inside a big hold and a point the same distance
 * outside a small one both read as that distance.
 *
 * The companion to {@link pointInRing} for the "is this ring drawn around this
 * placement" test. The predicate alone is too strict — a hold whose bolt sits
 * under a concave underside genuinely traces without containing its centre — so
 * the gate admits a near miss and rejects a far one; see
 * {@link CENTRE_TOLERANCE_RADII}.
 */
export function distanceToRing(ring: number[], x: number, y: number): number {
  const pointCount = Math.floor(ring.length / 2);
  if (pointCount < 2) return Infinity;
  let shortest = Infinity;
  for (let index = 0; index < pointCount; index += 1) {
    const next = (index + 1) % pointCount;
    const fromX = ring[index * 2];
    const fromY = ring[index * 2 + 1];
    const edgeX = ring[next * 2] - fromX;
    const edgeY = ring[next * 2 + 1] - fromY;
    const edgeLengthSquared = edgeX * edgeX + edgeY * edgeY;
    const along =
      edgeLengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((x - fromX) * edgeX + (y - fromY) * edgeY) / edgeLengthSquared));
    shortest = Math.min(shortest, Math.hypot(x - (fromX + along * edgeX), y - (fromY + along * edgeY)));
  }
  return shortest;
}

/**
 * Is this a storable outline ring? Flat, even-length, 3..150 points, every
 * coordinate finite and inside {@link MAX_RING_COORDINATE} radii.
 *
 * Shape only — whether the ring contains its placement centre is a separate,
 * caller-specific question (see {@link pointInRing}).
 */
export function isValidOutlineRing(ring: unknown): ring is number[] {
  if (!Array.isArray(ring)) return false;
  if (ring.length % 2 !== 0) return false;
  if (ring.length < MIN_RING_NUMBERS || ring.length > MAX_RING_NUMBERS) return false;
  return ring.every(
    (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_RING_COORDINATE,
  );
}
