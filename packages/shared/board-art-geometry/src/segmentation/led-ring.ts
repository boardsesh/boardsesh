/**
 * The Kilter LED base-plate extractor: find the hold-proper INNER boundary
 * inside a traced silhouette, so the ring of plate around it can be lit.
 *
 * PURE, and deliberately so. Nothing here decodes an image, reads a file or
 * touches `sharp` — the caller hands over a local RGBA crop and a silhouette
 * mask and gets a polygon or a refusal back. That is what lets the whole
 * classifier be unit-tested against a synthetic two-tone fixture instead of
 * against 499 real holds, and it is the same split `ring.ts` already makes
 * between ring maths and the shard tables.
 *
 * WHAT THE ART LOOKS LIKE
 * ----------------------
 * On Kilter "Homewall-style" art each hold is drawn as a neutral silver-grey
 * body sitting on a beige/tan LED base plate, and the plate shows as a band
 * hugging the hold's perimeter — thick along the shaded bottom edge, thin along
 * the lit top edge. The lit region a renderer wants is that band: the silhouette
 * MINUS the hold proper.
 *
 * WHY NORMALISED CHROMATICITY, AND NOT LUMA OR RAW R-B
 * ---------------------------------------------------
 * Three classifiers were tried against a hand-marked ground-truth hold before
 * this one, and the first two are wrong in instructive ways:
 *
 *   - LUMA (2- and 3-class Otsu inside the silhouette) splits every hold
 *     strongly, and the split it finds is the hold's own shading gradient, not
 *     the plate. The global luma histogram is broad and unimodal: there are no
 *     tone bands to find.
 *   - RAW WARMTH (R-B >= 30) does find the plate, and thins or vanishes exactly
 *     where the art is brightly lit or deeply shaded — because R-B scales with
 *     illumination. A shaded stretch of beige plate reads colder than a lit
 *     stretch of grey hold.
 *   - NORMALISED CHROMATICITY, (R-B)/(R+B), is illumination-invariant: scaling
 *     all three channels by a shading factor leaves it unchanged. Brown stays
 *     brown in shadow. The ring then closes around virtually every hold,
 *     including the lit tops the raw measure dropped.
 *
 * Quantiles of the measure over Kilter Homewall 12x12 hold pixels: p25 0.050,
 * p50 0.073, p75 0.112, p90 0.158. {@link WARM_CHROMA_THRESHOLD} sits at 0.10 —
 * 0.09 gives a fuller ring, 0.12 a thinner one with occasional gaps.
 *
 * THE SMOOTHING IS NOT COSMETIC
 * -----------------------------
 * A per-pixel class boundary reads as a hard, sharp line: real base plates do
 * not have one, and neither does a photograph of one. The chain
 * close(2) -> open(1) -> drop specks -> blur -> re-threshold is what turns a
 * ragged per-pixel decision into a curve, and each step earns its place:
 * closing bridges the pinholes a hard threshold leaves in a nearly-uniform band,
 * opening removes the single-pixel fringe it creates, the component filter
 * removes speckle in the hold body, and the blur rounds the inner border.
 *
 * EVERY CONSTANT HERE IS A CALIBRATION ANCHOR, NOT A LAW. They were tuned
 * visually against one board's art and one hand-marked hold. The intended
 * retuning loop is against `hold_outline_overrides` rows of
 * `kind = 'led_inner'`, which are ground truth and which always REPLACE
 * extractor output at the merge — see `docs/board-art-geometry.md`.
 */

import {
  ORTHOGONAL,
  component,
  components,
  dilate,
  dropSmallComponents,
  erode,
  fillHoles,
  isSimpleRing,
  traceMaskBorder,
  trimNecks,
} from '../raster';
import { simplifyRing, type RingPoint } from '../ring';

// ---------------------------------------------------------------------------
// Calibration constants
// ---------------------------------------------------------------------------

/**
 * Normalised chromaticity `(R-B)/(R+B)` at or above which a pixel is base plate
 * rather than hold body.
 *
 * 0.10 is the midpoint of the interval two review passes bracketed (0.09 fuller,
 * 0.12 thinner with rare gaps) and sits between the p50 and p75 of the measure
 * over Kilter Homewall hold pixels, which is where a band covering roughly a
 * fifth of each hold should sit.
 */
export const WARM_CHROMA_THRESHOLD = 0.1;

