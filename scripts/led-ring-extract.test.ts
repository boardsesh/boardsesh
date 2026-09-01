import { describe, expect, it } from 'vitest';
import {
  MIN_CONFIG_ACCEPTANCE,
  assembleLedInner,
  describeLedRings,
  extractConfigLedRings,
  neckTrimRadiusFor,
  qualifies,
  type LedRingConfigResult,
} from './led-ring-extract';
import { CENTRE_TOLERANCE_RADII, distanceToRing, pointInRing } from '../packages/shared/board-art-geometry/src/ring';

/**
 * The LED extractor's generator glue (PR 6).
 *
 * Sits beside the module it tests, like `outline-overrides-merge.test.ts` does,
 * and for the same reason: the pure image work is unit-tested inside the
 * package, and the parts that cannot be — the annotation precedence rule, the
 * per-config qualification, the radius-unit conversion and the two storage
 * gates — are tested here against synthetic art rather than against 15,499 real
 * holds.
 *
 * THE PRECEDENCE TEST IS THE LOAD-BEARING ONE. `overrides.test.ts` and
 * `led-inner.test.ts` both check that a committed `led_inner` annotation ships
 * verbatim, and both iterate over nothing today because no annotation exists in
 * the repo. Swapping the two loops the rule used to be written as therefore
 * passed the entire suite. The rule now lives in `assembleLedInner`, and this
 * is the test that fails when it is reversed.
 */

function emptyResult(overrides: Partial<LedRingConfigResult> = {}): LedRingConfigResult {
  return {
    rings: new Map(),
    boardPixelRings: new Map(),
    attempted: 0,
    accepted: 0,
    rejections: new Map(),
    ...overrides,
  };
}

describe('assembleLedInner', () => {
  const EXTRACTED = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
  const ANNOTATED = [-0.7, -0.7, 0.7, -0.7, 0.7, 0.7, -0.7, 0.7];

  it('lets an annotation replace the extraction for the same placement', () => {
    const assembled = assembleLedInner(new Map([[1448, EXTRACTED]]), new Map([[1448, ANNOTATED]]));
    expect(assembled.get(1448)).toEqual(ANNOTATED);
    expect(assembled.size).toBe(1);
  });

  it('keeps the extraction where no annotation covers that placement', () => {
    const assembled = assembleLedInner(
      new Map([
        [1448, EXTRACTED],
        [1449, EXTRACTED],
      ]),
      new Map([[1448, ANNOTATED]]),
    );
    expect(assembled.get(1448)).toEqual(ANNOTATED);
    expect(assembled.get(1449)).toEqual(EXTRACTED);
  });

  it('admits an annotation on a placement the extractor refused', () => {
    // The commonest real case once the editor ships: somebody draws the plate on
    // one of the holds the extractor omitted.
    const assembled = assembleLedInner(new Map(), new Map([[1448, ANNOTATED]]));
    expect(assembled.get(1448)).toEqual(ANNOTATED);
  });

  it('mutates neither input', () => {
    const extracted = new Map([[1448, EXTRACTED]]);
    const annotations = new Map([[1448, ANNOTATED]]);
    assembleLedInner(extracted, annotations);
    expect(extracted.get(1448)).toEqual(EXTRACTED);
    expect(annotations.get(1448)).toEqual(ANNOTATED);
  });
});

describe('qualifies', () => {
  it('refuses a config with nothing to measure', () => {
    // 0/0 is not 100%: "no holds failed" is not evidence that the art carries a
    // base plate, and a config the tracer found no outlines on would otherwise
    // qualify on an empty table.
    expect(qualifies(emptyResult())).toBe(false);
  });

  it('takes a rate exactly on the threshold and refuses one under it', () => {
    expect(qualifies(emptyResult({ attempted: 100, accepted: 60 }))).toBe(true);
    expect(qualifies(emptyResult({ attempted: 100, accepted: 59 }))).toBe(false);
    expect(MIN_CONFIG_ACCEPTANCE).toBe(0.6);
  });

  it('separates the two clusters the catalogue actually has, with room to spare', () => {
    // The measured extremes: Kilter Homewall's worst config against the best
    // config anywhere else. Nothing in the catalogue sits between them.
    expect(qualifies(emptyResult({ attempted: 261, accepted: 191 }))).toBe(true); // kilter/8-26, 73.2%
    expect(qualifies(emptyResult({ attempted: 282, accepted: 63 }))).toBe(false); // tension/9-3, 22.3%
  });
});

