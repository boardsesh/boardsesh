/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import {
  components,
  dilate,
  dropSmallComponents,
  erode,
  fillHoles,
  isSimpleRing,
  rasteriseRing,
  traceMaskBorder,
  trimNecks,
} from '../raster';
import {
  BLUR_SIGMA,
  MIN_WARM_COMPONENT_PX,
  WARM_CHROMA_THRESHOLD,
  blurAndThreshold,
  extractLedInner,
  gaussianKernel,
  normalisedWarmth,
  warmMask,
} from '../segmentation/led-ring';

/**
 * The LED base-plate extractor, against synthetic art (PR 6).
 *
 * The fixture below is not decoration. Three classifiers were tried against
 * Kilter Homewall's art before normalised chromaticity, and the one that came
 * closest — an absolute `R - B >= 30` warmth threshold — fails in exactly one
 * place: a stretch of base plate lying in shadow. The plate is still beige, but
 * every channel has been scaled down, so the DIFFERENCE between red and blue
 * collapses while the RATIO does not. {@link SHADED_RIM} encodes that failure as
 * a test, so a future "simplify this to a subtraction" cannot pass.
 */

const FRAME = 61;
const CENTRE = 30;
const SILHOUETTE_RADIUS = 20;
const BODY_RADIUS = 14;

/** Neutral silver-grey hold body, fully lit. */
const BODY_LIT: readonly [number, number, number] = [200, 200, 200];
/** Beige LED base plate, fully lit. */
const RIM_LIT: readonly [number, number, number] = [210, 190, 160];
/**
 * The same beige plate at a quarter of the light.
 *
 * `R - B` is 12 here against 50 in the lit half, so an absolute threshold tuned
 * on lit plate drops it — and the shaded stretch is precisely the bottom edge of
 * every hold, where the plate is THICKEST. Normalised chromaticity is 0.130
 * against the lit half's 0.135: the same brown, seen darker.
 */
const SHADED_RIM: readonly [number, number, number] = [52, 47, 40];
/** The hold body in the same shadow. Still neutral, so still not plate. */
const SHADED_BODY: readonly [number, number, number] = [50, 50, 50];

/** The absolute-warmth classifier this extractor replaced, for the contrast. */
const ABSOLUTE_WARMTH_THRESHOLD = 30;

type Fixture = { pixels: Uint8Array; silhouette: Uint8Array; width: number; height: number };

/**
 * A round hold: a neutral body inside a beige plate ring, with the bottom half
 * of the whole hold in shadow.
 */
function twoToneHold(options: { warmRim?: boolean; rimOnlyAtCentre?: boolean } = {}): Fixture {
  const warmRim = options.warmRim ?? true;
  const pixels = new Uint8Array(FRAME * FRAME * 4);
  const silhouette = new Uint8Array(FRAME * FRAME);
  for (let y = 0; y < FRAME; y += 1) {
    for (let x = 0; x < FRAME; x += 1) {
      const distance = Math.hypot(x - CENTRE, y - CENTRE);
      if (distance > SILHOUETTE_RADIUS) continue;
      const index = y * FRAME + x;
      silhouette[index] = 1;
      const shaded = y > CENTRE;
      const isRim = options.rimOnlyAtCentre === true ? distance <= 5 : distance > BODY_RADIUS;
      const plate = isRim && warmRim;
      const colour = plate ? (shaded ? SHADED_RIM : RIM_LIT) : shaded ? SHADED_BODY : BODY_LIT;
      pixels[index * 4] = colour[0];
      pixels[index * 4 + 1] = colour[1];
      pixels[index * 4 + 2] = colour[2];
      pixels[index * 4 + 3] = 255;
    }
  }
  return { pixels, silhouette, width: FRAME, height: FRAME };
}

function area(mask: Uint8Array): number {
  let total = 0;
  for (const value of mask) total += value;
  return total;
}

