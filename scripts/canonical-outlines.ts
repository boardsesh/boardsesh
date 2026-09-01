/**
 * Pure geometry and measurement helpers for canonical per-layout hold tracing
 * (`scripts/generate-board-art-geometry.ts` is the only production caller).
 *
 * A layout's holds are physically the same on every board size; only the art
 * files differ — the same render window rescaled per size, with a small global
 * registration offset between families (measured at ~3 board px between the
 * Kilter Homewall 10x10 and 10x12 renders). So a hold is traced ONCE on the
 * layout's best-resolution art and the resulting radius-unit ring is projected
 * into every size's shard, shifted by that size's measured registration offset.
 *
 * Everything in this file is pure — no sharp, no file paths, no board catalogue
 * — so the offset measurement and the agreement metric are unit-testable
 * against synthetic art (`canonical-outlines.test.ts`), the same split
 * `segmentation/led-ring.ts` uses.
 */

/** One decoded image's alpha channel, board-sized. */
export type AlphaPlane = { data: Uint8Array; width: number; height: number };

/**
 * How far a target image's art sits from where a canonical image's art lands
 * when rescaled onto it, in target pixels. `iqr*` is the inter-quartile spread
 * of the per-sample measurements: near zero for a rigid shift, large when the
 * two renders genuinely disagree beyond a translation.
 */
export type PairRegistration = { dx: number; dy: number; iqrX: number; iqrY: number; samples: number };

/** One correlation sample: the same placement's centre in both frames. */
export type RegistrationSample = {
  targetX: number;
  targetY: number;
  canonicalX: number;
  canonicalY: number;
  /** The placement radius in TARGET pixels — sets the correlation window. */
  radiusPx: number;
};

/** Integer offsets swept when aligning a canonical window onto the target. */
export const REGISTRATION_SEARCH_PX = 5;
/** Window half-width as a fraction of the placement radius. */
export const REGISTRATION_WINDOW_RADII = 1.2;
/** Stride the window is sampled at — every second pixel is plenty for a peak. */
const REGISTRATION_SAMPLE_STRIDE = 2;
/** Fewest usable samples before a pair's registration counts as measured. */
export const MIN_REGISTRATION_SAMPLES = 8;