/** Binary closing radius, in board pixels — bridges pinholes in the band. */
export const CLOSE_RADIUS = 2;
/** Binary opening radius, in board pixels — removes the fringe closing creates. */
export const OPEN_RADIUS = 1;
/**
 * Board px² a warm component must reach to survive.
 *
 * Speckle in the hold body is the target: a handful of pixels that happen to
 * clear the chroma threshold, which the blur would otherwise grow into a dent in
 * the inner boundary.
 */
export const MIN_WARM_COMPONENT_PX = 30;
/** Gaussian sigma the ring mask is smoothed at, in board pixels. */
export const BLUR_SIGMA = 2;
/**
 * Kernel half-width in sigmas. 3 sigma carries 99.7% of the weight, and the
 * integer kernel's tail terms round to single-digit weights against a 65536
 * centre, so a wider kernel would change nothing and cost time.
 */
export const BLUR_KERNEL_SIGMAS = 3;

/**
 * Bounds on the hold-proper interior as a share of the silhouette.
 *
 * Below the floor the "ring" has swallowed the hold, which is what a config
 * whose art is warm all over looks like; above the ceiling there is barely a
 * band at all and lighting it would be indistinguishable from lighting nothing.
 * Wide on purpose — the per-hold gates that matter are structural (the band
 * touches the boundary, the interior is one body around the bolt), and this pair
 * only fences off the two degenerate ends.
 */
export const MIN_INTERIOR_AREA_SHARE = 0.25;
export const MAX_INTERIOR_AREA_SHARE = 0.95;

/**
 * Share of the interior the component around the placement centre has to carry.
 *
 * An interior that has broken into two comparable pieces means the band has cut
 * clean across the hold, which is a misclassification rather than a base plate:
 * a plate surrounds a hold, it does not bisect one.
 */
export const MIN_INTERIOR_DOMINANCE = 0.75;

/**
 * Border points the inner contour needs before it is a shape rather than a
 * few pixels. The tracer's own floor for a silhouette, restated: an inner
 * boundary shorter than this is a speck, not a hold body.
 */
export const MIN_INNER_PERIMETER_POINTS = 24;

/**
 * Douglas-Peucker tolerance for the inner contour, in board pixels. The
 * tracer's own {@link SIMPLIFY_EPSILON_BOARD_PX}, restated as a named constant
 * here so the inner ring is decimated by exactly what decimated the silhouette
 * it sits inside.
 */
export const INNER_SIMPLIFY_EPSILON_BOARD_PX = 1.6;

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Normalised chromaticity `(R-B)/(R+B)`, the illumination-invariant "how brown
 * is this pixel" measure the whole extractor turns on.
 *
 * The denominator is floored at 1 rather than guarded with a branch, so a black
 * pixel returns 0 (neutral) instead of dividing by zero. A pixel that dark
 * carries no colour information either way.
 */
export function normalisedWarmth(red: number, blue: number): number {
  return (red - blue) / Math.max(1, red + blue);
}

/**
 * Pixels inside `inside` whose chromaticity clears `threshold`.
 *
 * `pixels` is RGBA, four bytes per pixel, in the same `width * height` frame as
 * `inside`. Alpha is not consulted: the caller has already decided what counts
 * as hold, and a transparent pixel reads as `(0-0)/1 = 0` and fails the
 * threshold on its own.
 */
