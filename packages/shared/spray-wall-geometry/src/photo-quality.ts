/**
 * Is this photo straight-on enough to flatten?
 *
 * The generated wall looks (`wall-crop`, `hold-cutouts`, see `clean-art.ts`)
 * stretch the photo into the canonical frame. A photo taken square to the wall
 * stretches every part of it by about the same amount; one taken from a sharp
 * angle has to stretch the far side much more than the near side, and the far
 * side comes out blurred and smeared. This module puts one number on that, and
 * the server and the app both read the verdict from here so they always agree.
 *
 * The number is `stretch`: sample the canonical -> photo map on a 15 x 15 grid
 * over the middle 90% of the frame, take the area scale `|det J|` at every
 * sample, and report `sqrt(max / min)`. 1 means every part of the wall is
 * stretched equally. 2 means one part is stretched twice as much, along each
 * side, as another.
 *
 * The thresholds come from a spike over real climbers' wall photos (October
 * 2026): a near front-on photo scored 1.25 and flattened cleanly; a strongly
 * keystoned one scored 2.87 and its far side came out visibly smeared. 1.7 and
 * 2.2 are where the results stopped looking good and stopped being usable. `docs/spray-walls.md` ("Generated wall looks") keeps the table.
 */
import {
  IDENTITY_HOMOGRAPHY,
  type Homography,
  type Quad,
  type ReferenceSize,
  homographyFromAnchors,
  invert,
  isValidAnchorQuad,
} from './homography';

/** At or below this `stretch` the flattened wall looks clean. */
export const ART_STRETCH_GOOD_MAX = 1.7;
/** Above `good` and at or below this, it is usable; the app suggests a front-on retake. */
export const ART_STRETCH_SOFT_MAX = 2.2;
/**
 * Smallest short edge, in canonical pixels, a flattened frame may have. Below
 * this a phone screen shows the art upscaled and soft.
 */
export const ART_MIN_FRAME_SHORT_EDGE = 1000;
/** Samples per side of the stretch grid. */
export const ART_STRETCH_GRID = 15;
/** The grid covers this fraction of the frame, centred, so the edge pixels do not dominate. */
export const ART_STRETCH_GRID_MARGIN = 0.05;

export type ArtVerdict = 'good' | 'soft' | 'fail';

/**
 * Why a verdict is what it is:
 * - `ok`: good or soft on stretch alone;
 * - `no-pins`: the version has no corner pins, so its homography is the
 *   identity and there is nothing to flatten;
 * - `keystone`: stretch above `ART_STRETCH_SOFT_MAX`;
 * - `small-frame`: the frame's short edge is below `ART_MIN_FRAME_SHORT_EDGE`;
 * - `singular`: the stored matrix cannot be inverted or folds the frame over.
 */
export type ArtQualityReason = 'ok' | 'no-pins' | 'keystone' | 'small-frame' | 'singular';

export type PhotoQuality = {
  /** `sqrt(max / min)` of `|det J|` over the grid. Null when it could not be measured. */
  stretch: number | null;
  frameShortEdge: number;
  verdict: ArtVerdict;
  reason: ArtQualityReason;
};

function isIdentity(homography: Homography): boolean {
  return homography.every((value, index) => Math.abs(value - IDENTITY_HOMOGRAPHY[index]) < 1e-12);
}

function isQuad(source: Homography | Quad): source is Quad {
  return isValidAnchorQuad(source);
}

/** `det J` of a homography at one point, or NaN where the map is undefined. */
function jacobianDeterminant(homography: Homography, x: number, y: number): number {
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = homography;
  const w = h20 * x + h21 * y + h22;
  if (!Number.isFinite(w) || w === 0) return Number.NaN;
  const u = (h00 * x + h01 * y + h02) / w;
  const v = (h10 * x + h11 * y + h12) / w;
  const dudx = (h00 - u * h20) / w;
  const dudy = (h01 - u * h21) / w;
  const dvdx = (h10 - v * h20) / w;
  const dvdy = (h11 - v * h21) / w;
  return dudx * dvdy - dudy * dvdx;
}

/**
 * The stretch of a canonical -> photo map over a frame, or null when the map is
 * undefined somewhere on the grid or folds the frame over (the determinant
 * changes sign).
 */
export function measureStretch(canonicalToPhoto: Homography, frame: ReferenceSize): number | null {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = 0;
  let sign = 0;
  const span = 1 - 2 * ART_STRETCH_GRID_MARGIN;
  for (let column = 0; column < ART_STRETCH_GRID; column++) {
    const x = (ART_STRETCH_GRID_MARGIN + (span * column) / (ART_STRETCH_GRID - 1)) * frame.width;
    for (let row = 0; row < ART_STRETCH_GRID; row++) {
      const y = (ART_STRETCH_GRID_MARGIN + (span * row) / (ART_STRETCH_GRID - 1)) * frame.height;
      const determinant = jacobianDeterminant(canonicalToPhoto, x, y);
      if (!Number.isFinite(determinant) || determinant === 0) return null;
      const here = Math.sign(determinant);
      if (sign !== 0 && here !== sign) return null;
      sign = here;
      const magnitude = Math.abs(determinant);
      minimum = Math.min(minimum, magnitude);
      maximum = Math.max(maximum, magnitude);
    }
  }
  return Math.sqrt(maximum / minimum);
}

/**
 * The quality verdict for one version's photo.
 *
 * `source` is either the version's four corner pins in photo pixels
 * (TL/TR/BR/BL), solved onto `frame` the way `createSprayWallVersion` solves
 * them, or its stored photo -> canonical homography. Prefer the pins when you
 * have them: a stored identity reads as "no pins", but pins on the photo's own
 * corners also solve to the identity. `frame` is the wall's
 * canonical frame (`reference_width` x `reference_height`).
 *
 * Never throws. A matrix `invert` refuses is a `singular` fail, not an error:
 * this is a gate on optional art, and a wall with a broken matrix still has its
 * photo.
 */
export function photoQuality(source: Homography | Quad | null | undefined, frame: ReferenceSize): PhotoQuality {
  const frameShortEdge = Math.min(frame.width, frame.height);
  const fail = (reason: ArtQualityReason, stretch: number | null = null): PhotoQuality => ({
    stretch,
    frameShortEdge,
    verdict: 'fail',
    reason,
  });

  if (!Number.isFinite(frameShortEdge) || frameShortEdge <= 0) return fail('small-frame');
  if (!source) return fail('no-pins');

  // Pins tapped exactly on the photo's corners solve to the identity too, and
  // that is a front-on photo, not a missing one. So the identity only means "no
  // pins" when it arrives as a stored matrix; a caller holding the pins passes
  // them instead.
  const fromPins = isQuad(source);
  const photoToCanonical = fromPins ? homographyFromAnchors(source, frame) : source;
  if (photoToCanonical.length !== 9 || photoToCanonical.some((value) => !Number.isFinite(value))) {
    return fail('singular');
  }
  if (!fromPins && isIdentity(photoToCanonical)) return fail('no-pins');

  let canonicalToPhoto: Homography;
  try {
    canonicalToPhoto = invert(photoToCanonical);
  } catch {
    return fail('singular');
  }

  const stretch = measureStretch(canonicalToPhoto, frame);
  if (stretch === null) return fail('singular');
  if (stretch > ART_STRETCH_SOFT_MAX) return fail('keystone', stretch);
  if (frameShortEdge < ART_MIN_FRAME_SHORT_EDGE) return fail('small-frame', stretch);
  return { stretch, frameShortEdge, verdict: stretch <= ART_STRETCH_GOOD_MAX ? 'good' : 'soft', reason: 'ok' };
}
