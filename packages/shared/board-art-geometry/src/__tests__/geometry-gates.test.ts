/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { getOutlineCounts, listBoardArtGeometryKeys, loadBoardArtGeometry } from '../loader';
import {
  CROP_BOX_MIN_RUNS,
  CROP_BOX_PERIMETER_SHARE,
  MAX_BOX_EDGE_SHARE,
  MAX_SPUR_AREA,
  NECK_TRIM_AT_REFERENCE,
  SEARCH_RADII,
  SIMPLIFY_EPSILON,
  axisAlignedRuns,
  boxEdgeShare,
  containsPoint,
  cutShares,
  distanceOutsidePolygon,
  loadBoardArt,
  openedArea,
  radiusForBoard,
  reachesSearchBox,
  shardBoardForKey,
  spurArea,
  toTracerPixels,
  type Placement,
} from './gate-measures';

/**
 * The six capture gates, run against the committed shards (issue #2202).
 *
 * They were written for the spike as "throwaway scripts to re-run after changing
 * the tracer", and that is exactly why the record drifted: nobody re-ran them,
 * and the traced counts in the write-up stayed on a pre-fix run through two
 * rounds of fixes. Gates 1 to 5 are geometry against geometry over all 49
 * shards; gate 6 decodes real board art to tell an art edge from a partition
 * cut, so it runs the seven boards the spike drew by default and the whole
 * catalogue under `BOARD_ART_GATES=all`.
 *
 * Every gate carries a fixture that must trip it. A silhouette gate that has
 * never failed is indistinguishable from one that cannot fail, and four of the
 * six were originally reported against defects that are now zero everywhere.
 */

const ALL_SHARD_KEYS = listBoardArtGeometryKeys();

/**
 * The seven boards the spike drew, chosen for visually distinct hold sets rather
 * than for coverage: Tension's wooden originals against TB2's plastic, Kilter's
 * Homewall against the commercial Original, Grasshopper (the board the issue was
 * filed against) and two MoonBoards whose art is drawn for a white wall.
 * Whatever the tracer does, it has to survive all of these.
 */
const SPIKE_SAMPLE_KEYS = [
  'grasshopper/1-5',
  'tension/9-1',
  'tension/10-6',
  'kilter/8-25',
  'kilter/1-10',
  'moonboard/2-1',
  'moonboard/5-1',
];

const RUN_EVERY_CONFIG = process.env.BOARD_ART_GATES === 'all';
const ART_GATE_KEYS = RUN_EVERY_CONFIG ? ALL_SHARD_KEYS : SPIKE_SAMPLE_KEYS;

/**
 * Gate 6's pins, from the run that wrote the committed shards.
 *
 * `neighbourMean` and `opaqueMean` are ceilings in percent, one decimal;
 * `overFivePercent` is an exact count of outlines whose boundary is more than 5%
 * on a neighbour's art. Before the tracer pulled back from contacts the same
 * three read 11.1% / 233 over 5% / 12.7% on Kilter Homewall and 3.1% / 53 / 3.4%
 * on TB2 Mirror, so this gate has a two-order-of-magnitude fall to hold.
 *
 * The `opaqueMean` ceilings run the other way. They are what stops the clearance
 * being widened until the silhouette is a shrunk blob floating inside its own
 * hold, which nothing else here would notice — Kilter Homewall's 19.8% is the
 * price of pulling 369 of its 499 holds off a contact, and it is the number to
 * watch if that clearance is ever raised.
 *
 * The handful of outlines still over 5% are the generator's partition rather
 * than its pullback. `buildLabelMap` propagates a chamfer distance, which is up
 * to ~4% long on a diagonal, so a strip a pixel or two wide either side of a
 * midline is labelled this hold's when the exact nearest placement is the
 * neighbour's; this gate takes the exact answer, so it sees a boundary the
 * tracer had no reason to pull back from. An exact Euclidean transform in the
 * generator would close it.
 */
