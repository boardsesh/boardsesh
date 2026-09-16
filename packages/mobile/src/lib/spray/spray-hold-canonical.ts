// This version's photo pixels -> canonical wall coordinates (issue #5441).
//
// The exact inverse of `spray-hold-geometry.ts`, and it exists for the same
// reason that one does: the editor draws on the untouched photograph, because no
// image is ever warped (`docs/spray-walls.md`, "Canonical coordinates and
// matching"), but a hold is STORED once in the wall's canonical frame so that
// every later photograph of the same wall agrees about where it is.
//
// So the read path divides by the homography and the write path multiplies by
// it, and the two have to be exact mirrors or a hold saved at the top of the
// wall comes back a hand's width to the left. Both are pure, both are tested,
// and the test that matters is the round trip.

import { mapPoint, mapRadius, mapRing, type Homography } from '@boardsesh/spray-wall-geometry';
import { roundRing } from '@boardsesh/board-art-geometry/ring';
import { OUTLINE_DECIMALS } from '../../components/outline-editor/stroke';
import type { CanonicalSprayHold } from './spray-hold-geometry';

/** A hold as the editor holds it: photo pixels, ring in units of the photo radius. */
export type PhotoSprayHold = {
  cx: number;
  cy: number;
  r: number;
  outline?: readonly number[] | null;
};

/**
 * Smallest canonical radius a hold may be written at.
 *
 * `SprayWallHoldInputSchema` types `r` as `z.number().int().min(1)`, so a hold
 * that maps to a sub-pixel radius would round to 0 and be refused by the server.
 * One canonical pixel is the floor the column itself imposes.
 */
const MIN_CANONICAL_RADIUS = 1;

/**
 * The bounds `SprayWallHoldInputSchema` imposes on a stored hold.
 *
 * Checked here rather than left to the server, because Zod refuses the WHOLE
 * batch: one hold mapped near the homography's horizon — finite, but a hundred
 * thousand pixels out — would take ninety good holds down with it. Answering
 * `null` instead routes that hold into the write plan's `unmappableIds`, which
 * is the drop-one-hold outcome the plan exists to produce.
 */
const MAX_CANONICAL_PIXEL = 100_000;
const MAX_CANONICAL_RADIUS = 10_000;

function isFinitePair(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y);
}

/**
 * Map one hold's silhouette out of the photo and into radius units of its
 * CANONICAL radius.
 *
 * Point by point, for the reason the read path gives: a homography is not
 * affine, so the near and far sides of an off-axis wall compress by different
 * amounts and a ring cannot simply be rescaled.
 *
 * Returns `undefined` for a ring that did not survive — non-finite points, or a
 * ring the stored contract would refuse. The caller writes `outline: null` for
 * that hold, which is a hold with no traced silhouette rather than a hold with a
 * broken one.
 */
function mapOutlineToCanonical(
  homography: Homography,
  hold: PhotoSprayHold,
  canonicalCx: number,
  canonicalCy: number,
  canonicalR: number,
): number[] | undefined {
  const stored = hold.outline;
  if (!stored || stored.length < 6 || !(hold.r > 0) || !(canonicalR > 0)) return undefined;

  const photoRing: number[] = [];
  for (let index = 0; index + 1 < stored.length; index += 2) {
    photoRing.push(hold.cx + stored[index] * hold.r, hold.cy + stored[index + 1] * hold.r);
  }

  const canonicalRing = mapRing(homography, photoRing);
  const relative: number[] = [];
  for (let index = 0; index + 1 < canonicalRing.length; index += 2) {
    const offsetX = (canonicalRing[index] - canonicalCx) / canonicalR;
    const offsetY = (canonicalRing[index + 1] - canonicalCy) / canonicalR;
    if (!isFinitePair(offsetX, offsetY)) return undefined;
    relative.push(offsetX, offsetY);
  }
  // `roundRing` rather than a local rounder: it is the same function `stroke.ts`
  // rounds a drawn ring with, including the `-0` collapse, so a silhouette that
  // survives a homography is rounded exactly as one that never left the photo.
  return roundRing(relative, OUTLINE_DECIMALS);
}

/**
 * One hold in photo pixels → the canonical hold the mutation stores, or `null`
 * when the homography sends it nowhere.
 *
 * `cx`, `cy` and `r` come back as INTEGERS because the columns are integers and
 * `SprayWallHoldInputSchema` refuses anything else — rounding here rather than
 * letting Postgres truncate means the client and the server agree about where
 * the hold landed, which matters the next time the same hold is corrected.
 *
 * The outline is NOT validated here. Ring validity is the backend's contract and
 * belongs to the one predicate that states it (`ring-contract.ts`); this
 * function's job is the coordinate frame.
 */
export function mapPhotoHoldToCanonical(
  homography: readonly number[],
  hold: PhotoSprayHold,
): Omit<CanonicalSprayHold, 'id'> | null {
  const matrix: Homography = [...homography];
  const [cx, cy] = mapPoint(matrix, hold.cx, hold.cy);
  if (!isFinitePair(cx, cy)) return null;

  const scale = mapRadius(matrix, hold.cx, hold.cy);
  const r = hold.r * scale;
  if (!Number.isFinite(r) || !(r > 0)) return null;

  const roundedCx = Math.round(cx);
  const roundedCy = Math.round(cy);
  const roundedR = Math.max(MIN_CANONICAL_RADIUS, Math.round(r));

  if (Math.abs(roundedCx) > MAX_CANONICAL_PIXEL || Math.abs(roundedCy) > MAX_CANONICAL_PIXEL) return null;
  if (roundedR > MAX_CANONICAL_RADIUS) return null;

  // The ring is expressed against the ROUNDED radius, not the exact one, so the
  // hold the server stores and the hold the editor previewed describe the same
  // silhouette rather than one scaled by up to half a pixel.
  const outline = mapOutlineToCanonical(matrix, hold, roundedCx, roundedCy, roundedR);

  return { cx: roundedCx, cy: roundedCy, r: roundedR, outline: outline ?? null };
}
