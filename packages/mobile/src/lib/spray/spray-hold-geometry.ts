// Canonical wall coordinates -> this version's photo pixels (issue #5440).
//
// A spray wall's holds are stored once, in the wall's canonical frame, and every
// version's photo carries its own photo->canonical homography. No image is ever
// warped (`docs/spray-walls.md`, "Canonical coordinates and matching"), so the
// render path pushes each hold back through the INVERSE of that matrix and paints
// it on the untouched photograph.
//
// Pure, and deliberately separate from the registry and the hook: the mapping is
// the part that can be wrong in a way nobody sees until a hold lands on bare wall,
// so it has to be testable without a React Query cache or a network round trip.

import { invert, mapPoint, mapRadius, mapRing, type Homography } from '@boardsesh/spray-wall-geometry';
import { MAX_RING_COORDINATE, isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';

/** Where a hold's geometry came from, in the wire's own spelling. */
export type SprayHoldProvenance = {
  /**
   * Whether a detector or a human put this hold on the wall.
   *
   * Optional because it is not geometry: nothing on the render path reads it, and
   * a payload written before it existed simply does not carry it. The EDITOR
   * reads it (#5441) — without it, an accepted detector hold is re-submitted as
   * MANUAL the first time it is nudged, overwriting the provenance the server
   * stored.
   */
  source?: 'MANUAL' | 'AUTO';
  /** Detector confidence 0–1 for an AUTO hold; absent when a human drew it. */
  confidence?: number | null;
};

/** One hold as the server stores it: centre, radius and silhouette in canonical pixels. */
export type CanonicalSprayHold = SprayHoldProvenance & {
  id: number;
  cx: number;
  cy: number;
  r: number;
  /**
   * Flat implicitly-closed ring in units of THIS hold's radius, relative to its
   * centre — the `@boardsesh/board-art-geometry` contract. Absent for a hold
   * nobody has traced, which the renderer draws as a ring at `r`.
   */
  outline?: readonly number[] | null;
};

/** The same hold in photo pixels, ready for `HoldPlacement` + the geometry table. */
export type SprayPhotoHold = SprayHoldProvenance & {
  id: number;
  cx: number;
  cy: number;
  r: number;
  /** Still in radius units, but of the MAPPED radius — see `mapHoldOutline`. */
  outline?: number[];
};

/** Smallest radius a mapped hold may have, in photo pixels. Below this it is not a tap target. */
const MIN_MAPPED_RADIUS_PX = 1;

function isFinitePair(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y);
}

/**
 * Map one hold's silhouette into the photo, and back into radius units of the
 * hold's NEW radius.
 *
 * Point by point rather than by scaling the stored ring, because a homography is
 * not affine: the far side of a wall photographed off-axis is compressed more
 * than the near side, and a hold's outline has to compress with it. Each stored
 * `[ox, oy]` is expanded to the canonical absolute point `(cx + ox·r, cy + oy·r)`,
 * mapped, then divided back through the mapped centre and radius — which is the
 * frame every consumer of `BoardArtGeometry.outlines` already reads.
 *
 * Returns `undefined` rather than a broken ring whenever the result would not
 * satisfy the stored-ring contract (non-finite points, or a coordinate past
 * `MAX_RING_COORDINATE`). The renderer's ring fallback is the right answer for a
 * hold whose silhouette did not survive the map; a ring four radii wide is not.
 */
function mapHoldOutline(
  inverse: Homography,
  hold: CanonicalSprayHold,
  mappedCx: number,
  mappedCy: number,
  mappedR: number,
): number[] | undefined {
  const stored = hold.outline;
  if (!stored || stored.length < 6 || hold.r <= 0) return undefined;

  const canonicalRing: number[] = [];
  for (let index = 0; index + 1 < stored.length; index += 2) {
    canonicalRing.push(hold.cx + stored[index] * hold.r, hold.cy + stored[index + 1] * hold.r);
  }

  const photoRing = mapRing(inverse, canonicalRing);
  const relative: number[] = [];
  for (let index = 0; index + 1 < photoRing.length; index += 2) {
    const offsetX = (photoRing[index] - mappedCx) / mappedR;
    const offsetY = (photoRing[index + 1] - mappedCy) / mappedR;
    if (!isFinitePair(offsetX, offsetY)) return undefined;
    if (Math.abs(offsetX) > MAX_RING_COORDINATE || Math.abs(offsetY) > MAX_RING_COORDINATE) return undefined;
    relative.push(offsetX, offsetY);
  }

  return isValidOutlineRing(relative) ? relative : undefined;
}

/**
 * Every alive hold of a wall version, in that version's photo pixels.
 *
 * `null` when the stored homography has no inverse. `invert` THROWS on a singular
 * matrix on purpose (the alternative silently draws every hold at its canonical
 * coordinate on top of the photo — plausible-looking and completely wrong), and
 * the render path's honest answer to that is no wall at all, which is what a
 * `null` render-data result already means everywhere else on this path.
 *
 * Individual holds that map to nowhere are DROPPED rather than taking the wall
 * with them: a projective map sends points on the far side of its horizon to
 * infinity, and one bad row out of six hundred should cost one hold.
 */
export function mapCanonicalHoldsToPhoto(
  homography: readonly number[],
  holds: readonly CanonicalSprayHold[],
): SprayPhotoHold[] | null {
  let inverse: Homography;
  try {
    inverse = invert([...homography]);
  } catch {
    return null;
  }

  const mapped: SprayPhotoHold[] = [];
  for (const hold of holds) {
    const [cx, cy] = mapPoint(inverse, hold.cx, hold.cy);
    if (!isFinitePair(cx, cy)) continue;

    const r = hold.r * mapRadius(inverse, hold.cx, hold.cy);
    if (!Number.isFinite(r) || r < MIN_MAPPED_RADIUS_PX) continue;

    const outline = mapHoldOutline(inverse, hold, cx, cy, r);
    // Provenance rides along unchanged — it is not geometry, and the homography
    // has no opinion about who drew the hold.
    const provenance = { source: hold.source, confidence: hold.confidence };
    mapped.push(
      outline ? { id: hold.id, cx, cy, r, outline, ...provenance } : { id: hold.id, cx, cy, r, ...provenance },
    );
  }
  return mapped;
}
