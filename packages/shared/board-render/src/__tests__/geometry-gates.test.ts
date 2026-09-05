/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { getOutlineCounts, listBoardArtGeometryKeys, loadBoardArtGeometry } from '@boardsesh/board-art-geometry/loader';
import {
  CROP_BOX_MIN_RUNS,
  CROP_BOX_PERIMETER_SHARE,
  MAX_BOX_EDGE_SHARE,
  MAX_SPUR_AREA,
  SIMPLIFY_EPSILON,
  areaRecovery,
  axisAlignedRuns,
  boxEdgeShare,
  containsPoint,
  cutShares,
  distanceOutsidePolygon,
  loadBoardArtLayers,
  nearbyCandidates,
  openedArea,
  overriddenPlacementIds,
  radiusForPlacement,
  reachesSearchBox,
  shardBoardForKey,
  spurArea,
  toTracerPixels,
  type Placement,
} from './gate-measures';

/**
 * The seven capture gates, run against the committed shards (issue #2202).
 *
 * They were written for the spike as "throwaway scripts to re-run after changing
 * the tracer", and that is exactly why the record drifted: nobody re-ran them,
 * and the traced counts in the write-up stayed on a pre-fix run through two
 * rounds of fixes. Gates 1 to 5 are geometry against geometry over all 51
 * shards; gates 6 and 7 decode real board art, so they run a nine-board sample
 * by default and the whole catalogue under `BOARD_ART_GATES=all`.
 *
 * Woods uses photographed art with touching holds. Its calibrated mounting grid
 * and physical-hold ownership are audited separately from the sprite boards.
 *
 * Every gate carries a fixture that must trip it. A silhouette gate that has
 * never failed is indistinguishable from one that cannot fail, and four of the
 * seven were originally reported against defects that are now zero everywhere.
 */

const ALL_SHARD_KEYS = listBoardArtGeometryKeys();

/**
 * The boards the art gates draw when they are not drawing all of them.
 *
 * Seven come from the spike, chosen for visually distinct hold sets rather than
 * for coverage: Tension's wooden originals against TB2's plastic, Kilter's
 * Homewall against the commercial Original, Grasshopper (the board the issue was
 * filed against) and two MoonBoards whose art is drawn for a white wall.
 *
 * Both Woods sizes are here because they are the ONLY configs on the white-key
 * path — mask from a flood fill instead of an alpha channel, a wider search box,
 * empty mounting slots excluded from segmentation. A code path that runs only under
 * `BOARD_ART_GATES=all` is a code path that breaks on somebody else's PR, and
 * these two cost 8 seconds.
 */
const SPIKE_SAMPLE_KEYS = [
  'grasshopper/1-5',
  'tension/9-1',
  'tension/10-6',
  'kilter/8-25',
  'kilter/1-10',
  'moonboard/2-1',
  'moonboard/5-1',
  'woods/1-1',
  'woods/1-2',
];

const RUN_EVERY_CONFIG = process.env.BOARD_ART_GATES === 'all';
const ART_GATE_KEYS = RUN_EVERY_CONFIG ? ALL_SHARD_KEYS : SPIKE_SAMPLE_KEYS;