describe('neckTrimRadiusFor', () => {
  it('floors at 2, where a disc stops being one', () => {
    expect(neckTrimRadiusFor(1)).toBe(2);
    expect(neckTrimRadiusFor(20)).toBe(2);
  });

  it('reproduces the radii the tracer trims the catalogue at', () => {
    // Kilter Homewall's 12x12 placement radius trims at 3, both MoonBoards at 2
    // — the two boards the coefficient was calibrated on.
    expect(neckTrimRadiusFor(38.4)).toBe(3);
    expect(neckTrimRadiusFor(31.8)).toBe(2);
  });
});

describe('describeLedRings', () => {
  it('reads as a rate with its reasons, and survives an empty config', () => {
    expect(describeLedRings(emptyResult())).toBe('0/0 LED rings (0.0%)');
    expect(
      describeLedRings(
        emptyResult({
          attempted: 10,
          accepted: 8,
          rejections: new Map([
            ['no-warm-pixels', 1],
            ['interior-empty', 1],
          ]),
        }),
      ),
    ).toBe('8/10 LED rings (80.0%) — 1 interior-empty, 1 no-warm-pixels');
  });
});

// ---------------------------------------------------------------------------
// The conversion and the storage gates, against synthetic art
// ---------------------------------------------------------------------------

const BOARD = 200;
/** Neutral silver-grey hold body. */
const BODY: readonly [number, number, number] = [200, 200, 200];
/** Beige LED base plate. */
const PLATE: readonly [number, number, number] = [210, 190, 160];

/**
 * A board carrying one round two-tone hold at `(cx, cy)`: a neutral body inside
 * a beige plate ring, everything else transparent.
 */
function boardWithOneHold(
  cx: number,
  cy: number,
  silhouetteRadius: number,
  bodyRadius: number,
): { pixels: Uint8Array; width: number; height: number } {
  const pixels = new Uint8Array(BOARD * BOARD * 4);
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance > silhouetteRadius) continue;
      const colour = distance > bodyRadius ? PLATE : BODY;
      const index = (y * BOARD + x) * 4;
      pixels[index] = colour[0];
      pixels[index + 1] = colour[1];
      pixels[index + 2] = colour[2];
      pixels[index + 3] = 255;
    }
  }
  return { pixels, width: BOARD, height: BOARD };
}

/** A regular polygon as a flat ring in board px offset from a rounded centre. */
function circleRing(radius: number, points: number): number[] {
  const flat: number[] = [];
  for (let index = 0; index < points; index += 1) {
    const angle = (index / points) * 2 * Math.PI;
    flat.push(Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle)));
  }
  return flat;
}