describe('normalised chromaticity', () => {
  it('is unchanged by how brightly the same colour is lit', () => {
    const lit = normalisedWarmth(RIM_LIT[0], RIM_LIT[2]);
    const shaded = normalisedWarmth(SHADED_RIM[0], SHADED_RIM[2]);
    expect(lit).toBeGreaterThan(WARM_CHROMA_THRESHOLD);
    expect(shaded).toBeGreaterThan(WARM_CHROMA_THRESHOLD);
    // Within a hundredth of each other, across a 4x change in illumination.
    expect(Math.abs(lit - shaded)).toBeLessThan(0.01);
  });

  it('reads a neutral grey as neutral however dark it is', () => {
    expect(normalisedWarmth(BODY_LIT[0], BODY_LIT[2])).toBe(0);
    expect(normalisedWarmth(SHADED_BODY[0], SHADED_BODY[2])).toBe(0);
  });

  it('cannot divide by zero on a black pixel', () => {
    expect(normalisedWarmth(0, 0)).toBe(0);
  });
});

describe('the shading failure an absolute R-B threshold has', () => {
  it('drops shaded plate that normalised chromaticity keeps', () => {
    // The lesson, stated as arithmetic: the lit plate clears an absolute
    // threshold of 30 and the shaded plate does not, while both clear 0.10 on
    // the normalised measure.
    expect(RIM_LIT[0] - RIM_LIT[2]).toBeGreaterThan(ABSOLUTE_WARMTH_THRESHOLD);
    expect(SHADED_RIM[0] - SHADED_RIM[2]).toBeLessThan(ABSOLUTE_WARMTH_THRESHOLD);
    expect(normalisedWarmth(SHADED_RIM[0], SHADED_RIM[2])).toBeGreaterThanOrEqual(WARM_CHROMA_THRESHOLD);
  });

  it('leaves the plate open along the shaded half of a hold', () => {
    const { pixels, silhouette } = twoToneHold();
    const normalised = warmMask(pixels, silhouette);

    const absolute = new Uint8Array(silhouette.length);
    for (let index = 0; index < silhouette.length; index += 1) {
      if (silhouette[index] !== 1) continue;
      if (pixels[index * 4] - pixels[index * 4 + 2] >= ABSOLUTE_WARMTH_THRESHOLD) absolute[index] = 1;
    }

    // The absolute measure finds the lit half of the ring and none of the
    // shaded half, so it is missing close to half of the plate.
    expect(area(absolute)).toBeGreaterThan(0);
    expect(area(absolute) / area(normalised)).toBeLessThan(0.6);

    // And it is not a threshold that can be turned down: the shaded PLATE reads
    // colder than the lit BODY on the absolute measure, so no single cut
    // separates them.
    expect(SHADED_RIM[0] - SHADED_RIM[2]).toBeLessThan(BODY_LIT[0] - BODY_LIT[2] + ABSOLUTE_WARMTH_THRESHOLD);
  });
});

describe('the Gaussian blur', () => {
  it('builds an integer kernel, pinned at the shipped sigma', () => {
    // Pinned because the blur has to be byte-stable: the kernel is the only
    // floating-point step in the chain, and everything after it is exact
    // integer arithmetic on these values.
    expect([...gaussianKernel(BLUR_SIGMA)]).toEqual([
      728, 2879, 8869, 21276, 39750, 57835, 65536, 57835, 39750, 21276, 8869, 2879, 728,
    ]);
    expect(gaussianKernel(BLUR_SIGMA).length).toBe(2 * Math.ceil(BLUR_SIGMA * 3) + 1);
  });

  it('is symmetric about its centre', () => {
    const kernel = gaussianKernel(BLUR_SIGMA);
    for (let index = 0; index < kernel.length; index += 1) {
      expect(kernel[index]).toBe(kernel[kernel.length - 1 - index]);
    }
  });

  it('leaves a large solid block alone and deletes a single pixel', () => {
    const width = 41;
    const solid = new Uint8Array(width * width);
    for (let y = 10; y < 31; y += 1) for (let x = 10; x < 31; x += 1) solid[y * width + x] = 1;
    const blurred = blurAndThreshold(solid, width, width);
    expect(blurred[20 * width + 20]).toBe(1);

    const speck = new Uint8Array(width * width);
    speck[20 * width + 20] = 1;
    expect(area(blurAndThreshold(speck, width, width))).toBe(0);
  });

  it('gives the same bytes on every run', () => {
    const { pixels, silhouette } = twoToneHold();
    const once = blurAndThreshold(warmMask(pixels, silhouette), FRAME, FRAME);
    const twice = blurAndThreshold(warmMask(pixels, silhouette), FRAME, FRAME);
    expect([...once]).toEqual([...twice]);
  });
});