/**
 * Gate 6's pins, from the run that wrote the committed shards.
 *
 * MEASURED PER IMAGE, like the tracer. A hold's art edge is a fact about the ONE
 * layer that draws it, so the probe reads that layer's alpha and the
 * nearest-placement contest is between the placements that layer draws. A
 * boundary where two SETS' art abuts is no longer a defect and is no longer
 * counted as one: those holds are bolted into different holes, they do not
 * overlap (0.06% of opaque pixels catalogue-wide), and the edge the tracer stops
 * at there IS the hold's true art edge. Measured on the composite the same edge
 * looks like a partition cut, which is what drove the tracer to chop 375 of
 * Kilter Homewall's 499 holds that did not need it.
 *
 * `neighbourMean` and `opaqueMean` are ceilings in percent, one decimal;
 * `overFivePercent` is an exact count of outlines whose boundary is more than 5%
 * on a same-layer neighbour's art. Before the tracer pulled back from contacts
 * the same three read 11.1% / 233 over 5% / 12.7% on Kilter Homewall, so this
 * gate has a two-order-of-magnitude fall to hold.
 *
 * `opaqueMean` is a RATCHET, and it is the chop metric. Boundary that has art on
 * the far side of it is boundary the tracer put inside the hold rather than at
 * its edge, so the number only falls when the tracer stops cutting holds it had
 * no reason to cut — and it only rises when something starts cutting them again,
 * which nothing else here would notice: a shrunk blob floating inside its own
 * hold passes every other gate in this file. Measured under this same per-image
 * probe, the shards that shipped before this rework read 17.3% on Kilter
 * Homewall 12x12 against 0.6% here; the ratchet fell on 41 of the 49 and rose on
 * none.
 *
 * The probe distance scales with the shard's own cut clearance, and that matters
 * more than it sounds. With a flat 2.5 board px probe, `overFivePercent` rose on
 * nine shards — and the nine were exactly the ones whose clearance dropped from
 * 3 px to 2, i.e. the ones being asked whether they had art half a pixel BEYOND
 * the distance they guarantee. Sweeping touchstone/1-1 on unchanged geometry
 * gives 6 outlines over 5% at a probe of 2.0, 32 at 2.5 and 69 at 3.0, so most
 * of that rise was the measure rather than the tracer: asked at the right
 * distance it is three shards by one or two outlines each. `cutProbeDistance`
 * asks half a pixel INSIDE each shard's guarantee, which is the only distance at
 * which a non-zero answer is about the geometry.
 *
 * One consequence: `opaqueMean` is NOT comparable ACROSS shards with different
 * clearances. A shorter probe sits nearer the boundary, so it lands inside the
 * hold's own antialiased rim more often — touchstone's 10.4% at a probe of 1.5
 * is mostly its own rim, not a tenth of its boundary being a chop. Each pin is a
 * ceiling for its own shard against its own history, which is all a ratchet has
 * to be.
 *
 * Woods' calibrated seeds reduce neighbour cuts; its bounds are measured over
 * physical holds only, excluding empty logical mounting slots.
 */
const PINNED_CUT_SHARES: Record<string, { neighbourMean: number; overFivePercent: number; opaqueMean: number }> = {
  'decoy/2-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.2 },
  'decoy/2-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'decoy/2-3': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'grasshopper/1-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.5 },
  'grasshopper/1-3': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 0.7 },
  'grasshopper/1-4': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 9.8 },
  'grasshopper/1-5': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.3 },
  'grasshopper/1-6': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.5 },
  'kilter/1-10': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.8 },
  'kilter/1-14': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.1 },
  'kilter/1-27': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.9 },
  'kilter/1-28': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 7 },
  'kilter/1-7': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.8 },
  'kilter/1-8': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.1 },
  // The kilter/8 rows are measured against the crisp profile: boundary at the
  // 50% isoline, sub-pixel snapped, then HALF A PIXEL INSIDE it on purpose
  // (`insetPx`), so a little of each hold's own art sitting just outside the
  // boundary is the design, not a chop. 8-19's ceiling moved 0.1 -> 0.2 with
  // that change; the other nine stayed under their pre-crisp ceilings.
  'kilter/8-17': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.6 },
  'kilter/8-18': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.1 },
  'kilter/8-19': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.2 },
  'kilter/8-21': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.8 },
  'kilter/8-22': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.2 },
  'kilter/8-23': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.7 },
  'kilter/8-24': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1 },
  'kilter/8-25': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.6 },
  'kilter/8-26': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.9 },
  'kilter/8-29': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.4 },
  'moonboard/1-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.6 },
  'moonboard/2-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6 },
  'moonboard/3-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.6 },
  'moonboard/4-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6 },
  'moonboard/5-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.6 },
  'moonboard/6-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6.4 },
  'moonboard/7-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6 },
  'soill/1-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0.1 },
  'soill/1-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 6 },
  'tension/10-10': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 1.5 },
  'tension/10-6': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 2.1 },
  'tension/10-7': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 2.8 },
  'tension/10-8': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 0.4 },
  'tension/10-9': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 0.5 },
  'tension/11-10': { neighbourMean: 0.1, overFivePercent: 1, opaqueMean: 2.4 },
  'tension/11-6': { neighbourMean: 0.1, overFivePercent: 1, opaqueMean: 2 },
  'tension/11-7': { neighbourMean: 0.1, overFivePercent: 2, opaqueMean: 2.5 },
  'tension/11-8': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 1.2 },
  'tension/11-9': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 1.5 },
  'tension/9-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-3': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-4': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-5': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'touchstone/1-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 10.4 },
  'woods/1-1': { neighbourMean: 0.4, overFivePercent: 8, opaqueMean: 9 },
  'woods/1-2': { neighbourMean: 0.2, overFivePercent: 6, opaqueMean: 9.3 },
};

