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

/** 4-connected steps. Connectivity is 4 throughout, like the tracer's flood fill. */
const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

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
// Morphology
// ---------------------------------------------------------------------------

/** A closed disc of a radius, as offsets. Cached: building one is O(radius²). */
const discCache = new Map<number, Array<readonly [number, number]>>();
function disc(radius: number): Array<readonly [number, number]> {
  const cached = discCache.get(radius);
  if (cached !== undefined) return cached;
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
    }
  }
  discCache.set(radius, offsets);
  return offsets;
}

/**
 * Morphological dilation by a closed disc.
 *
 * OFF THE EDGE IS BACKGROUND, for both operators. The caller's frame is a crop
 * around one hold with a margin of empty pixels on every side, so nothing real
 * ever sits on the boundary and the two conventions cannot disagree in practice
 * — but stating it makes `erode` on a mask that fills its frame shrink from the
 * edge, which is the conservative direction for a ring that must stay inside a
 * silhouette.
 */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const offsets = disc(radius);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    for (const [stepX, stepY] of offsets) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      out[nextY * width + nextX] = 1;
    }
  }
  return out;
}

/** Morphological erosion by a closed disc. Off the edge is background. */
export function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const offsets = disc(radius);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    let clear = true;
    for (const [stepX, stepY] of offsets) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height || mask[nextY * width + nextX] !== 1) {
        clear = false;
        break;
      }
    }
    if (clear) out[index] = 1;
  }
  return out;
}

/** The 4-connected component of `mask` containing `start`, marking `visited`. */
function component(mask: Uint8Array, width: number, height: number, start: number, visited: Uint8Array): number[] {
  const members: number[] = [start];
  const stack: number[] = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    for (const [stepX, stepY] of ORTHOGONAL) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      const neighbour = nextY * width + nextX;
      if (visited[neighbour] === 1 || mask[neighbour] !== 1) continue;
      visited[neighbour] = 1;
      members.push(neighbour);
      stack.push(neighbour);
    }
  }
  return members;
}

/** Every 4-connected component of `mask`, in scan order of their first pixel. */
export function components(mask: Uint8Array, width: number, height: number): number[][] {
  const visited = new Uint8Array(mask.length);
  const found: number[][] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1 || visited[index] === 1) continue;
    found.push(component(mask, width, height, index, visited));
  }
  return found;
}

/** Drop every 4-connected component smaller than `minimumArea` board px². */
export function dropSmallComponents(mask: Uint8Array, width: number, height: number, minimumArea: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (const members of components(mask, width, height)) {
    if (members.length < minimumArea) continue;
    for (const index of members) out[index] = 1;
  }
  return out;
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
// Contours
// ---------------------------------------------------------------------------

/**
 * Moore-neighbour border following, clockwise, from a mask's topmost-leftmost
 * filled pixel.
 *
 * Copied from `scripts/generate-board-art-geometry.ts`, like `simplifyRing` in
 * `ring.ts` is: the inner boundary has to be walked by exactly the follower that
 * walked the silhouette around it, or the two polygons are produced by different
 * conventions and a renderer subtracting one from the other inherits the
 * difference. A change here has to be made there too.
 */
export function traceMaskBorder(mask: Uint8Array, width: number, height: number): RingPoint[] {
  let start: RingPoint | null = null;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    start = [x, (index - x) / width];
    break;
  }
  if (start === null) return [];

  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const offsets: RingPoint[] = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  const border: RingPoint[] = [];
  let current = start;
  let backtrackIndex = 0;
  const maxSteps = width * height * 4;

  for (let step = 0; step < maxSteps; step += 1) {
    border.push(current);
    let moved = false;
    for (let turn = 1; turn <= 8; turn += 1) {
      const index = (backtrackIndex + turn) % 8;
      const candidate: RingPoint = [current[0] + offsets[index][0], current[1] + offsets[index][1]];
      if (!at(candidate[0], candidate[1])) continue;
      backtrackIndex = (index + 5) % 8;
      current = candidate;
      moved = true;
      break;
    }
    if (!moved) break;
    if (current[0] === start[0] && current[1] === start[1] && border.length > 2) break;
  }
  return border;
}

/**
 * Fill every enclosed hole in a mask, by flooding the background inward from
 * the frame and keeping whatever it could not reach.
 *
 * The extractor emits an OUTER border only, so a hole would be traced around
 * rather than into and the polygon would claim it anyway. Filling first makes
 * the area measurements agree with the polygon that ships.
 */