function bilinear(plane: AlphaPlane, x: number, y: number): number {
  const clampedX = Math.min(Math.max(x, 0), plane.width - 1);
  const clampedY = Math.min(Math.max(y, 0), plane.height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, plane.width - 1);
  const y1 = Math.min(y0 + 1, plane.height - 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;
  const top = plane.data[y0 * plane.width + x0] * (1 - fx) + plane.data[y0 * plane.width + x1] * fx;
  const bottom = plane.data[y1 * plane.width + x0] * (1 - fx) + plane.data[y1 * plane.width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Mean |Δalpha| between the target window around one sample and the canonical
 * window rescaled onto it, displaced by (dx, dy) target px. Lower is better.
 */
function windowMisfit(
  target: AlphaPlane,
  canonical: AlphaPlane,
  sample: RegistrationSample,
  canonicalPerTargetPx: number,
  dx: number,
  dy: number,
): number {
  const half = Math.round(sample.radiusPx * REGISTRATION_WINDOW_RADII);
  let total = 0;
  let count = 0;
  for (let stepY = -half; stepY <= half; stepY += REGISTRATION_SAMPLE_STRIDE) {
    for (let stepX = -half; stepX <= half; stepX += REGISTRATION_SAMPLE_STRIDE) {
      const targetValue = bilinear(target, sample.targetX + stepX + dx, sample.targetY + stepY + dy);
      const canonicalValue = bilinear(
        canonical,
        sample.canonicalX + stepX * canonicalPerTargetPx,
        sample.canonicalY + stepY * canonicalPerTargetPx,
      );
      total += Math.abs(targetValue - canonicalValue);
      count += 1;
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count;
}

/** Sub-pixel refinement of a discrete minimum by a parabola through its neighbours. */
function parabolicMinimum(before: number, at: number, after: number): number {
  const denominator = before - 2 * at + after;
  if (denominator <= 0) return 0;
  const correction = (0.5 * (before - after)) / denominator;
  return Math.max(-1, Math.min(1, correction));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function interquartileRange(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const quartile = (fraction: number): number => {
    const position = fraction * (sorted.length - 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  return quartile(0.75) - quartile(0.25);
}

/**
 * The registration offset between one canonical image and one target image:
 * per sample, sweep integer displacements ±`REGISTRATION_SEARCH_PX`, refine the
 * best sub-pixel with a parabola, then take the component-wise median over
 * samples so a window sitting on a genuinely re-rendered hold cannot drag the
 * global answer.
 *
 * Returns `null` when fewer than `MIN_REGISTRATION_SAMPLES` windows fit inside
 * both images — the caller then treats the pair as unregistered and keeps the
 * direct per-config trace.
 */
export function measurePairRegistration(
  target: AlphaPlane,
  canonical: AlphaPlane,
  samples: RegistrationSample[],
  canonicalPerTargetPx: number,
): PairRegistration | null {
  const offsetsX: number[] = [];
  const offsetsY: number[] = [];
  for (const sample of samples) {
    const half = Math.round(sample.radiusPx * REGISTRATION_WINDOW_RADII);
    const margin = half + REGISTRATION_SEARCH_PX + 1;
    if (
      sample.targetX - margin < 0 ||
      sample.targetY - margin < 0 ||
      sample.targetX + margin >= target.width ||
      sample.targetY + margin >= target.height
    ) {
      continue;
    }
    const canonicalHalf = half * canonicalPerTargetPx + 1;
    if (
      sample.canonicalX - canonicalHalf < 0 ||
      sample.canonicalY - canonicalHalf < 0 ||
      sample.canonicalX + canonicalHalf >= canonical.width ||
      sample.canonicalY + canonicalHalf >= canonical.height
    ) {
      continue;
    }

    let bestDx = 0;
    let bestDy = 0;
    let bestMisfit = Number.POSITIVE_INFINITY;
    let worstMisfit = 0;
    for (let dy = -REGISTRATION_SEARCH_PX; dy <= REGISTRATION_SEARCH_PX; dy += 1) {
      for (let dx = -REGISTRATION_SEARCH_PX; dx <= REGISTRATION_SEARCH_PX; dx += 1) {
        const misfit = windowMisfit(target, canonical, sample, canonicalPerTargetPx, dx, dy);
        if (misfit < bestMisfit) {
          bestMisfit = misfit;
          bestDx = dx;
          bestDy = dy;
        }
        if (misfit > worstMisfit) worstMisfit = misfit;
      }
    }
    // A window of bare transparent background matches everywhere equally and
    // measures nothing — detected by a FLAT misfit surface, not a zero minimum
    // (a perfect match at the right offset is a zero minimum with a sharp
    // surface, and is the best sample there is).
    if (!Number.isFinite(bestMisfit) || worstMisfit - bestMisfit === 0) continue;

    const refineAxis = (axis: 'x' | 'y', best: number): number => {
      if (Math.abs(best) >= REGISTRATION_SEARCH_PX) return best;
      const at = (delta: number): number =>
        axis === 'x'
          ? windowMisfit(target, canonical, sample, canonicalPerTargetPx, best + delta, bestDy)
          : windowMisfit(target, canonical, sample, canonicalPerTargetPx, bestDx, best + delta);
      return best + parabolicMinimum(at(-1), at(0), at(1));
    };
    offsetsX.push(refineAxis('x', bestDx));
    offsetsY.push(refineAxis('y', bestDy));
  }

  if (offsetsX.length < MIN_REGISTRATION_SAMPLES) return null;
  return {
    dx: median(offsetsX),
    dy: median(offsetsY),
    iqrX: interquartileRange(offsetsX),
    iqrY: interquartileRange(offsetsY),
    samples: offsetsX.length,
  };
}

/**
 * The measured offset is a shift of the ART relative to the placement grid, so
 * projecting a canonical radius-unit ring into a target config's frame is one
 * addition per axis. The result is UNROUNDED — the generator's emission rounds
 * once, to the shard's 4 decimals, exactly as it does for a direct trace.
 */
export function projectRingUnits(ringUnits: number[], offset: { dx: number; dy: number }, radiusPx: number): number[] {
  const offsetX = offset.dx / radiusPx;
  const offsetY = offset.dy / radiusPx;
  const projected: number[] = [];
  for (let index = 0; index < ringUnits.length; index += 2) {
    projected.push(ringUnits[index] + offsetX, ringUnits[index + 1] + offsetY);
  }
  return projected;
}

/**
 * Even-odd scanline rasterisation of one implicitly-closed flat ring into the
 * given integer grid box. Pixels are filled at their centres. Shared by the
 * agreement metric below and its tests; the rings this sees are already simple
 * (the tracer refuses self-intersecting ones), where even-odd and non-zero
 * agree.
 */
export function rasterizeRing(
  flat: number[],
  box: { left: number; top: number; width: number; height: number },
): Uint8Array {
  const filled = new Uint8Array(box.width * box.height);
  const vertexCount = flat.length / 2;
  for (let row = 0; row < box.height; row += 1) {
    const scanY = box.top + row + 0.5;
    const crossings: number[] = [];
    for (let index = 0; index < vertexCount; index += 1) {
      const startX = flat[index * 2];
      const startY = flat[index * 2 + 1];
      const nextIndex = (index + 1) % vertexCount;
      const endX = flat[nextIndex * 2];
      const endY = flat[nextIndex * 2 + 1];
      if (startY <= scanY === endY <= scanY) continue;
      crossings.push(startX + ((scanY - startY) * (endX - startX)) / (endY - startY));
    }
    crossings.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil(crossings[pair] - box.left - 0.5));
      const to = Math.min(box.width - 1, Math.floor(crossings[pair + 1] - box.left - 0.5));
      for (let column = from; column <= to; column += 1) filled[row * box.width + column] = 1;
    }
  }
  return filled;
}

/**
 * Intersection-over-union of two flat rings expressed in the SAME frame. This
 * is the agreement gate between a projected canonical ring and the config's own
 * direct trace: high means the two renders draw the same hold and the canonical
 * ring can ship everywhere; low means the art genuinely differs (or a neighbour
 * present on only one layer moved a pullback) and the direct trace stays.
 */
export function ringAgreement(flatA: number[], flatB: number[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const flat of [flatA, flatB]) {
    for (let index = 0; index < flat.length; index += 2) {
      minX = Math.min(minX, flat[index]);
      maxX = Math.max(maxX, flat[index]);
      minY = Math.min(minY, flat[index + 1]);
      maxY = Math.max(maxY, flat[index + 1]);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 0;
  const box = {
    left: Math.floor(minX) - 1,
    top: Math.floor(minY) - 1,
    width: Math.ceil(maxX) - Math.floor(minX) + 3,
    height: Math.ceil(maxY) - Math.floor(minY) + 3,
  };
  const filledA = rasterizeRing(flatA, box);
  const filledB = rasterizeRing(flatB, box);
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < filledA.length; index += 1) {
    if (filledA[index] === 1 && filledB[index] === 1) intersection += 1;
    if (filledA[index] === 1 || filledB[index] === 1) union += 1;
  }
  return union === 0 ? 0 : intersection / union;
}