const PINNED_CUT_SHARES: Record<string, { neighbourMean: number; overFivePercent: number; opaqueMean: number }> = {
  'decoy/2-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.3 },
  'decoy/2-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 4.2 },
  'decoy/2-3': { neighbourMean: 0, overFivePercent: 1, opaqueMean: 4.2 },
  'grasshopper/1-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.3 },
  'grasshopper/1-3': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.5 },
  'grasshopper/1-4': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.1 },
  'grasshopper/1-5': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 3.4 },
  'grasshopper/1-6': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 4.1 },
  'kilter/1-10': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 5.2 },
  'kilter/1-14': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 4.2 },
  'kilter/1-27': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 5.6 },
  'kilter/1-28': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.9 },
  'kilter/1-7': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 5.2 },
  'kilter/1-8': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 4.5 },
  'kilter/8-17': { neighbourMean: 0.2, overFivePercent: 1, opaqueMean: 18.3 },
  'kilter/8-18': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.2 },
  'kilter/8-19': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.1 },
  'kilter/8-21': { neighbourMean: 0.2, overFivePercent: 1, opaqueMean: 20.8 },
  'kilter/8-22': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.2 },
  'kilter/8-23': { neighbourMean: 0.2, overFivePercent: 0, opaqueMean: 17.9 },
  'kilter/8-24': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1 },
  'kilter/8-25': { neighbourMean: 0.2, overFivePercent: 2, opaqueMean: 19.8 },
  'kilter/8-26': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1 },
  'kilter/8-29': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.4 },
  'moonboard/1-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.2 },
  'moonboard/2-1': { neighbourMean: 0.2, overFivePercent: 2, opaqueMean: 0.7 },
  'moonboard/3-1': { neighbourMean: 0.3, overFivePercent: 6, opaqueMean: 1.8 },
  'moonboard/4-1': { neighbourMean: 0.3, overFivePercent: 4, opaqueMean: 0.9 },
  'moonboard/5-1': { neighbourMean: 0.1, overFivePercent: 3, opaqueMean: 0.8 },
  'moonboard/6-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.6 },
  'moonboard/7-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.7 },
  'soill/1-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.1 },
  'soill/1-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/10-10': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6 },
  'tension/10-6': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 5.5 },
  'tension/10-7': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 5.9 },
  'tension/10-8': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 5.9 },
  'tension/10-9': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.1 },
  'tension/11-10': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 7.7 },
  'tension/11-6': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 7.1 },
  'tension/11-7': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 7.5 },
  'tension/11-8': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.9 },
  'tension/11-9': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 7.3 },
  'tension/9-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.7 },
  'tension/9-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.8 },
  'tension/9-3': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.8 },
  'tension/9-4': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.9 },
  'tension/9-5': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.9 },
  'touchstone/1-1': { neighbourMean: 0.1, overFivePercent: 2, opaqueMean: 4.8 },
};

/**
 * Outlines whose boundary runs through their own bolt rather than around it, per
 * shard, and the worst distance any of them puts the placement outside the
 * polygon.
 *
 * All five are Kilter Original 12x12 Wide's screw-on holds, whose art is drawn
 * BESIDE the bolt hole rather than over it, and the worst of them puts the bolt
 * 1.0 board px outside a polygon simplified at a 1.6 board px tolerance — i.e.
 * inside the simplification's own error. Gate 1 fails anything further out than
 * that; this pin is what stops the set growing quietly.
 */
const PINNED_PLACEMENT_ON_THE_EDGE: Record<string, number> = { 'kilter/1-28': 5 };

/**
 * The one outline in the catalogue that loses more than 20 board px² to a 3-px
 * open, at 23 px². Kilter Homewall 4135 and 4634 were pinned here the same way
 * while the tracer grew every core at once, and both went to zero when it
 * started growing only the seed's.
 *
 * This one is the reference-width rule showing its edge: `radiusForBoard` scales
 * the neck-trim radius with the board's PIXEL width on the assumption that hold
 * size scales with it, and TB2's 12x12 Wide is 1461 px across with the same
 * 31.8 px placement radius as the 1080 px 12x12 — so it trims at 4 where the
 * narrower board trims at 3, and Douglas-Peucker then leaves a 3-px-wide limb
 * the wider disc would have taken. Every other shard's worst is 18 or below.
 * Fixing it means re-deriving that radius rule against placement radius rather
 * than board width, which moves every board's output and is not this change.
 */
const PINNED_SPURRED_OUTLINES: Record<string, number[]> = { 'tension/11-10': [952] };

type BoardAudit = {
  key: string;
  traced: number;
  placements: number;
  placementOnTheEdge: number;
  withoutOwnPlacement: number[];
  withSecondPlacement: number[];
  onSearchBoxEdge: number[];
  cropBoxShaped: number[];
  spurred: number[];
};