export function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const background = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) background[index] = mask[index] === 1 ? 0 : 1;
  const outside = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    const x = index % width;
    const y = (index - x) / width;
    if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
    if (background[index] !== 1 || outside[index] === 1) continue;
    component(background, width, height, index, outside);
  }
  const filled = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) filled[index] = outside[index] === 1 ? 0 : 1;
  return filled;
}

/**
 * A flat polygon's interior plus its border, as a local bitmap.
 *
 * Even-odd scanline fill, then a Bresenham walk of every edge. The walk is not
 * belt-and-braces: scanline alone drops a border wherever a side runs shallower
 * than a pixel per row, and the polygon's own vertices are border pixels of the
 * mask it was traced from, so they are part of the shape.
 *
 * Coordinates are in the caller's units (the tracer's board pixels offset from
 * a rounded placement centre); the returned `originX`/`originY` are the bitmap's
 * top-left corner in those same units, one pixel outside the polygon's bounds.
 */
export function rasteriseRing(flat: number[]): {
  mask: Uint8Array;
  width: number;
  height: number;
  originX: number;
  originY: number;
} {
  const count = flat.length / 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < count; index += 1) {
    minX = Math.min(minX, flat[index * 2]);
    maxX = Math.max(maxX, flat[index * 2]);
    minY = Math.min(minY, flat[index * 2 + 1]);
    maxY = Math.max(maxY, flat[index * 2 + 1]);
  }
  const originX = Math.floor(minX) - 1;
  const originY = Math.floor(minY) - 1;
  const width = Math.ceil(maxX) - originX + 2;
  const height = Math.ceil(maxY) - originY + 2;
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const scanY = originY + y;
    const crossings: number[] = [];
    for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
      const currentY = flat[index * 2 + 1];
      const previousY = flat[previous * 2 + 1];
      if (currentY > scanY === previousY > scanY) continue;
      const currentX = flat[index * 2];
      const previousX = flat[previous * 2];
      crossings.push(((previousX - currentX) * (scanY - currentY)) / (previousY - currentY) + currentX);
    }
    crossings.sort((first, second) => first - second);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil(crossings[pair] - originX));
      const to = Math.min(width - 1, Math.floor(crossings[pair + 1] - originX));
      for (let x = from; x <= to; x += 1) mask[y * width + x] = 1;
    }
  }

  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const fromX = flat[index * 2] - originX;
    const fromY = flat[index * 2 + 1] - originY;
    const toX = flat[next * 2] - originX;
    const toY = flat[next * 2 + 1] - originY;
    const steps = Math.max(1, Math.abs(toX - fromX), Math.abs(toY - fromY));
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(fromX + ((toX - fromX) * step) / steps);
      const y = Math.round(fromY + ((toY - fromY) * step) / steps);
      if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = 1;
    }
  }

  return { mask, width, height, originX, originY };
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
  | 'inner-perimeter-too-short';

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
 * body around the bolt -> fill its holes -> trace -> simplify.
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
  // whose plate covers the placement — the nearest interior pixel stands in,
  // resolved by squared distance and then by scan order so the choice is
  // reproducible rather than dependent on the flood's visit order.
  const centreX = Math.round(centre[0]);
  const centreY = Math.round(centre[1]);
  let anchor = -1;
  if (
    centreX >= 0 &&
    centreY >= 0 &&
    centreX < width &&
    centreY < height &&
    interior[centreY * width + centreX] === 1
  ) {
    anchor = centreY * width + centreX;
  } else {
    let bestDistance = Infinity;
    for (let index = 0; index < interior.length; index += 1) {
      if (interior[index] !== 1) continue;
      const x = index % width;
      const y = (index - x) / width;
      const distance = (x - centreX) ** 2 + (y - centreY) ** 2;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      anchor = index;
    }
  }
  if (anchor < 0) return { accepted: false, reason: 'interior-empty' };

  const body = component(interior, width, height, anchor, new Uint8Array(interior.length));
  if (body.length < interiorArea * minDominance) {
    return { accepted: false, reason: 'interior-not-dominant' };
  }

  const bodyMask = new Uint8Array(interior.length);
  for (const index of body) bodyMask[index] = 1;
  const solid = fillHoles(bodyMask, width, height);
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

  return {
    accepted: true,
    contour: simplifyRing(border, epsilon),
    silhouetteArea,
    interiorArea: solidArea,
    ringArea: silhouetteArea - solidArea,
  };
}