/**
 * Outlines whose boundary runs through their own bolt rather than around it, per
 * shard, and the worst distance any of them puts the placement outside the
 * polygon.
 *
 * Three are Kilter Original 12x12 Wide's screw-on holds, whose art is drawn
 * BESIDE the bolt hole rather than over it, and the worst of them puts the bolt
 * 1.0 board px outside a polygon simplified at a 1.6 board px tolerance — i.e.
 * inside the simplification's own error. Gate 1 fails anything further out than
 * that; this pin is what stops the set growing quietly.
 *
 * It was five while the tracer cut on the composite. Two of those five were the
 * cut rather than the art: the boundary ran between the bolt and the hold it
 * belongs to because a neighbouring SET's art was stacked on top of it.
 *
 * Woods' calibrated positions no longer need boundary exceptions.
 */
const PINNED_PLACEMENT_ON_THE_EDGE: Record<string, number> = {
  // 3 while the boundary was the 37.6% isoline; the crisp profile's tighter
  // 50% cut moved one of the three beside-the-bolt screw-ons fully outside
  // (see PINNED_PLACEMENT_OUTSIDE_OUTLINE) and grazed one grasshopper bolt.
  'grasshopper/1-4': 1,
  'kilter/1-28': 2,
};

/**
 * The outlines whose placement ends up outside the polygon by more than the
 * simplification tolerance, per shard, and the worst distance any of them
 * manages.
 *
 * Pinned per id and distance. Woods' former exceptions were misplaced seeds
 * and disappear with the calibrated mounting grid (issue #4971).
 */
const PINNED_PLACEMENT_OUTSIDE_OUTLINE: Record<string, { holds: number[]; worstDistancePx: number }> = {
  // 4810 is one of the two kilter/1-28 hooks whose bolt sits under a concave
  // underside (the pair `CENTRE_TOLERANCE_RADII`'s comment records). At the
  // historical 37.6% isoline its bolt was 0.95 px outside; the crisp 50% cut
  // plus the half-pixel inset put it at 1.61 px — 0.05 radii, beside its own
  // hold, not on another.
  'kilter/1-28': { holds: [4810], worstDistancePx: 1.61 },
};

/**
 * Real thin limbs on uncontested sprites can exceed the trim-area threshold.
 * Pin their ids so a new limb still requires inspection.
 */
const PINNED_SPURRED_OUTLINES: Record<string, number[]> = {
  // Two crisp-profile additions, both UNCONTESTED sprites shipped whole: with
  // no neck trim run at all, a genuinely thin limb of the hold's own art stays
  // in the polygon, and the open this gate replays takes it off. That is the
  // hold's real shape now — the spur measure flags kept limbs, not cuts.
  'grasshopper/1-6': [456],
  'touchstone/1-1': [403],
};

/**
 * The outlines that contain a second placement because that second placement is
 * on the same hold.
 *
 * The calibrated Woods table has no coincident placements. Keep this exact
 * empty pin so accidentally merging two physical holds fails gate 2.
 */
const PINNED_COINCIDENT_TWINS: Record<string, number[]> = {};

type BoardAudit = {
  key: string;
  traced: number;
  placements: number;
  placementOnTheEdge: number;
  withoutOwnPlacement: number[];
  /** Worst distance any placement sits outside its own polygon, in board px. */
  worstOutsideDistance: number;
  withSecondPlacement: number[];
  coincidentTwins: number[];
  onSearchBoxEdge: number[];
  cropBoxShaped: number[];
  spurred: number[];
};