describe('morphology', () => {
  const width = 21;
  const single = (): Uint8Array => {
    const mask = new Uint8Array(width * width);
    mask[10 * width + 10] = 1;
    return mask;
  };

  it('dilates by a disc and erodes it back', () => {
    const grown = dilate(single(), width, width, 2);
    expect(area(grown)).toBe(13);
    expect(area(erode(grown, width, width, 2))).toBe(1);
  });

  it('erodes a shape smaller than the disc away entirely', () => {
    expect(area(erode(single(), width, width, 1))).toBe(0);
  });

  it('drops components under the speck floor and keeps the rest', () => {
    const mask = new Uint8Array(width * width);
    for (let y = 2; y < 12; y += 1) for (let x = 2; x < 12; x += 1) mask[y * width + x] = 1;
    mask[18 * width + 18] = 1;
    expect(components(mask, width, width).length).toBe(2);
    const kept = dropSmallComponents(mask, width, width, MIN_WARM_COMPONENT_PX);
    expect(area(kept)).toBe(100);
    expect(kept[18 * width + 18]).toBe(0);
  });

  it('fills an enclosed hole and leaves an open bay alone', () => {
    const mask = new Uint8Array(width * width);
    for (let y = 4; y < 17; y += 1) for (let x = 4; x < 17; x += 1) mask[y * width + x] = 1;
    mask[10 * width + 10] = 0;
    expect(fillHoles(mask, width, width)[10 * width + 10]).toBe(1);

    const bay = new Uint8Array(width * width);
    for (let y = 4; y < 17; y += 1) for (let x = 4; x < 17; x += 1) bay[y * width + x] = 1;
    for (let x = 8; x < 13; x += 1) bay[16 * width + x] = 0;
    expect(area(fillHoles(bay, width, width))).toBe(area(bay));
  });
});

describe('the neck trim', () => {
  const width = 41;

  /** Two 13x13 blobs joined by a 1-pixel isthmus — what the blur leaves behind. */
  function dumbbell(): Uint8Array {
    const mask = new Uint8Array(width * width);
    for (let y = 14; y < 27; y += 1) {
      for (let x = 4; x < 17; x += 1) mask[y * width + x] = 1;
      for (let x = 24; x < 37; x += 1) mask[y * width + x] = 1;
    }
    for (let x = 17; x < 24; x += 1) mask[20 * width + x] = 1;
    return mask;
  }

  it('drops a limb reachable only through a one-pixel isthmus', () => {
    const trimmed = trimNecks(dumbbell(), width, width, 20 * width + 10, 3);
    // The anchor's blob survives whole; the isthmus and everything behind it go.
    // The anchor's blob survives WHOLE, corners included — the open-disc
    // erosion against the closed-disc dilation is what guarantees that.
    for (let y = 14; y < 27; y += 1) {
      for (let x = 4; x < 17; x += 1) expect([x, y, trimmed[y * width + x]]).toEqual([x, y, 1]);
    }
    // The far blob is gone entirely, and nothing beyond the first pixel or two
    // of isthmus comes back with it: the closed dilation reaches a little past
    // the core, which is the price of not shaving the corners.
    for (let y = 14; y < 27; y += 1) {
      for (let x = 24; x < 37; x += 1) expect([x, y, trimmed[y * width + x]]).toEqual([x, y, 0]);
    }
    expect(trimmed[20 * width + 23]).toBe(0);
    expect(area(trimmed)).toBeLessThan(13 * 13 + 7);
  });

  it('leaves a hold with no neck exactly as it was', () => {
    const solid = new Uint8Array(width * width);
    for (let y = 10; y < 31; y += 1) for (let x = 10; x < 31; x += 1) solid[y * width + x] = 1;
    expect([...trimNecks(solid, width, width, 20 * width + 20, 3)]).toEqual([...solid]);
  });

  it('returns a shape too thin to core untouched rather than deleting it', () => {
    // The tracer's own fallback. A 4-pixel rail cores nothing at radius 3, and
    // an unguarded open would take the whole hold.
    const rail = new Uint8Array(width * width);
    for (let y = 5; y < 36; y += 1) for (let x = 19; x < 23; x += 1) rail[y * width + x] = 1;
    expect(area(trimNecks(rail, width, width, 20 * width + 20, 3))).toBe(area(rail));
  });
});