describe('extractConfigLedRings', () => {
  const PLACEMENT = { id: 7, cx: 100, cy: 100, r: 25 };
  const SILHOUETTE = circleRing(20, 40);

  it('emits a ring in radius units, rounded to the shard decimals', () => {
    const art = boardWithOneHold(100, 100, 20, 14);
    const result = extractConfigLedRings(art, [PLACEMENT], new Map([[PLACEMENT.id, SILHOUETTE]]), 4);
    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(1);

    const ring = result.rings.get(PLACEMENT.id) as number[];
    // Divided through by r, so every coordinate is well under 1 for a hold 20
    // board px across on a 25 px placement, and every one is a 4-decimal value.
    for (const value of ring) {
      expect(Math.abs(value)).toBeLessThan(1);
      expect(value).toBe(Math.round(value * 1e4) / 1e4);
    }
    // No `-0`: it serialises as `-0` and would be a pointless shard diff.
    expect(ring.some((value) => Object.is(value, -0))).toBe(false);
  });

  it('round-trips the conversion back to the board pixels it came from', () => {
    // The two returned tables are the same polygon in two frames, and the
    // conversion between them is the arithmetic the silhouette emission uses.
    // Round-tripping one into the other is what proves they agree.
    const art = boardWithOneHold(100, 100, 20, 14);
    const result = extractConfigLedRings(art, [PLACEMENT], new Map([[PLACEMENT.id, SILHOUETTE]]), 4);
    const radiusUnits = result.rings.get(PLACEMENT.id) as number[];
    const boardPixels = result.boardPixelRings.get(PLACEMENT.id) as number[];
    expect(radiusUnits.length).toBe(boardPixels.length);

    const roundingX = Math.round(PLACEMENT.cx) - PLACEMENT.cx;
    const roundingY = Math.round(PLACEMENT.cy) - PLACEMENT.cy;
    for (let index = 0; index < radiusUnits.length; index += 1) {
      const rounding = index % 2 === 0 ? roundingX : roundingY;
      expect(radiusUnits[index] * PLACEMENT.r - rounding).toBeCloseTo(boardPixels[index], 3);
    }
  });

  it('runs on the placements that have a silhouette and skips the rest', () => {
    const art = boardWithOneHold(100, 100, 20, 14);
    const untraced = { id: 8, cx: 160, cy: 100, r: 25 };
    const result = extractConfigLedRings(art, [PLACEMENT, untraced], new Map([[PLACEMENT.id, SILHOUETTE]]), 4);
    // The second placement is never attempted: no outline means nothing to
    // subtract a ring from, so there is no question to ask about it.
    expect(result.attempted).toBe(1);
    expect(result.rings.has(untraced.id)).toBe(false);
  });

  it('counts a placement once when a board lists it under two sets', () => {
    const art = boardWithOneHold(100, 100, 20, 14);
    const result = extractConfigLedRings(art, [PLACEMENT, { ...PLACEMENT }], new Map([[PLACEMENT.id, SILHOUETTE]]), 4);
    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(1);
  });

  it('refuses a ring drawn around the neighbouring hold', () => {
    // The `ring-off-its-placement` gate, which fires on real data — 9 holds on
    // tension/9-1 alone — and is synthesised here so the branch has a test that
    // does not depend on a board whose art the extractor is not calibrated for.
    //
    // The silhouette is a hold two radii to the right of the placement it is
    // registered against, which is what a trace that landed on the wrong hold
    // looks like. Everything the pure extractor asks is satisfied; only the
    // radius-unit centre rule catches it.
    const offset = 50;
    const art = boardWithOneHold(100 + offset, 100, 20, 14);
    const displaced = SILHOUETTE.map((value, index) => (index % 2 === 0 ? value + offset : value));
    const result = extractConfigLedRings(art, [PLACEMENT], new Map([[PLACEMENT.id, displaced]]), 4);
    expect(result.accepted).toBe(0);
    expect(result.rejections.get('ring-off-its-placement')).toBe(1);
  });

  it('the ring it does emit passes the centre rule it rejects the other by', () => {
    const art = boardWithOneHold(100, 100, 20, 14);
    const result = extractConfigLedRings(art, [PLACEMENT], new Map([[PLACEMENT.id, SILHOUETTE]]), 4);
    const ring = result.rings.get(PLACEMENT.id) as number[];
    expect(pointInRing(ring, 0, 0) || distanceToRing(ring, 0, 0) <= CENTRE_TOLERANCE_RADII).toBe(true);
  });

  it('refuses a ring too long for the storage bound', () => {
    // `not-a-storable-ring` is the other storage gate. A placement radius of 1
    // board pixel puts every coordinate of a 20-pixel hold at 20 radii, an order
    // of magnitude past `MAX_RING_COORDINATE`, which is what a ring that is not
    // a silhouette at all looks like.
    const art = boardWithOneHold(100, 100, 20, 14);
    const tiny = { ...PLACEMENT, r: 1 };
    const result = extractConfigLedRings(art, [tiny], new Map([[tiny.id, SILHOUETTE]]), 4);
    expect(result.accepted).toBe(0);
    expect(result.rejections.get('not-a-storable-ring')).toBe(1);
  });

  it('refuses a hold whose art carries no plate at all', () => {
    // A neutral hold on a neutral ground: no warm pixels, so nothing to find.
    const flat = boardWithOneHold(100, 100, 20, 20);
    const result = extractConfigLedRings(flat, [PLACEMENT], new Map([[PLACEMENT.id, SILHOUETTE]]), 4);
    expect(result.accepted).toBe(0);
    expect(result.rejections.get('no-warm-pixels')).toBe(1);
    expect(qualifies(result)).toBe(false);
  });
});