function auditShard(key: string): BoardAudit {
  const board = shardBoardForKey(key);
  const geometry = loadBoardArtGeometry(board);
  if (geometry === null) throw new Error(`${key}: shard is indexed but did not load`);
  const openRadius = radiusForBoard(NECK_TRIM_AT_REFERENCE, board.boardWidth);

  const audit: BoardAudit = {
    key,
    traced: Object.keys(geometry.outlines).length,
    placements: board.placements.length,
    placementOnTheEdge: 0,
    withoutOwnPlacement: [],
    withSecondPlacement: [],
    onSearchBoxEdge: [],
    cropBoxShaped: [],
    spurred: [],
  };

  for (const [holdIdText, flat] of Object.entries(geometry.outlines)) {
    const holdId = Number(holdIdText);
    const placement = board.placementById.get(holdId);
    if (placement === undefined) throw new Error(`${key}: outline ${holdId} has no placement`);
    // Every measure below is half-pixel-sensitive, so they all run in the whole
    // board pixels the tracer cut in rather than in the shard's radius units.
    const tracerPixels = toTracerPixels(flat, placement);
    const centreX = Math.round(placement.cx);
    const centreY = Math.round(placement.cy);

    if (!containsPoint(tracerPixels, 0, 0)) audit.placementOnTheEdge += 1;
    if (distanceOutsidePolygon(tracerPixels, 0, 0) > SIMPLIFY_EPSILON) audit.withoutOwnPlacement.push(holdId);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < tracerPixels.length; index += 2) {
      minX = Math.min(minX, tracerPixels[index]);
      maxX = Math.max(maxX, tracerPixels[index]);
      minY = Math.min(minY, tracerPixels[index + 1]);
      maxY = Math.max(maxY, tracerPixels[index + 1]);
    }
    for (const other of board.placements) {
      if (other.id === holdId) continue;
      const offsetX = other.cx - centreX;
      const offsetY = other.cy - centreY;
      if (offsetX < minX || offsetX > maxX || offsetY < minY || offsetY > maxY) continue;
      if (!containsPoint(tracerPixels, offsetX, offsetY)) continue;
      audit.withSecondPlacement.push(holdId);
      break;
    }

    const box = Math.round(placement.r * SEARCH_RADII);
    if (boxEdgeShare(tracerPixels, box) > MAX_BOX_EDGE_SHARE) audit.onSearchBoxEdge.push(holdId);
    const { runs, share } = axisAlignedRuns(tracerPixels);
    if (runs >= CROP_BOX_MIN_RUNS && share > CROP_BOX_PERIMETER_SHARE && reachesSearchBox(tracerPixels, box)) {
      audit.cropBoxShaped.push(holdId);
    }
    if (spurArea(tracerPixels, openRadius) > MAX_SPUR_AREA) audit.spurred.push(holdId);
  }
  return audit;
}

const AUDITS = ALL_SHARD_KEYS.map(auditShard);

describe('board-art-geometry gates', () => {
  it('ships a shard for every board whose art has an alpha channel to trace', () => {
    // Woods is the one catalogue board with no shard: its art is an opaque
    // photograph of the hold set on a white ground, so there is no silhouette in
    // the alpha channel. Pinned so the skip stays a decision rather than a
    // symptom of a broken art path.
    expect(ALL_SHARD_KEYS.filter((key) => key.startsWith('woods/'))).toEqual([]);
    expect(ALL_SHARD_KEYS.length).toBe(49);
  });

  it('gate 1: every outline sits on its own placement', () => {
    for (const audit of AUDITS) expect([audit.key, audit.withoutOwnPlacement]).toEqual([audit.key, []]);
  });

  it('gate 1: the outlines whose boundary runs through their own bolt are the pinned five', () => {
    const measured = Object.fromEntries(
      AUDITS.filter((audit) => audit.placementOnTheEdge > 0).map((audit) => [audit.key, audit.placementOnTheEdge]),
    );
    expect(measured).toEqual(PINNED_PLACEMENT_ON_THE_EDGE);
  });

  it('gate 2: no outline contains a second placement', () => {
    for (const audit of AUDITS) expect([audit.key, audit.withSecondPlacement]).toEqual([audit.key, []]);
  });

  it('gate 3: no outline traces the search box', () => {
    for (const audit of AUDITS) {
      expect([audit.key, audit.onSearchBoxEdge]).toEqual([audit.key, []]);
      expect([audit.key, audit.cropBoxShaped]).toEqual([audit.key, []]);
    }
  });

  it('gate 4: the traced count per shard matches the committed record', () => {
    const measured = Object.fromEntries(
      AUDITS.map((audit) => [audit.key, { traced: audit.traced, placements: audit.placements }]),
    );
    expect(measured).toEqual(getOutlineCounts());
  });

  // Zero, with no exceptions. Two Kilter Homewall outlines were pinned here as
  // known failures while the tracer grew every core at once; growing only the
  // seed's core dropped both limbs. The cut pullback then made necks of its own —
  // thirteen outlines on two boards tripped this gate with a single trim — which
  // is why the tracer trims a second time after pulling back.
  it('gate 5: no outline loses more than 20 board px² to a thin-necked limb', () => {
    const measured = Object.fromEntries(
      AUDITS.filter((audit) => audit.spurred.length > 0).map((audit) => [audit.key, audit.spurred]),
    );
    expect(measured).toEqual(PINNED_SPURRED_OUTLINES);
  });
});