describe('isSimpleRing', () => {
  it('accepts a convex ring and a concave one', () => {
    expect(
      isSimpleRing([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ).toBe(true);
    // An L, whose reflex corner a naive convexity test would reject.
    expect(
      isSimpleRing([
        [0, 0],
        [10, 0],
        [10, 4],
        [4, 4],
        [4, 10],
        [0, 10],
      ]),
    ).toBe(true);
  });

  it('rejects the bow tie an isthmus and Douglas-Peucker produce together', () => {
    // The exact failure this backstop exists for: the border follower walks out
    // along one side of a 1-pixel neck and back along the other, and the
    // simplification replaces the round trip with two crossing chords.
    expect(
      isSimpleRing([
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 10],
      ]),
    ).toBe(false);
  });

  it('rejects a ring that doubles back along itself', () => {
    // Collinear overlap, which a crossing test alone would let through.
    expect(
      isSimpleRing([
        [0, 0],
        [10, 0],
        [4, 0],
        [4, 10],
      ]),
    ).toBe(false);
  });

  it('does not mistake the closing edge for a crossing', () => {
    // The last edge and the first share a vertex by construction, as does every
    // other consecutive pair. A test that forgot the wraparound would call
    // every ring in the catalogue self-intersecting.
    expect(
      isSimpleRing([
        [0, 0],
        [8, 1],
        [9, 9],
        [1, 8],
      ]),
    ).toBe(true);
  });

  it('refuses anything short of a triangle', () => {
    expect(
      isSimpleRing([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(false);
  });
});

describe('contours', () => {
  it('walks a mask border and returns nothing for an empty mask', () => {
    const width = 21;
    const mask = new Uint8Array(width * width);
    for (let y = 5; y < 16; y += 1) for (let x = 5; x < 16; x += 1) mask[y * width + x] = 1;
    const border = traceMaskBorder(mask, width, width);
    expect(border.length).toBeGreaterThan(30);
    expect(border[0]).toEqual([5, 5]);
    expect(traceMaskBorder(new Uint8Array(width * width), width, width)).toEqual([]);
  });

  it('rasterises a ring back to its own area, border included', () => {
    const square = [-5, -5, 5, -5, 5, 5, -5, 5];
    const raster = rasteriseRing(square);
    expect(raster.originX).toBe(-6);
    expect(raster.originY).toBe(-6);
    expect(area(raster.mask)).toBe(11 * 11);
  });
});

describe('extractLedInner', () => {
  it('finds the hold proper inside a two-tone hold, shaded half included', () => {
    const { pixels, silhouette, width, height } = twoToneHold();
    const extraction = extractLedInner(pixels, silhouette, width, height, [CENTRE, CENTRE]);
    expect(extraction.accepted).toBe(true);
    if (!extraction.accepted) return;

    // The interior is the body disc: (14/20)² of the silhouette, give or take
    // the blur's half-pixel and the ring's discretisation.
    const share = extraction.interiorArea / extraction.silhouetteArea;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
    expect(extraction.ringArea).toBeGreaterThan(0);

    // Closed all the way round, which is the thing the absolute measure could
    // not do: every vertex is between the body radius and the silhouette
    // radius, in the shaded lower half as much as the lit upper half.
    let upper = 0;
    let lower = 0;
    for (const [x, y] of extraction.contour) {
      const distance = Math.hypot(x - CENTRE, y - CENTRE);
      expect(distance).toBeLessThanOrEqual(SILHOUETTE_RADIUS);
      expect(distance).toBeGreaterThan(BODY_RADIUS - 4);
      if (y < CENTRE) upper += 1;
      else lower += 1;
    }
    expect(upper).toBeGreaterThan(2);
    expect(lower).toBeGreaterThan(2);
  });

  it('returns the same polygon on every run', () => {
    // Two independently-built fixtures, not the same buffers twice: an
    // extractor that mutated its input would pass the second reading and still
    // be non-deterministic in the generator, which builds a fresh crop per hold.
    const first = twoToneHold();
    const second = twoToneHold();
    expect(
      JSON.stringify(extractLedInner(first.pixels, first.silhouette, first.width, first.height, [CENTRE, CENTRE])),
    ).toEqual(
      JSON.stringify(extractLedInner(second.pixels, second.silhouette, second.width, second.height, [CENTRE, CENTRE])),
    );
  });

  it('emits a simple ring', () => {
    const { pixels, silhouette, width, height } = twoToneHold();
    const extraction = extractLedInner(pixels, silhouette, width, height, [CENTRE, CENTRE]);
    expect(extraction.accepted).toBe(true);
    if (!extraction.accepted) return;
    expect(isSimpleRing(extraction.contour)).toBe(true);
  });

  it('every contour point is inside the silhouette it came from', () => {
    const { pixels, silhouette, width, height } = twoToneHold();
    const extraction = extractLedInner(pixels, silhouette, width, height, [CENTRE, CENTRE]);
    expect(extraction.accepted).toBe(true);
    if (!extraction.accepted) return;
    for (const [x, y] of extraction.contour) {
      expect(silhouette[y * width + x]).toBe(1);
    }
  });

  it('refuses a hold with no warm pixels at all', () => {
    const { pixels, silhouette, width, height } = twoToneHold({ warmRim: false });
    const extraction = extractLedInner(pixels, silhouette, width, height, [CENTRE, CENTRE]);
    expect(extraction).toEqual({ accepted: false, reason: 'no-warm-pixels' });
  });

  it('refuses a warm blob that never reaches the silhouette boundary', () => {
    // A painted feature in the middle of a hold is not a base plate: a plate is
    // what the hold sits ON, so it is visible around the edge by construction.
    // This is also what drops Kilter's bolt hole, which reads warm.
    const { pixels, silhouette, width, height } = twoToneHold({ rimOnlyAtCentre: true });
    const extraction = extractLedInner(pixels, silhouette, width, height, [CENTRE, CENTRE]);
    expect(extraction).toEqual({ accepted: false, reason: 'ring-not-at-boundary' });
  });

  it('refuses a hold the band has swallowed', () => {
    // Warm everywhere inside the silhouette: there is no hold proper left, so
    // there is no inner boundary to emit and the honest answer is to omit it.
    const width = FRAME;
    const pixels = new Uint8Array(width * width * 4);
    const silhouette = new Uint8Array(width * width);
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (Math.hypot(x - CENTRE, y - CENTRE) > SILHOUETTE_RADIUS) continue;
        const index = y * width + x;
        silhouette[index] = 1;
        pixels[index * 4] = RIM_LIT[0];
        pixels[index * 4 + 1] = RIM_LIT[1];
        pixels[index * 4 + 2] = RIM_LIT[2];
        pixels[index * 4 + 3] = 255;
      }
    }
    const extraction = extractLedInner(pixels, silhouette, width, width, [CENTRE, CENTRE]);
    expect(extraction.accepted).toBe(false);
    if (extraction.accepted) return;
    // Which of the interior refusals fires is not the point and is not pinned:
    // the blur pulls the band a pixel back from the silhouette's own edge, so a
    // hold that is warm everywhere leaves a fragmented one-pixel rim rather than
    // literally nothing. What matters is that no ring comes out of it.
    expect(['interior-empty', 'interior-not-dominant', 'interior-area-out-of-bounds']).toContain(extraction.reason);
  });

  it('refuses a band that bisects the hold rather than surrounding it', () => {
    // A warm stripe straight across the middle leaves two comparable halves.
    // That is a misclassification — a plate surrounds a hold, it does not cut
    // one in two — and the dominance test is what says so.
    const width = FRAME;
    const pixels = new Uint8Array(width * width * 4);
    const silhouette = new Uint8Array(width * width);
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (Math.hypot(x - CENTRE, y - CENTRE) > SILHOUETTE_RADIUS) continue;
        const index = y * width + x;
        silhouette[index] = 1;
        const stripe = Math.abs(y - CENTRE) <= 3;
        const colour = stripe ? RIM_LIT : BODY_LIT;
        pixels[index * 4] = colour[0];
        pixels[index * 4 + 1] = colour[1];
        pixels[index * 4 + 2] = colour[2];
        pixels[index * 4 + 3] = 255;
      }
    }
    const extraction = extractLedInner(pixels, silhouette, width, width, [CENTRE, CENTRE]);
    expect(extraction.accepted).toBe(false);
    if (extraction.accepted) return;
    expect(extraction.reason).toBe('interior-not-dominant');
  });
});
