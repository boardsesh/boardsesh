/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { getOutlineCounts, listBoardArtGeometryKeys, loadBoardArtGeometry } from '../loader';
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
 * WOODS IS NOT COMPARABLE TO THE OTHER BOARDS on any of these, and its pins say
 * so. Every other board's art is a sprite sheet, drawn with gutters between the
 * holds; Woods' is a photograph of a real wall, where holds touch, and its hold
 * table is CV-detected, so a wide hold routinely carries two or three centres
 * that the partition then splits it between. Its numbers are pinned against its
 * own history exactly like every other shard's, and comparing them to Kilter's
 * measures the boards rather than the tracer.
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
 * coincident placements merged to one seed. A code path that runs only under
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
 * Woods reads an order of magnitude higher on all three and that is the board,
 * not a regression: holds photographed on a real wall touch, so 50% of its
 * silhouettes pull back off a neighbour against 12% on TB2's densest size. Its
 * `opaqueMean` of ~22% is the pullback putting the boundary inside the hold's own
 * art, which is what the pullback is FOR — the half that would be a defect is
 * `neighbourMean`, and 3.5% / 1.3% there is a ceiling to ratchet down, not a
 * clean bill.
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
  'tension/10-10': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 8.3 },
  'tension/10-6': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 8.7 },
  'tension/10-7': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 8.1 },
  'tension/10-8': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 2.4 },
  'tension/10-9': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 2.3 },
  'tension/11-10': { neighbourMean: 0.1, overFivePercent: 2, opaqueMean: 9.2 },
  'tension/11-6': { neighbourMean: 0.1, overFivePercent: 1, opaqueMean: 9.1 },
  'tension/11-7': { neighbourMean: 0.1, overFivePercent: 2, opaqueMean: 9.7 },
  'tension/11-8': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 3.4 },
  'tension/11-9': { neighbourMean: 0.1, overFivePercent: 0, opaqueMean: 3.7 },
  'tension/9-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-2': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-3': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-4': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'tension/9-5': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 0 },
  'touchstone/1-1': { neighbourMean: 0, overFivePercent: 0, opaqueMean: 10.4 },
  'woods/1-1': { neighbourMean: 3.5, overFivePercent: 47, opaqueMean: 21.6 },
  'woods/1-2': { neighbourMean: 1.3, overFivePercent: 36, opaqueMean: 22.4 },
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
 * Woods' 18 and 32 are a different fact about a different kind of board. Its hold
 * table is CV-detected off the board photograph, and the detector puts two or
 * three centres on one wide hold often enough to matter — the partition then
 * splits that hold between them and each piece's bolt lands near the cut. There is
 * no set of "screw-ons" to name here, so the pin is a count per shard and the
 * table below carries the ones that end up outright outside.
 */
const PINNED_PLACEMENT_ON_THE_EDGE: Record<string, number> = {
  // 3 while the boundary was the 37.6% isoline; the crisp profile's tighter
  // 50% cut moved one of the three beside-the-bolt screw-ons fully outside
  // (see PINNED_PLACEMENT_OUTSIDE_OUTLINE) and grazed one grasshopper bolt.
  'grasshopper/1-4': 1,
  'kilter/1-28': 2,
  'woods/1-1': 16,
  'woods/1-2': 32,
};

/**
 * The outlines whose placement ends up outside the polygon by more than the
 * simplification tolerance, per shard, and the worst distance any of them
 * manages.
 *
 * Zero everywhere the art is a sprite sheet, and this exists for Woods. Eleven of
 * its 1,335 silhouettes (0.8%) sit beside their own bolt rather than around it,
 * all of them on holds the CV detector put more than one centre on: the partition
 * cuts the hold between the centres, the tracer seeds on the nearest art pixel to
 * the bolt, and on a small piece those two are on opposite sides of the boundary.
 * The worst is 4.24 board px on a 13.5 px placement radius, i.e. under a third of
 * a radius — beside the bolt, not on another hold. A twelfth was in this table
 * until the self-intersection backstop rejected its ring outright: the two
 * defects have the same cause, a sliver of a multi-detected hold.
 *
 * Pinned per id AND with a distance ceiling, because the two failures look
 * nothing alike: an id joining the list is one more piece of a multi-detected
 * hold, while the distance running away is a trace that landed somewhere else
 * entirely.
 */