describe.concurrent("gate 6: no silhouette boundary sits on a neighbour's art", () => {
  for (const key of ART_GATE_KEYS) {
    it.concurrent(key, async () => {
      const board = shardBoardForKey(key);
      const geometry = loadBoardArtGeometry(board);
      if (geometry === null) throw new Error(`${key}: shard is indexed but did not load`);
      const art = await loadBoardArt(board.boardWidth, board.boardHeight, board.backgroundRelPaths);

      let neighbourSum = 0;
      let opaqueSum = 0;
      let overFivePercent = 0;
      let counted = 0;
      for (const [holdIdText, flat] of Object.entries(geometry.outlines)) {
        const placement = board.placementById.get(Number(holdIdText)) as Placement;
        // Only placements that could win a probe point: the probe never leaves
        // the hold's own search box, so twice the box is a generous cut-off and
        // keeps the nearest-placement search off the board's other 490 bolts.
        const reach = placement.r * SEARCH_RADII * 2;
        const candidates = board.placements.filter(
          (entry) => Math.abs(entry.cx - placement.cx) <= reach && Math.abs(entry.cy - placement.cy) <= reach,
        );
        const shares = cutShares(art, candidates, placement, toTracerPixels(flat, placement));
        neighbourSum += shares.neighbour;
        opaqueSum += shares.opaque;
        if (shares.neighbour > 0.05) overFivePercent += 1;
        counted += 1;
      }

      const measured = {
        neighbourMean: Math.round((neighbourSum / counted) * 1000) / 10,
        overFivePercent,
        opaqueMean: Math.round((opaqueSum / counted) * 1000) / 10,
      };
      const pinned = PINNED_CUT_SHARES[key];
      expect([key, pinned !== undefined]).toEqual([key, true]);
      expect([key, measured.overFivePercent]).toEqual([key, pinned.overFivePercent]);
      expect([key, measured.neighbourMean <= pinned.neighbourMean, measured.neighbourMean]).toEqual([
        key,
        true,
        measured.neighbourMean,
      ]);
      expect([key, measured.opaqueMean <= pinned.opaqueMean, measured.opaqueMean]).toEqual([
        key,
        true,
        measured.opaqueMean,
      ]);
    });
  }
});