export function warmMask(
  pixels: Uint8Array,
  inside: Uint8Array,
  threshold: number = WARM_CHROMA_THRESHOLD,
): Uint8Array {
  const mask = new Uint8Array(inside.length);
  for (let index = 0; index < inside.length; index += 1) {
    if (inside[index] !== 1) continue;
    if (normalisedWarmth(pixels[index * 4], pixels[index * 4 + 2]) >= threshold) mask[index] = 1;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// The blur, and why it is exact
// ---------------------------------------------------------------------------

/**
 * Fixed-point scale for the Gaussian weights. 65536 leaves the tail terms of a
 * sigma-2 kernel at 2-digit weights, so the rounding to integers is far below
 * the decision the threshold makes.
 */
const KERNEL_SCALE = 65536;

/**
 * A separable Gaussian kernel as INTEGER weights, `[centre, ...one side]`
 * reflected — index `i` of the returned array is offset `i - radius`.
 *
 * Integers because the blur has to be byte-stable across runs and machines. The
 * only floating-point operation in the whole chain is building this table, and
 * it is immediately rounded to integers at a scale where a last-bit difference
 * in `Math.exp` cannot change the result. Everything downstream is exact integer
 * arithmetic in doubles — see {@link blurAndThreshold}.
 */
export function gaussianKernel(sigma: number): Int32Array {
  const radius = Math.ceil(sigma * BLUR_KERNEL_SIGMAS);
  const kernel = new Int32Array(radius * 2 + 1);
  for (let offset = -radius; offset <= radius; offset += 1) {
    kernel[offset + radius] = Math.round(Math.exp(-(offset * offset) / (2 * sigma * sigma)) * KERNEL_SCALE);
  }
  return kernel;
}

/**
 * Blur a binary mask with a separable Gaussian and re-threshold at half.
 *
 * EXACT INTEGER ARITHMETIC, no division anywhere. The horizontal pass sums
 * `kernel[i] * mask[...]` into at most `kernelSum` (~8.5e5 at sigma 2); the
 * vertical pass sums `kernel[j] * horizontal[...]` into at most `kernelSum²`
 * (~7.3e11). Both are integers well inside the 2^53 a double represents
 * exactly, so no intermediate value is ever rounded. The threshold is then the
 * exact comparison `2 * blurred >= kernelSum²` — a fully-white neighbourhood
 * gives exactly `kernelSum²`, so this is the 0.5 level with no epsilon and no
 * tie-breaking rule to get wrong.
 *
 * Off the edge counts as 0, which matches the morphology above and is the
 * conservative direction: the caller re-clips to the silhouette regardless.
 */
export function blurAndThreshold(
  mask: Uint8Array,
  width: number,
  height: number,
  sigma: number = BLUR_SIGMA,
): Uint8Array {
  const kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) / 2;
  let kernelSum = 0;
  for (const weight of kernel) kernelSum += weight;

  const horizontal = new Float64Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      const from = Math.max(0, x - radius);
      const to = Math.min(width - 1, x + radius);
      for (let sampleX = from; sampleX <= to; sampleX += 1) {
        if (mask[row + sampleX] === 1) total += kernel[sampleX - x + radius];
      }
      horizontal[row + x] = total;
    }
  }

  const out = new Uint8Array(mask.length);
  const halfLevel = kernelSum * kernelSum;
  for (let y = 0; y < height; y += 1) {
    const from = Math.max(0, y - radius);
    const to = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      for (let sampleY = from; sampleY <= to; sampleY += 1) {
        const value = horizontal[sampleY * width + x];
        if (value !== 0) total += kernel[sampleY - y + radius] * value;
      }
      if (total * 2 >= halfLevel) out[y * width + x] = 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

/** Why a hold carries no LED-inner ring. Omitting one is the normal outcome. */
export type LedInnerRejection =
  /** No pixel inside the silhouette is warm enough to be plate. */
  | 'no-warm-pixels'
  /**
   * Nothing warm survived the cleanup, or nothing warm reaches the silhouette's
   * own boundary. A base plate is what the hold SITS ON, so it is visible around
   * the hold's edge by construction; a warm blob floating in the middle of a
   * hold is a painted feature, not a plate.
   */
  | 'ring-not-at-boundary'
  /** The band swallowed the hold: no interior left at all. */
  | 'interior-empty'
  /** The interior broke into comparable pieces — the band bisected the hold. */
  | 'interior-not-dominant'
  /** The interior is a sliver, or is the whole silhouette with no band worth lighting. */
  | 'interior-area-out-of-bounds'
  /** The inner contour is too short to be a shape. */
  | 'inner-perimeter-too-short'
  /**
   * The simplified contour crosses itself.
   *
   * The backstop for the defect the neck trim exists to prevent, kept because
   * the trim is a fix and this is a proof. A 1-pixel isthmus left by the
   * blur's re-threshold makes the border follower walk out along one side and
   * back along the other, and Douglas-Peucker then replaces the round trip
   * with two chords that cross — a bow tie, which renders as a hole in the
   * wrong place and passes every area and containment test there is.
   */
  | 'not-a-simple-ring';

export type LedInnerExtraction =
  | {
      accepted: true;
      /**
       * The hold-proper boundary, in the caller's own pixel frame — the same
       * units and origin as the `silhouette` that came in.
       */
      contour: RingPoint[];
      /** Board px² of the silhouette, the interior, and the band between them. */
      silhouetteArea: number;
      interiorArea: number;
      ringArea: number;
    }
  | { accepted: false; reason: LedInnerRejection };

export type LedInnerOptions = {
  warmChromaThreshold?: number;
  closeRadius?: number;
  openRadius?: number;
  minWarmComponentPx?: number;
  blurSigma?: number;
  minInteriorAreaShare?: number;
  maxInteriorAreaShare?: number;
  minInteriorDominance?: number;
  minInnerPerimeterPoints?: number;
  simplifyEpsilon?: number;
  /**
   * Neck-trim radius in board pixels, from the caller's own placement radius.
   * Omit it and the interior is traced untrimmed — see {@link trimNecks}.
   */
  neckTrimRadius?: number;
};

/**
 * Extract one hold's LED base-plate inner boundary.
 *
 * `pixels` is an RGBA crop, `silhouette` the traced hold mask over the same
 * `width * height` frame, and `centre` the placement centre in that frame. The
 * returned contour is in the same frame, ready for the caller to offset and
 * divide through by the placement radius.
 *
 * The pipeline, in order, with the reason each step exists in the module note:
 * chroma threshold -> close -> open -> drop specks -> blur -> re-threshold ->
 * re-clip to the silhouette -> keep only the band components that touch the
 * silhouette boundary -> interior is the silhouette minus that band -> take the
 * body around the bolt -> fill its holes -> trim its thin necks -> trace ->
 * simplify -> refuse anything that crosses itself.
 */
export function extractLedInner(
  pixels: Uint8Array,
  silhouette: Uint8Array,
  width: number,
  height: number,
  centre: RingPoint,
  options: LedInnerOptions = {},
): LedInnerExtraction {
  const warmThreshold = options.warmChromaThreshold ?? WARM_CHROMA_THRESHOLD;
  const closeRadius = options.closeRadius ?? CLOSE_RADIUS;
  const openRadius = options.openRadius ?? OPEN_RADIUS;
  const minComponent = options.minWarmComponentPx ?? MIN_WARM_COMPONENT_PX;
  const sigma = options.blurSigma ?? BLUR_SIGMA;
  const minShare = options.minInteriorAreaShare ?? MIN_INTERIOR_AREA_SHARE;
  const maxShare = options.maxInteriorAreaShare ?? MAX_INTERIOR_AREA_SHARE;
  const minDominance = options.minInteriorDominance ?? MIN_INTERIOR_DOMINANCE;
  const minPerimeter = options.minInnerPerimeterPoints ?? MIN_INNER_PERIMETER_POINTS;
  const epsilon = options.simplifyEpsilon ?? INNER_SIMPLIFY_EPSILON_BOARD_PX;
  const neckRadius = options.neckTrimRadius ?? null;

  let silhouetteArea = 0;
  for (let index = 0; index < silhouette.length; index += 1) silhouetteArea += silhouette[index];

  const warm = warmMask(pixels, silhouette, warmThreshold);
  let warmArea = 0;
  for (let index = 0; index < warm.length; index += 1) warmArea += warm[index];
  if (warmArea === 0) return { accepted: false, reason: 'no-warm-pixels' };

  // close(r) = dilate then erode: bridge the pinholes a hard threshold leaves in
  // a band that is nearly but not quite uniform.
  const closed = erode(dilate(warm, width, height, closeRadius), width, height, closeRadius);
  // open(r) = erode then dilate: take back the single-pixel fringe closing adds.
  const opened = dilate(erode(closed, width, height, openRadius), width, height, openRadius);
  const despeckled = dropSmallComponents(opened, width, height, minComponent);
  const smoothed = blurAndThreshold(despeckled, width, height, sigma);

  // Re-clip: the blur grows the band outward as well as inward, and anything
  // outside the silhouette is another hold's problem.
  const band = new Uint8Array(smoothed.length);
  for (let index = 0; index < band.length; index += 1) {
    band[index] = smoothed[index] === 1 && silhouette[index] === 1 ? 1 : 0;
  }

  // A plate is visible around the hold's EDGE. Keeping only the band components
  // that reach the silhouette boundary is both the acceptance test and the fix
  // for the bolt hole, which reads warm and is a dot in the middle of the hold.
  const boundaryBand = new Uint8Array(band.length);
  let bandArea = 0;
  for (const members of components(band, width, height)) {
    let touchesBoundary = false;
    for (const index of members) {
      const x = index % width;
      const y = (index - x) / width;
      for (const [stepX, stepY] of ORTHOGONAL) {
        const nextX = x + stepX;
        const nextY = y + stepY;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height || silhouette[nextY * width + nextX] !== 1) {
          touchesBoundary = true;
          break;
        }
      }
      if (touchesBoundary) break;
    }
    if (!touchesBoundary) continue;
    for (const index of members) boundaryBand[index] = 1;
    bandArea += members.length;
  }
  if (bandArea === 0) return { accepted: false, reason: 'ring-not-at-boundary' };

  const interior = new Uint8Array(band.length);
  let interiorArea = 0;
  for (let index = 0; index < interior.length; index += 1) {
    if (silhouette[index] !== 1 || boundaryBand[index] === 1) continue;
    interior[index] = 1;
    interiorArea += 1;
  }
  if (interiorArea === 0) return { accepted: false, reason: 'interior-empty' };

  // The body around the bolt. Where the bolt itself is not interior — a hold
  // whose plate covers the placement, or a silhouette registered against the
  // wrong hold — the LARGEST interior component stands in.
  //
  // Largest, not nearest, and the difference is not academic. The blur pulls the
  // band a pixel back from the silhouette's own edge, so there is very often a
  // one-pixel sliver of interior OUTSIDE the band, hugging the boundary. That
  // sliver is the nearest interior pixel to any centre lying outside the hold,
  // so a nearest-pixel rule anchors on it and then reports the real body as a
  // rival component: every off-placement silhouette came back
  // `interior-not-dominant` rather than reaching the centre rule that is
  // supposed to catch it. The tracer makes the same call for the same reason —
  // where its seed is not core, the largest core stands in.
  const centreX = Math.round(centre[0]);
  const centreY = Math.round(centre[1]);
  const visited = new Uint8Array(interior.length);
  let body: number[] = [];
  if (
    centreX >= 0 &&
    centreY >= 0 &&
    centreX < width &&
    centreY < height &&
    interior[centreY * width + centreX] === 1
  ) {
    body = component(interior, width, height, centreY * width + centreX, visited);
  } else {
    // Ties go to the component whose first pixel comes first in scan order, so
    // the choice is reproducible rather than dependent on visit order.
    for (let index = 0; index < interior.length; index += 1) {
      if (interior[index] !== 1 || visited[index] === 1) continue;
      const candidate = component(interior, width, height, index, visited);
      if (candidate.length > body.length) body = candidate;
    }
  }
  if (body.length === 0) return { accepted: false, reason: 'interior-empty' };
  // The body member nearest the placement — the centre pixel itself whenever it
  // is interior, which is almost always. `trimNecks` anchors on it, and its own
  // fallbacks cover the rest: an anchor that is not core hands over to the
  // largest core, and a trim that would drop the anchor leaves the mask alone.
  let anchor = body[0];
  let bestDistance = Infinity;
  for (const index of body) {
    const x = index % width;
    const y = (index - x) / width;
    const distance = (x - centreX) ** 2 + (y - centreY) ** 2;
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    anchor = index;
  }

  if (body.length < interiorArea * minDominance) {
    return { accepted: false, reason: 'interior-not-dominant' };
  }

  const bodyMask = new Uint8Array(interior.length);
  for (const index of body) bodyMask[index] = 1;
  // Fill first, THEN trim, in that order and for the tracer's reason: the
  // erosion eats the rim around a punched-out bolt hole from both sides at
  // once, so on a small hold with a big hole the whole rim would go.
  const filled = fillHoles(bodyMask, width, height);
  // Trim the isthmuses the blur's re-threshold leaves behind, then fill again —
  // the trim's `grown ∩ mask` can pinch a bay closed into a hole, and the
  // extractor emits an outer border only.
  const trimmed =
    neckRadius === null ? filled : fillHoles(trimNecks(filled, width, height, anchor, neckRadius), width, height);
  const solid = trimmed;
  let solidArea = 0;
  for (let index = 0; index < solid.length; index += 1) solidArea += solid[index];

  const share = silhouetteArea === 0 ? 0 : solidArea / silhouetteArea;
  if (share < minShare || share > maxShare) {
    return { accepted: false, reason: 'interior-area-out-of-bounds' };
  }

  const border = traceMaskBorder(solid, width, height);
  if (border.length < minPerimeter) {
    return { accepted: false, reason: 'inner-perimeter-too-short' };
  }

  // The backstop, and it has to be AFTER the simplification: the traced border
  // is a pixel walk and is simple by construction, and it is Douglas-Peucker
  // replacing a round trip through an isthmus with two crossing chords that
  // makes a bow tie. The trim above is the fix; this is the proof that it
  // worked, on every ring that ships.
  const contour = simplifyRing(border, epsilon);
  if (!isSimpleRing(contour)) {
    return { accepted: false, reason: 'not-a-simple-ring' };
  }

  return {
    accepted: true,
    contour,
    silhouetteArea,
    interiorArea: solidArea,
    ringArea: silhouetteArea - solidArea,
  };
}