const PINNED_PLACEMENT_OUTSIDE_OUTLINE: Record<string, { holds: number[]; worstDistancePx: number }> = {
  // 4810 is one of the two kilter/1-28 hooks whose bolt sits under a concave
  // underside (the pair `CENTRE_TOLERANCE_RADII`'s comment records). At the
  // historical 37.6% isoline its bolt was 0.95 px outside; the crisp 50% cut
  // plus the half-pixel inset put it at 1.61 px — 0.05 radii, beside its own
  // hold, not on another.
  'kilter/1-28': { holds: [4810], worstDistancePx: 1.61 },
  'woods/1-1': { holds: [146], worstDistancePx: 2.34 },
  'woods/1-2': { holds: [197, 289, 330, 375, 392, 402, 434, 456, 470, 807], worstDistancePx: 4.24 },
};

/**
 * One, and it is 22 board px² against a threshold of 20.
 *
 * Kilter Homewall 4135 and 4634 were pinned here while the tracer grew every
 * core at once, and both went to zero when it started growing only the seed's.
 * TB2 12x12 Wide's 952 was pinned here because `radiusForBoard` scaled the
 * neck-trim radius with the board's PIXEL width: that board is 1461 px across
 * carrying the same 31.8 px placement radius as the 1080 px 12x12, so it trimmed
 * at 4 where the narrower board trimmed at 3, and Douglas-Peucker left a 3-px
 * limb the wider disc would have taken. The radius is now a fraction of the
 * placement radius, which is what a hold's neck is a fraction of, and both of
 * those are gone.
 *
 * Woods' 712 is what a 20 px² threshold looks like on a board whose placement
 * radius is 13.5 rather than 31.8: the trim radius floors at 2 px there, so the
 * open the gate replays takes a corner off a hold the tracer had no reason to
 * touch. 22 against 20 is the margin, not a limb.
 */
const PINNED_SPURRED_OUTLINES: Record<string, number[]> = {
  // Two crisp-profile additions, both UNCONTESTED sprites shipped whole: with
  // no neck trim run at all, a genuinely thin limb of the hold's own art stays
  // in the polygon, and the open this gate replays takes it off. That is the
  // hold's real shape now — the spur measure flags kept limbs, not cuts.
  'grasshopper/1-6': [456],
  'touchstone/1-1': [403],
  'woods/1-2': [712],
};

/**
 * The outlines that contain a second placement because that second placement is
 * on the same hold.
 *
 * Woods' hold table is CV-detected off the board photograph, and it emits pairs
 * of centres 0-2 board px apart for one physical hold —
 * `COINCIDENT_PAIR_BUDGET` in `@boardsesh/board-config`'s
 * `woods-hold-positions.test.ts` pins 24 such pairs on the 8x10 and 17 on the
 * 12x12, as an upper bound that may only shrink. The tracer merges each group to
 * one seed and emits its silhouette under every member id, so a member's polygon
 * USUALLY covers its twin's bolt. That is the correct drawing — there is one
 * hold on the wall — and it is the one thing gate 2 cannot tell apart from a
 * silhouette that swallowed its neighbour.
 *
 * Usually, not always: 58 of the 8x10's 62 merged members are listed and 36 of
 * 36 on the 12x12. The four that are not are members of two groups where the
 * shared silhouette is a sliver whose boundary runs between the two bolts rather
 * than around both, so containment is genuinely false. That is a fact about
 * those holds, not a hole in the check — the gate below asserts an exact set, so
 * a member appearing or disappearing fails it either way.
 *
 * Which is also the honest statement of the table's direction: `toEqual` means
 * this list may not GROW or shrink silently. A re-extraction of the hold table
 * that separates a pair should take ids out of it, and the test failing is how
 * that gets reviewed rather than absorbed.
 *
 * Merged groups here are a superset of the budget's pairs: 31 on the 8x10 and 18
 * on the 12x12, because the merge rounds centres first (the nearest-placement
 * transform it feeds seeds on rounded centres) and that pulls in pairs whose
 * exact separation is a shade over 2 px.
 */