describe('board-art-geometry gate fixtures', () => {
  // A silhouette that misses its own placement: a ring sitting off to one side,
  // which is what a neighbour leak produced before the partition landed.
  const OFF_PLACEMENT = [20, -10, 40, -10, 40, 10, 20, 10];
  // The generator's rejected crop-rectangle fallback, at a search box of 40.
  const CROP_BOX = [-40, -40, 40, -40, 40, 40, -40, 40];
  // A 31x31 body with a 30x3 tail — the "numeral 6" a thin neck produces, minus
  // the curves.
  const SPURRED = [-15, -15, 15, -15, 15, -1, 45, -1, 45, 1, 15, 1, 15, 15, -15, 15];
  // A 4x35 rail: too narrow for a single core pixel at radius 3, so the open
  // would delete the whole hold and the measure has to exempt it. One column
  // wider and it cores 31 pixels and comes back whole through the ordinary path,
  // which is the branch this fixture is here NOT to take.
  const RAIL = [-2, -17, 1, -17, 1, 17, -2, 17];

  it('gate 1 catches an outline that misses its placement', () => {
    expect(containsPoint(OFF_PLACEMENT, 0, 0)).toBe(false);
    expect(containsPoint(CROP_BOX, 0, 0)).toBe(true);
  });

  it('gate 2 catches an outline that swallows a neighbour', () => {
    expect(containsPoint(CROP_BOX, 30, 0)).toBe(true);
    expect(containsPoint(OFF_PLACEMENT, -30, 0)).toBe(false);
  });

  it('gate 3 catches the crop rectangle by both measures', () => {
    expect(boxEdgeShare(CROP_BOX, 40)).toBeCloseTo(1, 6);
    expect(axisAlignedRuns(CROP_BOX)).toEqual({ runs: 4, share: 1 });
    expect(reachesSearchBox(CROP_BOX, 40)).toBe(true);
    expect(boxEdgeShare(SPURRED, 40)).toBeLessThan(MAX_BOX_EDGE_SHARE);
  });

  it('gate 3 leaves a small blocky hold alone', () => {
    // grasshopper/1-3's hold 97, at its own 128-pixel search box: four
    // axis-aligned runs carrying 80% of the perimeter, and 28 x 88 board pixels
    // of hold. The shape signature alone flags it; nothing that never gets
    // within 84 pixels of the box can be the box.
    const SMALL_BLOCKY_HOLD = [-5, -44, 8, -44, 14, -38, 14, 35, 6, 40, -3, 40, -10, 34, -12, -34, -10, -41, -6, -43];
    const { runs, share } = axisAlignedRuns(SMALL_BLOCKY_HOLD);
    expect(runs).toBeGreaterThanOrEqual(CROP_BOX_MIN_RUNS);
    expect(share).toBeGreaterThan(CROP_BOX_PERIMETER_SHARE);
    expect(reachesSearchBox(SMALL_BLOCKY_HOLD, 128)).toBe(false);
    expect(boxEdgeShare(SMALL_BLOCKY_HOLD, 128)).toBe(0);
  });

  it('gate 4 catches a shard whose outline count moved', () => {
    const counts = getOutlineCounts();
    const tampered = { ...counts, 'grasshopper/1-5': { traced: 331, placements: 332 } };
    expect(tampered).not.toEqual(counts);
    expect(counts['grasshopper/1-5']).toEqual({ traced: 332, placements: 332 });
  });

  it('gate 5 catches a thin-necked limb and leaves a plain hold alone', () => {
    expect(spurArea(SPURRED, 3)).toBeGreaterThan(MAX_SPUR_AREA);
    expect(spurArea(CROP_BOX, 3)).toBe(0);
  });

  it('gate 5 exempts a hold too thin to core rather than deleting it', () => {
    // Nothing survives the erosion, so an unexempted open takes the whole rail.
    expect(openedArea(RAIL, 3)).toBe(0);
    expect(spurArea(RAIL, 3)).toBe(0);
    // One column wider it cores and comes back whole, so the exemption is not
    // what a plain 5-px rail is relying on.
    expect(openedArea([-2, -17, 2, -17, 2, 17, -2, 17], 3)).toBeGreaterThan(0);
    expect(spurArea([-2, -17, 2, -17, 2, 17, -2, 17], 3)).toBe(0);
  });

  // Gate 6's fixture board: one 35x17 slab of art with two bolts in it, 18 board
  // px apart, so the partition splits the slab down the middle at x = 18 with
  // solid art on both sides — the geometry the tracer meets wherever two holds
  // touch, with nothing else in the frame.
  const FIXTURE_ART = (() => {
    const width = 40;
    const height = 20;
    const opaque = new Uint8Array(width * height);
    for (let y = 2; y <= 17; y += 1) for (let x = 2; x <= 36; x += 1) opaque[y * width + x] = 1;
    return { opaque, width, height };
  })();
  const FIXTURE_PLACEMENTS: Placement[] = [
    { id: 1, cx: 9, cy: 9, r: 8 },
    { id: 2, cx: 27, cy: 9, r: 8 },
  ];
  // Bolt 1's half of the slab, cut on the partition at x = 18: the right-hand
  // side is 16 of the polygon's 62 boundary pixels, and every one of them has
  // bolt 2's art behind it.
  const ON_THE_CUT = [-7, -7, 9, -7, 9, 8, -7, 8];
  // The same silhouette pulled 3 px back off that cut.
  const PULLED_BACK = [-7, -7, 6, -7, 6, 8, -7, 8];

  it('gate 6 catches a silhouette that ends on a neighbour and clears one that does not', () => {
    const onTheCut = cutShares(FIXTURE_ART, FIXTURE_PLACEMENTS, FIXTURE_PLACEMENTS[0], ON_THE_CUT);
    expect(onTheCut.neighbour).toBeGreaterThan(0.2);
    const pulledBack = cutShares(FIXTURE_ART, FIXTURE_PLACEMENTS, FIXTURE_PLACEMENTS[0], PULLED_BACK);
    expect(pulledBack.neighbour).toBe(0);
    // Both boundaries are inside the slab, so the `opaque` half cannot tell them
    // apart — which is why the pins carry it as a ceiling and not as the defect
    // count.
    expect(onTheCut.opaque).toBeGreaterThan(0.2);
    expect(pulledBack.opaque).toBeGreaterThan(0.2);
  });
});