function auditShard(key: string): BoardAudit {
  const board = shardBoardForKey(key);
  const geometry = loadBoardArtGeometry(board);
  if (geometry === null) throw new Error(`${key}: shard is indexed but did not load`);
  // Gates 1-3 below run on every outline including these; gate 1's PIN and gate
  // 5 skip them. See `overriddenPlacementIds` for which measures a human's
  // drawing can legitimately fail and why.
  const handCorrected = overriddenPlacementIds(key);

  const audit: BoardAudit = {
    key,
    traced: Object.keys(geometry.outlines).length,
    placements: board.placements.length,
    placementOnTheEdge: 0,
    withoutOwnPlacement: [],
    worstOutsideDistance: 0,
    withSecondPlacement: [],
    coincidentTwins: [],
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

    // Gate 1, both halves, on tracer output only. The centre rule a correction
    // is held to is the WRITE path's — inside the ring, or outside by at most
    // `CENTRE_TOLERANCE_RADII` (0.25r) — and this measure's threshold is the
    // 1.6 board px simplification tolerance, which on kilter/1-28 is 0.052r.
    // Five times tighter, so a correction the editor accepted, the exporter
    // wrote and the merge admitted would red this gate with nowhere to go: the
    // hold could not be corrected and could not be left alone either. The
    // 0.25r rule still binds on it, in `overrides.test.ts`, against the
    // committed ring rather than the emitted one.
    //
    // `worstOutsideDistance` is tracked inside the same guard, for the same
    // reason: it is the ceiling on the pinned Woods exceptions, and a hand
    // correction is not one of them.
    if (!handCorrected.has(holdId)) {
      if (!containsPoint(tracerPixels, 0, 0)) audit.placementOnTheEdge += 1;
      const outsideDistance = distanceOutsidePolygon(tracerPixels, 0, 0);
      if (outsideDistance > SIMPLIFY_EPSILON) audit.withoutOwnPlacement.push(holdId);
      audit.worstOutsideDistance = Math.max(audit.worstOutsideDistance, outsideDistance);
    }

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
    // A second placement inside the polygon is a swallowed neighbour, UNLESS it
    // is on the same hold — which on a CV-detected hold table happens for real.
    // The two are counted apart so the exception cannot hide the defect.
    let swallowedNeighbour = false;
    let coveredTwin = false;
    const ownGroup = board.canonicalPlacement.get(holdId);
    for (const other of board.placements) {
      if (other.id === holdId) continue;
      // An empty logical mounting slot underneath a large physical hold is
      // not a second hold. Only placements the art actually draws can be
      // swallowed neighbours (also matches MoonBoard's empty-cell routing).
      if ((board.layerOfPlacement.get(other.id) ?? -1) < 0) continue;
      const offsetX = other.cx - centreX;
      const offsetY = other.cy - centreY;
      if (offsetX < minX || offsetX > maxX || offsetY < minY || offsetY > maxY) continue;
      if (!containsPoint(tracerPixels, offsetX, offsetY)) continue;
      if (board.canonicalPlacement.get(other.id) === ownGroup) coveredTwin = true;
      else swallowedNeighbour = true;
    }
    if (swallowedNeighbour) audit.withSecondPlacement.push(holdId);
    if (coveredTwin) audit.coincidentTwins.push(holdId);

    const box = Math.round(placement.r * board.searchRadii);
    if (boxEdgeShare(tracerPixels, box) > MAX_BOX_EDGE_SHARE) audit.onSearchBoxEdge.push(holdId);
    const { runs, share } = axisAlignedRuns(tracerPixels);
    if (runs >= CROP_BOX_MIN_RUNS && share > CROP_BOX_PERIMETER_SHARE && reachesSearchBox(tracerPixels, box)) {
      audit.cropBoxShaped.push(holdId);
    }
    if (!handCorrected.has(holdId) && spurArea(tracerPixels, radiusForPlacement(placement.r)) > MAX_SPUR_AREA) {
      audit.spurred.push(holdId);
    }
  }
  return audit;
}

const AUDITS = ALL_SHARD_KEYS.map(auditShard);