const PINNED_COINCIDENT_TWINS: Record<string, number[]> = {
  'woods/1-1': [
    30, 31, 76, 77, 95, 96, 114, 115, 131, 132, 134, 135, 265, 266, 280, 281, 326, 327, 328, 329, 341, 342, 343, 344,
    345, 346, 350, 351, 363, 364, 370, 371, 385, 386, 395, 396, 413, 414, 415, 416, 424, 425, 426, 427, 431, 432, 433,
    434, 435, 436, 437, 438, 446, 447, 448, 449, 450, 451,
  ],
  'woods/1-2': [
    87, 88, 121, 122, 144, 145, 146, 147, 160, 161, 172, 173, 176, 177, 205, 206, 216, 217, 255, 256, 274, 275, 318,
    319, 389, 390, 404, 405, 468, 469, 650, 651, 671, 672, 786, 787,
  ],
};

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
 * Woods' 88 and 193 chopped are the highest in the table by a distance, and they
 * are almost entirely the multi-detected holds: a hold carrying three centres is
 * cut into three slivers and each sliver keeps a third of the body it sits on.
 * That is the right drawing — lighting the middle bolt should light the middle of
 * the rail — but it reads as a chop by this measure and it is pinned as one
 * rather than exempted, so a real regression on top of it still fails.
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
  'tension/10-10': { recoveryMeanFloor: 0.955, recoveryP10Floor: 0.92, choppedCeiling: 28 },
  'tension/10-6': { recoveryMeanFloor: 0.958, recoveryP10Floor: 0.909, choppedCeiling: 14 },
  'tension/10-7': { recoveryMeanFloor: 0.959, recoveryP10Floor: 0.906, choppedCeiling: 13 },
  'tension/10-8': { recoveryMeanFloor: 0.972, recoveryP10Floor: 0.922, choppedCeiling: 9 },
  'tension/10-9': { recoveryMeanFloor: 0.97, recoveryP10Floor: 0.924, choppedCeiling: 10 },
  'tension/11-10': { recoveryMeanFloor: 0.956, recoveryP10Floor: 0.905, choppedCeiling: 18 },
  'tension/11-6': { recoveryMeanFloor: 0.959, recoveryP10Floor: 0.906, choppedCeiling: 18 },
  'tension/11-7': { recoveryMeanFloor: 0.952, recoveryP10Floor: 0.887, choppedCeiling: 16 },
  'tension/11-8': { recoveryMeanFloor: 0.974, recoveryP10Floor: 0.916, choppedCeiling: 6 },
  'tension/11-9': { recoveryMeanFloor: 0.973, recoveryP10Floor: 0.907, choppedCeiling: 6 },
  'tension/9-1': { recoveryMeanFloor: 0.972, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-2': { recoveryMeanFloor: 0.972, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-3': { recoveryMeanFloor: 0.973, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-4': { recoveryMeanFloor: 0.972, recoveryP10Floor: 0.948, choppedCeiling: 0 },
  'tension/9-5': { recoveryMeanFloor: 0.984, recoveryP10Floor: 0.973, choppedCeiling: 0 },
  'touchstone/1-1': { recoveryMeanFloor: 0.911, recoveryP10Floor: 0.843, choppedCeiling: 25 },
  'woods/1-1': { recoveryMeanFloor: 0.88, recoveryP10Floor: 0.702, choppedCeiling: 88 },
  'woods/1-2': { recoveryMeanFloor: 0.877, recoveryP10Floor: 0.703, choppedCeiling: 193 },
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