describe('board-art-geometry gates', () => {
  it('ships a shard for every board in the catalogue', () => {
    // Woods was the one board with no shard while the tracer could only read an
    // alpha channel: its art is an opaque photograph of the hold set on a white
    // ground. It is keyed off that ground now, so the catalogue is complete and
    // the count is pinned — a shard going missing is a broken art path, not a
    // decision anyone would take quietly.
    expect(ALL_SHARD_KEYS.filter((key) => key.startsWith('woods/'))).toEqual(['woods/1-1', 'woods/1-2']);
    expect(ALL_SHARD_KEYS.length).toBe(51);
  });

  it('gate 1: every outline sits on its own placement', () => {
    const measured = Object.fromEntries(
      AUDITS.filter((audit) => audit.withoutOwnPlacement.length > 0).map((audit) => [
        audit.key,
        { holds: audit.withoutOwnPlacement, worstDistancePx: Math.round(audit.worstOutsideDistance * 100) / 100 },
      ]),
    );
    expect(measured).toEqual(PINNED_PLACEMENT_OUTSIDE_OUTLINE);
  });

  it('gate 1: the outlines whose boundary runs through their own bolt are the pinned three', () => {
    const measured = Object.fromEntries(
      AUDITS.filter((audit) => audit.placementOnTheEdge > 0).map((audit) => [audit.key, audit.placementOnTheEdge]),
    );
    expect(measured).toEqual(PINNED_PLACEMENT_ON_THE_EDGE);
  });

  it('gate 2: no outline contains a placement from another hold', () => {
    for (const audit of AUDITS) expect([audit.key, audit.withSecondPlacement]).toEqual([audit.key, []]);
  });

  it('gate 2: the outlines covering a second placement are the pinned coincident twins', () => {
    const measured = Object.fromEntries(
      AUDITS.filter((audit) => audit.coincidentTwins.length > 0).map((audit) => [audit.key, audit.coincidentTwins]),
    );
    expect(measured).toEqual(PINNED_COINCIDENT_TWINS);
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

/**
 * Gate 7's pins: how much of its own art each shipped silhouette kept.
 *
 * `recovery` is the shipped polygon's area over the CONNECTED art body it sits
 * on, taken from that placement's partition cell on its own layer before any
 * trim or pullback. It is the only measure here that catches a hold which simply
 * lost half of itself — gate 3 clears a chopped silhouette, gate 5's open clears
 * it, and gate 6 positively likes it, because a boundary well inside the hold's
 * own art is what a pullback is supposed to produce.
 *
 * The connectivity is what makes the number mean anything. Counting the whole
 * partition cell put 145 of 181 "chopped" holds in the bucket with a
 * `droppedArea` of zero and no pullback — a cell is a region of the board, so a
 * neighbouring macro's rim can sit closer to this bolt than to its own and land
 * in it without ever touching this hold (grasshopper/1-4's 293 read 0.250 with
 * nothing removed from it at all).
 *
 * `recoveryMeanFloor` and `recoveryP10Floor` are floors; `choppedCeiling` counts
 * outlines under 0.8, which is where a glow stops matching the shape on the
 * wall. A recovery above 1 is not a defect: the tracer fills holes before taking
 * the outer border, so a hold with a punched-out bolt hole ships a polygon
 * covering art the partition never counted.
 *
 * A coincident group is measured ONCE, on its canonical. Its silhouette ships
 * under every member id, so auditing the members would weight one hold by how
 * many centres a detector happened to put on it.
 *
 * Woods excludes empty mounting slots from the partition. Its recovery pins
 * measure only physical holds, including the source-photo regression fixtures.
 */
const PINNED_AREA_RECOVERY: Record<
  string,
  { recoveryMeanFloor: number; recoveryP10Floor: number; choppedCeiling: number }
> = {
  'decoy/2-1': { recoveryMeanFloor: 0.979, recoveryP10Floor: 0.964, choppedCeiling: 2 },
  'decoy/2-2': { recoveryMeanFloor: 0.995, recoveryP10Floor: 0.982, choppedCeiling: 0 },
  'decoy/2-3': { recoveryMeanFloor: 0.994, recoveryP10Floor: 0.982, choppedCeiling: 0 },
  'grasshopper/1-2': { recoveryMeanFloor: 0.971, recoveryP10Floor: 0.955, choppedCeiling: 2 },
  'grasshopper/1-3': { recoveryMeanFloor: 0.969, recoveryP10Floor: 0.953, choppedCeiling: 2 },
  'grasshopper/1-4': { recoveryMeanFloor: 0.931, recoveryP10Floor: 0.876, choppedCeiling: 38 },
  'grasshopper/1-5': { recoveryMeanFloor: 0.988, recoveryP10Floor: 0.958, choppedCeiling: 2 },
  'grasshopper/1-6': { recoveryMeanFloor: 0.986, recoveryP10Floor: 0.956, choppedCeiling: 2 },
  'kilter/1-10': { recoveryMeanFloor: 0.963, recoveryP10Floor: 0.928, choppedCeiling: 0 },
  'kilter/1-14': { recoveryMeanFloor: 0.98, recoveryP10Floor: 0.965, choppedCeiling: 0 },
  'kilter/1-27': { recoveryMeanFloor: 0.963, recoveryP10Floor: 0.928, choppedCeiling: 0 },
  'kilter/1-28': { recoveryMeanFloor: 0.964, recoveryP10Floor: 0.925, choppedCeiling: 0 },
  'kilter/1-7': { recoveryMeanFloor: 0.963, recoveryP10Floor: 0.928, choppedCeiling: 0 },
  'kilter/1-8': { recoveryMeanFloor: 0.97, recoveryP10Floor: 0.93, choppedCeiling: 0 },
  'kilter/8-17': { recoveryMeanFloor: 0.985, recoveryP10Floor: 0.97, choppedCeiling: 0 },
  'kilter/8-18': { recoveryMeanFloor: 0.983, recoveryP10Floor: 0.966, choppedCeiling: 0 },
  'kilter/8-19': { recoveryMeanFloor: 0.986, recoveryP10Floor: 0.974, choppedCeiling: 0 },
  'kilter/8-21': { recoveryMeanFloor: 0.98, recoveryP10Floor: 0.962, choppedCeiling: 0 },
  'kilter/8-22': { recoveryMeanFloor: 0.981, recoveryP10Floor: 0.964, choppedCeiling: 0 },
  'kilter/8-23': { recoveryMeanFloor: 0.984, recoveryP10Floor: 0.972, choppedCeiling: 0 },
  'kilter/8-24': { recoveryMeanFloor: 0.983, recoveryP10Floor: 0.969, choppedCeiling: 0 },
  'kilter/8-25': { recoveryMeanFloor: 0.98, recoveryP10Floor: 0.962, choppedCeiling: 0 },
  'kilter/8-26': { recoveryMeanFloor: 0.98, recoveryP10Floor: 0.962, choppedCeiling: 0 },
  'kilter/8-29': { recoveryMeanFloor: 0.979, recoveryP10Floor: 0.958, choppedCeiling: 0 },
  'moonboard/1-1': { recoveryMeanFloor: 0.976, recoveryP10Floor: 0.937, choppedCeiling: 0 },
  'moonboard/2-1': { recoveryMeanFloor: 0.988, recoveryP10Floor: 0.944, choppedCeiling: 0 },
  'moonboard/3-1': { recoveryMeanFloor: 0.98, recoveryP10Floor: 0.94, choppedCeiling: 0 },
  'moonboard/4-1': { recoveryMeanFloor: 0.982, recoveryP10Floor: 0.943, choppedCeiling: 1 },
  'moonboard/5-1': { recoveryMeanFloor: 0.977, recoveryP10Floor: 0.938, choppedCeiling: 0 },
  'moonboard/6-1': { recoveryMeanFloor: 0.978, recoveryP10Floor: 0.934, choppedCeiling: 0 },
  'moonboard/7-1': { recoveryMeanFloor: 0.977, recoveryP10Floor: 0.939, choppedCeiling: 0 },
  'soill/1-1': { recoveryMeanFloor: 0.959, recoveryP10Floor: 0.91, choppedCeiling: 0 },
  'soill/1-2': { recoveryMeanFloor: 0.969, recoveryP10Floor: 0.96, choppedCeiling: 0 },
  'tension/10-10': { recoveryMeanFloor: 1.012, recoveryP10Floor: 0.982, choppedCeiling: 2 },
  'tension/10-6': { recoveryMeanFloor: 1.007, recoveryP10Floor: 0.967, choppedCeiling: 3 },
  'tension/10-7': { recoveryMeanFloor: 1.004, recoveryP10Floor: 0.958, choppedCeiling: 3 },
  'tension/10-8': { recoveryMeanFloor: 1.012, recoveryP10Floor: 1.001, choppedCeiling: 2 },
  'tension/10-9': { recoveryMeanFloor: 1.005, recoveryP10Floor: 0.99, choppedCeiling: 2 },
  'tension/11-10': { recoveryMeanFloor: 1.01, recoveryP10Floor: 0.974, choppedCeiling: 0 },
  'tension/11-6': { recoveryMeanFloor: 1.019, recoveryP10Floor: 0.99, choppedCeiling: 0 },
  'tension/11-7': { recoveryMeanFloor: 1.015, recoveryP10Floor: 0.984, choppedCeiling: 0 },
  'tension/11-8': { recoveryMeanFloor: 1.011, recoveryP10Floor: 1, choppedCeiling: 1 },
  'tension/11-9': { recoveryMeanFloor: 1.008, recoveryP10Floor: 0.996, choppedCeiling: 2 },
  'tension/9-1': { recoveryMeanFloor: 0.972, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-2': { recoveryMeanFloor: 0.972, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-3': { recoveryMeanFloor: 0.973, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-4': { recoveryMeanFloor: 0.972, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-5': { recoveryMeanFloor: 0.984, recoveryP10Floor: 0.973, choppedCeiling: 0 },
  'touchstone/1-1': { recoveryMeanFloor: 0.911, recoveryP10Floor: 0.843, choppedCeiling: 25 },
  'woods/1-1': { recoveryMeanFloor: 0.949, recoveryP10Floor: 0.879, choppedCeiling: 8 },
  'woods/1-2': { recoveryMeanFloor: 0.952, recoveryP10Floor: 0.882, choppedCeiling: 13 },
};

type ArtAudit = {
  neighbourMean: number;
  overFivePercent: number;
  opaqueMean: number;
  recoveryMean: number;
  recoveryP10: number;
  chopped: number;
};

/** Below this share of its own art, a silhouette is a fragment of the hold. */
const MIN_AREA_RECOVERY = 0.8;

/**
 * One decode and one pass over a shard's art, feeding both art gates.
 *
 * Memoised because gates 6 and 7 ask about the same 49 boards and decoding
 * nineteen layers of Decoy twice is minutes of nothing.
 */
const artAudits = new Map<string, Promise<ArtAudit>>();
function artAuditFor(key: string): Promise<ArtAudit> {
  const existing = artAudits.get(key);
  if (existing !== undefined) return existing;
  const audit = (async (): Promise<ArtAudit> => {
    const board = shardBoardForKey(key);
    const geometry = loadBoardArtGeometry(board);
    if (geometry === null) throw new Error(`${key}: shard is indexed but did not load`);
    const layers = await loadBoardArtLayers(board);
    const handCorrected = overriddenPlacementIds(key);

    let neighbourSum = 0;
    let opaqueSum = 0;
    let overFivePercent = 0;
    let counted = 0;
    const recoveries: number[] = [];

    for (const [holdIdText, flat] of Object.entries(geometry.outlines)) {
      const placement = board.placementById.get(Number(holdIdText)) as Placement;
      // One hold, measured once. A coincident group ships the SAME silhouette
      // under every member id, each re-anchored to its own centre, so auditing
      // the members would weight one hold by how many centres were detected on
      // it — and measuring an alias against the canonical's partition cell would
      // read the polygon as covering twice its own body.
      if (board.canonicalPlacement.get(placement.id) !== placement) continue;
      const layerIndex = board.layerOfPlacement.get(placement.id) ?? -1;
      // A placement no layer draws has no art edge to be right or wrong about.
      if (layerIndex < 0) continue;
      const layerArt = layers[layerIndex];
      const candidates = nearbyCandidates(board.placementsByLayer[layerIndex], placement, board.searchRadii);
      const tracerPixels = toTracerPixels(flat, placement);

      // Gate 6 only. A hand-corrected silhouette is exempt because the commonest
      // reason to draw one is a contact cut, and repairing a contact cut means
      // putting the boundary back on the hold's real art edge — which is exactly
      // what this measure calls a defect. Gate 7 below still binds on it: "did
      // this polygon keep its own hold" is a question a drawing has to answer
      // too, and a correction ought to IMPROVE it.
      if (!handCorrected.has(placement.id)) {
        const shares = cutShares(layerArt, candidates, placement, tracerPixels);
        neighbourSum += shares.neighbour;
        opaqueSum += shares.opaque;
        if (shares.neighbour > 0.05) overFivePercent += 1;
        counted += 1;
      }
      recoveries.push(areaRecovery(layerArt, candidates, placement, tracerPixels, board.searchRadii));
    }

    recoveries.sort((left, right) => left - right);
    return {
      // `counted` is zero only if every outline on the shard was hand-drawn, in
      // which case gate 6 has nothing to say and 0 is the honest reading rather
      // than a NaN that compares false against every pin.
      neighbourMean: counted === 0 ? 0 : Math.round((neighbourSum / counted) * 1000) / 10,
      overFivePercent,
      opaqueMean: counted === 0 ? 0 : Math.round((opaqueSum / counted) * 1000) / 10,
      recoveryMean:
        Math.round((recoveries.reduce((total, value) => total + value, 0) / recoveries.length) * 1000) / 1000,
      recoveryP10: Math.round(recoveries[Math.floor(recoveries.length * 0.1)] * 1000) / 1000,
      chopped: recoveries.filter((value) => value < MIN_AREA_RECOVERY).length,
    };
  })();
  artAudits.set(key, audit);
  return audit;
}

describe.concurrent("gate 6: no silhouette boundary sits on a same-layer neighbour's art", () => {
  for (const key of ART_GATE_KEYS) {
    it.concurrent(key, async () => {
      const measured = await artAuditFor(key);
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

describe.concurrent('gate 7: every silhouette keeps its own hold', () => {
  for (const key of ART_GATE_KEYS) {
    it.concurrent(key, async () => {
      const measured = await artAuditFor(key);
      const pinned = PINNED_AREA_RECOVERY[key];
      expect([key, pinned !== undefined]).toEqual([key, true]);
      expect([key, measured.chopped <= pinned.choppedCeiling, measured.chopped]).toEqual([key, true, measured.chopped]);
      expect([key, measured.recoveryMean >= pinned.recoveryMeanFloor, measured.recoveryMean]).toEqual([
        key,
        true,
        measured.recoveryMean,
      ]);
      expect([key, measured.recoveryP10 >= pinned.recoveryP10Floor, measured.recoveryP10]).toEqual([
        key,
        true,
        measured.recoveryP10,
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
  // Passed explicitly: the fixture's geometry is hand-computed against a
  // clearance of 3, and its toy placement radius of 8 would derive 1.5.
  const FIXTURE_PROBE = 2.5;

  it('gate 6 catches a silhouette that ends on a neighbour and clears one that does not', () => {
    const onTheCut = cutShares(FIXTURE_ART, FIXTURE_PLACEMENTS, FIXTURE_PLACEMENTS[0], ON_THE_CUT, FIXTURE_PROBE);
    expect(onTheCut.neighbour).toBeGreaterThan(0.2);
    const pulledBack = cutShares(FIXTURE_ART, FIXTURE_PLACEMENTS, FIXTURE_PLACEMENTS[0], PULLED_BACK, FIXTURE_PROBE);
    expect(pulledBack.neighbour).toBe(0);
    // Both boundaries are inside the slab, so the `opaque` half cannot tell them
    // apart — which is why the pins carry it as a ceiling and not as the defect
    // count.
    expect(onTheCut.opaque).toBeGreaterThan(0.2);
    expect(pulledBack.opaque).toBeGreaterThan(0.2);
  });

  // The same slab, cut back hard: bolt 1's half runs to x = 18, and this stops
  // at x = 9. Gate 6 likes it — the boundary is deep inside the hold's own art,
  // which is what a pullback produces — and gate 3 and gate 5 have nothing to
  // say about it either. Losing half the hold is the defect only gate 7 sees.
  const CHOPPED = [-7, -7, 0, -7, 0, 8, -7, 8];

  it('gate 7 catches a silhouette that kept half its hold, and clears one that kept it', () => {
    const chopped = areaRecovery(FIXTURE_ART, FIXTURE_PLACEMENTS, FIXTURE_PLACEMENTS[0], CHOPPED);
    expect(chopped).toBeLessThan(MIN_AREA_RECOVERY);
    expect(areaRecovery(FIXTURE_ART, FIXTURE_PLACEMENTS, FIXTURE_PLACEMENTS[0], ON_THE_CUT)).toBeGreaterThan(
      MIN_AREA_RECOVERY,
    );
    // And the gate it cannot be replaced by: the chopped silhouette's boundary
    // is entirely inside the hold's own art, so gate 6 reads zero on it.
    expect(cutShares(FIXTURE_ART, FIXTURE_PLACEMENTS, FIXTURE_PLACEMENTS[0], CHOPPED, FIXTURE_PROBE).neighbour).toBe(0);
  });
});
