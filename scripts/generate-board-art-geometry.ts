/// <reference types="node" />

/**
 * Trace the real silhouette of every hold on every board in the catalogue, and
 * measure the art under and around it (issue #2202).
 *
 * Usage:
 *   vp run generate:board-art-geometry                      # write the shards
 *   vp run generate:board-art-geometry -- --check           # drift gate (CI)
 *   vp run generate:board-art-geometry -- --board=kilter    # one board
 *   vp run generate:board-art-geometry -- --config=8-25     # one layout-size
 *   vp run generate:board-art-geometry -- --report=<dir>    # visual + metric report, writes no shards
 *
 * WHY THIS IS OFFLINE
 * -------------------
 * The point of a halo is to show the SHAPE of the hold, so a climber can find
 * that shape on the wall — and hold sizes on one board run from a fingernail
 * foot chip to a jug three times its width. A ring at the placement radius says
 * nothing about either. Nothing at runtime can sample the composited board
 * photo (there is no CSS `contrast-color()` in a Rust renderer, and no decoded
 * art on the draw path), so the sampling happens here and ships as a table.
 *
 * WHAT ONE SHARD IS
 * -----------------
 * One `(board, layout, size)` with every set of that layout and size mounted.
 * Set ids are not part of the key, and since the tracer went per-image that is
 * exact rather than merely adequate: each placement is traced against the ONE
 * layer that draws it, partitioned only over the other placements on that layer,
 * so nothing about a hold's silhouette depends on which other sets are mounted.
 * Per-subset shards would be combinatorial (Decoy 2-1 mounts 19 layers) for a
 * difference that provably does not exist.
 *
 * THE FOUR BUGS, and the rule each one bought:
 *   1. A flood fill walks through a contact patch into the neighbouring hold and
 *      the pair traces as one blob — one glow covering three holds on Kilter
 *      Homewall. Fixed by the nearest-placement partition (`buildLabelMap`),
 *      which is an exact Euclidean transform: the chamfer it replaced was ~4%
 *      long on a diagonal and mislabelled a strip either side of every diagonal
 *      midline.
 *   2. A hold keeps a limb joined to it only through a thin neck of a
 *      neighbour's rim — Kilter Homewall's STARTING 4628 traced as a numeral 6.
 *      Fixed by the erosion/dilation neck trim (`trimThinNecks`).
 *   3. Where two holds' art genuinely touches, the partition cut runs through
 *      solid art, so the mark's brightest band lands ON the neighbour. Fixed by
 *      the contact pullback (`pullBackFromCuts`).
 *   4. Two holds from different SETS do not touch on the wall and barely overlap
 *      in the art (0.06% of opaque pixels), but flatten their layers into one
 *      bitmap and they do — and 3 and 2 then chop apart holds that had nothing
 *      wrong with them: 375 of Kilter Homewall's 499. Fixed by tracing per
 *      image (`perImageMaskProvider`). Every COLOUR reading still measures the
 *      composite, because what a mark competes with is the stack.
 * Every one of those is restated as a gate in the package's tests.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { listCatalogueEntries } from '../packages/shared/board-render/src/render-version-projection';
import { getBoardDetailsForBoard } from '../packages/shared/board-render/src/board-details';
import { getBackgroundRelPaths } from '../packages/shared/board-render/src/background';
// Relative, like the board-render imports above: the repo's isolated linker
// leaves workspace packages out of the root `node_modules`, so a bare specifier
// does not resolve for a script run from the repo root.
import { MOONBOARD_CELL_SETS } from '../packages/shared/board-config/src/generated/moonboard-cell-sets';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS } from '../packages/shared/board-config/src/moonboard-config';
import { isSimpleRing } from '../packages/shared/board-art-geometry/src/segmentation/led-ring';
import { MAX_RING_COORDINATE, MAX_RING_NUMBERS } from '../packages/shared/board-art-geometry/src/ring';
import {
  buildWhiteKeyMask,
  mergeCoincidentPlacements,
} from '../packages/shared/board-art-geometry/src/segmentation/white-key';
import type { BoardRenderDetails, RenderableHold } from '../packages/shared/board-render/src/types';
import { OVERRIDES_DIR, adoptSameImageOverrides, loadOverridesFor } from './outline-overrides-merge';
import {
  measurePairRegistration,
  projectRingUnits,
  ringAgreement,
  type AlphaPlane,
  type PairRegistration,
  type RegistrationSample,
} from './canonical-outlines';
import {
  MIN_CONFIG_ACCEPTANCE,
  assembleLedInner,
  describeLedRings,
  extractConfigLedRings,
  qualifies,
  type LedRingConfigResult,
} from './led-ring-extract';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
/**
 * The board art. Same directory `scripts/generate-dark-board-art.ts` reads:
 * `getBackgroundRelPaths` returns `public/`-relative paths, so the art lives at
 * `packages/web/public/images/...` even though the files are also served from
 * object storage since #4776.
 */
const PUBLIC_DIR = path.join(ROOT_DIR, 'packages/web/public');
const PACKAGE_DIR = path.join(ROOT_DIR, 'packages/shared/board-art-geometry');
const GENERATED_DIR = path.join(PACKAGE_DIR, 'src/generated');

// ---------------------------------------------------------------------------
// Tracer constants. Each one is a measurement, not a preference — see the
// comment on it for what moving it cost when it was moved.
// ---------------------------------------------------------------------------

/** A pixel counts as hold art if its alpha is at least this. */
const ALPHA_FLOOR = 96;
/**
 * Half-width of the search box around a placement, in placement radii. Generous
 * on purpose: the nearest-placement partition is what stops a hold running into
 * its neighbour, so the box only has to contain the largest real hold. At 1.25
 * it was smaller than a Kilter Homewall mainline hold and 43% of that board's
 * outlines came back with a piece of the box traced into them as a straight edge.
 */
const SEARCH_RADII = 2.6;
/**
 * The same half-width for a photographic board, where the holds are bigger
 * against their bolt pitch than any transparent-art board's.
 *
 * Woods' art is a photograph of a real wall rather than a sprite sheet, so its
 * biggest holds run further past their own placement radius than a sprite does.
 * Swept on the shipped geometry: at 2.6 the box is traced into four silhouettes
 * (three on the 8x10, one on the 12x12) and gate 3 throws all four away; from 3.0
 * up nothing in either size is clipped. 3.5 is that plateau with a margin rather
 * than its edge, and 4.0 changes nothing again.
 *
 * Close to a free knob: a bigger box only costs time, because what bounds a hold
 * is the nearest-placement partition and not the box. It is stated separately
 * rather than raised for everybody because moving 2.6 would re-cut all 49
 * transparent-art shards for a problem they do not have.
 */
const PHOTO_SEARCH_RADII = 3.5;
/**
 * Pixels of antialiased rim the white key drops after flooding the ground.
 *
 * A sprite photographed against white blends into it over about a pixel, and that
 * blend survives a brightness threshold: leave it and every hold ships with a
 * one-pixel white collar traced into its silhouette. This is the same erode the
 * shipped dark-mode Woods art uses, from the same module.
 */
const WHITE_KEY_ERODE_PX = 1;
/**
 * Seed disc around the placement centre, as a fraction of the distance to the
 * nearest other placement. Big enough to step off a punched-out bolt hole, far
 * too small to reach a neighbour — the old "nearest filled pixel anywhere in the
 * box" rule put 22% of MoonBoard Masters' lit holds on the wrong hold.
 */
const SEED_PITCH_FRACTION = 0.15;
const MIN_SEED_RADIUS = 4;
/**
 * Hard ceiling on the seed disc, in placement radii, whatever the pitch says.
 *
 * The pitch-scaled rule assumes a placement's nearest neighbour is about a hold
 * away, which is true on a composited board and false on a single set's layer.
 * Kilter Homewall's two screw-on layers carry 13 and 14 placements across the
 * whole 1080x1920 board, so their nearest-neighbour pitch is hundreds of pixels
 * and an uncapped seed disc reaches clean off the hold onto art the layer draws
 * for somebody else. At 0.75 the disc still steps off a punched-out bolt hole on
 * every board in the catalogue and cannot leave the placement's own radius.
 */
const SEED_MAX_RADII = 0.75;
/** Fraction of perimeter allowed on the search-box boundary before the trace is junk. */
const MAX_BOX_EDGE_SHARE = 0.1;
/** Douglas-Peucker tolerance in board pixels. Bigger = fewer points, blockier outline. */
const SIMPLIFY_EPSILON = 1.6;
/** Outlines shorter than this many pixels of perimeter are noise, not a hold. */
const MIN_PERIMETER_POINTS = 24;
/**
 * Neck-trim and cut-clearance radius, as a fraction of the placement radius.
 *
 * The rule this replaces scaled both radii by the board's PIXEL width against a
 * 1080 px reference, on the assumption that hold size scales with board width.
 * It does not. TB2's 12x12 Wide is 1461 px across carrying the same 31.8 px
 * placement radius as the 1080 px 12x12, so it trimmed at 4 where the narrower
 * board trimmed at 3 — and Douglas-Peucker then left a 3-px limb the wider disc
 * would have taken, which is exactly the one outline in the catalogue that had
 * to be pinned as a known gate-5 failure (tension/11-10's 952).
 *
 * A hold's neck is a fraction of the hold, so the radius is a fraction of the
 * placement radius. 0.078 is not a new tuning pass: it is the number that keeps
 * Kilter Homewall at the 3 it already trimmed at and both MoonBoards at the 2
 * they already trimmed at, so the two boards the old rule was calibrated on do
 * not move and only the boards it got wrong do.
 *
 * IT SITS NEAR THE TOP OF ITS INTERVAL. Every c in [0.0648, 0.0786) rounds to
 * exactly the radii this catalogue ships; at 0.07862 the TB2 12x12 and 12x12
 * Wide, decoy/2-1 and grasshopper/1-4 all flip from clearance 2 to 3 and their
 * output moves. So 0.078 is a choice inside a wide plateau rather than a knife
 * edge that happened to land — but it is 0.0006 from the upper wall, and anyone
 * nudging it upward should expect four configs to move rather than none.
 *
 * ONE COEFFICIENT FOR BOTH RADII, and that costs something the old code recorded.
 * The rule this replaced carried a separate `CUT_CLEARANCE_AT_REFERENCE = 3` with
 * a measurement attached: at a clearance of 2, shoulder ink sitting on a
 * neighbour was 731 board px² across the spike's seven boards against 25 at 3.
 * That measurement was taken on the COMPOSITE, where holds from different sets
 * appear to touch — most of the 731 px² was ink landing on a neighbour that is
 * not a neighbour once each set is traced on its own layer, and the boards it was
 * taken on now clear 0.6% of their boundary against same-layer art. It is
 * superseded, not refuted, and it is the reason to re-measure rather than assume
 * if the clearance is ever decoupled from the trim radius again.
 */
const TRIM_RADIUS_PER_PLACEMENT_RADIUS = 0.078;
/** Board px² a trim has to drop before the run reports it, on gate 5's threshold. */
const NOTABLE_TRIM_AREA = 20;
/**
 * Share of its own art body the emitted silhouette has to keep before the hold
 * counts as chopped.
 *
 * Not a tuning knob on the tracer — nothing branches on it — but the single
 * number the whole rework is measured by: `tracedArea / cellAlphaArea`, where the
 * denominator is the connected art body the seed sits on inside this placement's
 * partition cell. A hold whose neck trim and pullback between them threw away
 * more than a fifth of that body is a hold whose glow no longer matches the shape
 * on the wall, which is the defect this pipeline exists to avoid.
 */
const MIN_AREA_RECOVERY = 0.8;
/**
 * Opaque share of the composited board above which the art carries no silhouette
 * information in its alpha channel, and the config routes through the white key
 * instead of reading alpha directly.
 *
 * Every board but one is a stack of mostly-transparent layers, and the whole
 * tracer reads that alpha channel — the hold IS the opaque region. Woods breaks
 * the rule: its art is an opaque photograph of the hold set on a white ground
 * (the same fact `scripts/generate-woods-dark-art.ts` records for the opposite
 * reason), so the alpha channel is 100% filled and every "silhouette" the tracer
 * would return is a cell of the nearest-placement partition rather than a hold.
 *
 * ONE CEILING, ASKED TWICE. The composite is measured first; a board over the
 * ceiling then has its ground keyed out (`buildWhiteKeyMask`) and is measured
 * again. A keyed share still over the ceiling means the key found no ground —
 * the corners were not board ground — and the config is skipped exactly as it
 * was before, so a future photographic board shot on a coloured sweep falls back
 * to rings honestly rather than tracing its own noise. Woods clears it with room:
 * 100.0% opaque before, 26.3% and 28.6% after, against a 95% bar.
 *
 * The first reading has a 2.3x margin — Woods is 100.0% and the next densest
 * board in the catalogue, Touchstone, is 40.8% — so it is a check on "is there an
 * alpha channel to read", not a tuning knob. Separating Woods out by name instead
 * would go stale the moment another board ships photographic art.
 */
const OPAQUE_ART_CEILING = 0.95;
/** Decimals the emitted radius-unit coordinates keep. 4 is 0.005 board px at the smallest radius. */
const COORDINATE_DECIMALS = 4;
/** Decimals the emitted lightness readings keep, matching the spike's tables. */
const LIGHTNESS_DECIMALS = 3;

// ---------------------------------------------------------------------------
// Tracer profiles: which edge the silhouette follows, per board.
// ---------------------------------------------------------------------------

/**
 * The knobs that decide where a silhouette's boundary sits relative to the
 * art's anti-aliased edge ramp, bundled so they can move per board without
 * forking the pipeline (the same seam `searchRadii` already uses per field).
 *
 * WHY THEY EXIST AT ALL. The Boardsesh glow paints fully opaque colour
 * immediately OUTSIDE the outline polygon and nothing inside it, and the board
 * art ends in a 1-3 px anti-aliased alpha ramp that reads as a black ring over
 * the dark wall. Every ramp pixel the polygon keeps inside is a ramp pixel the
 * glow cannot replace. The default profile reproduces the tracer's historical
 * behaviour byte for byte; a "crisp" profile moves the boundary to the visual
 * edge and keeps it there.
 */
type TracerProfile = {
  /**
   * A pixel counts as hold art if its alpha is at least this. The historical
   * 96 is the 37.6% isoline — OUTSIDE the 50% coverage point, so the whole
   * outer half of the ramp lands inside the polygon. Crisp profiles use 128,
   * the 50% isoline: the perceived edge of an anti-aliased shape.
   */
  alphaFloor: number;
  /** Douglas-Peucker tolerance in board pixels (the classic `SIMPLIFY_EPSILON`). */
  simplifyEpsilon: number;
  /**
   * Ceiling on how far a simplified chord may sit OUTSIDE the traced boundary,
   * in board pixels — `null` runs the classic two-sided DP. A convex arc's
   * chord cuts inward (harmless: the glow overlaps art) but a concave arc's
   * chord bulges outward by up to the full ε, and an outward bulge is exactly
   * the failure that keeps dark ramp inside the polygon. Not 0: a hard zero
   * explodes vertex counts on residual half-pixel noise; the small allowance is
   * covered by `insetPx`.
   */
  outwardEpsilon: number | null;
  /**
   * Alpha value whose isoline border vertices snap to (sub-pixel, along the
   * local normal) before simplification — `null` skips the snap. The Moore
   * follower walks pixel centres, which staircases the boundary by ±0.5 px;
   * one-sided DP on a staircase locks onto the inner corners of every stair,
   * so the snap is what makes `outwardEpsilon` produce few, well-placed
   * vertices instead of many jagged ones.
   */
  snapToAlpha: number | null;
  /**
   * Constant inward offset applied along the snap normal, in board pixels.
   * Insurance for what remains outside the isoline maths: the renderer's own
   * ~1 px anti-aliased coverage band, the `outwardEpsilon` allowance, and the
   * sub-pixel registration residue of a ring projected across art families.
   */
  insetPx: number;
  /**
   * Apply the nearest-placement cut machinery (partition clip, neck trim,
   * contact pullback) ONLY where a hold's art is genuinely CONNECTED to a
   * neighbouring placement's art.
   *
   * The partition is a global Voronoi over bolt positions, and holds are not
   * Voronoi cells: a wide sprite's lobe routinely crosses the bisector towards
   * a neighbouring bolt it never touches. The classic path amputates that lobe
   * along a dead-straight line (it is labelled to the neighbour, whose own art
   * it is not connected to, so NOBODY ships it) and then the pullback carves a
   * further clearance scallop — a glow-coloured bite out of the hold a user
   * can point at (Kilter Homewall 4244 and 4352 were the two pointed at). With
   * this flag, a component flooded from the seed that contains no other
   * placement's centre is the hold, whole; only components genuinely shared
   * with a neighbour go through the cut machinery.
   */
  contestedCutsOnly: boolean;
};

/** The tracer's historical behaviour, byte for byte. */
const DEFAULT_TRACER_PROFILE: TracerProfile = {
  alphaFloor: ALPHA_FLOOR,
  simplifyEpsilon: SIMPLIFY_EPSILON,
  outwardEpsilon: null,
  snapToAlpha: null,
  insetPx: 0,
  contestedCutsOnly: false,
};

/**
 * Boards whose silhouettes follow the crisp 50% edge, keyed
 * `<boardName>/<layoutId>`. Everything absent traces exactly as it always has —
 * activation is per board+layout so one board's re-cut never moves another's
 * shards.
 *
 * The crisp numbers, each measured on Kilter Homewall art (issue: the black
 * ring between a lit hold and its glow):
 * - `alphaFloor`/`snapToAlpha` 128 — the 50% isoline, the perceived edge of an
 *   anti-aliased shape. The homewall's edge ramp runs 1-3 px; at the historical
 *   96 the outer ~1 px of ramp sat inside the polygon on every hold.
 * - `simplifyEpsilon` 0.75 — half the classic 1.6, affordable because the snap
 *   hands DP a smooth curve instead of a staircase. Vertex counts land ~30-60
 *   against the 150-point `isValidOutlineRing` cap.
 * - `outwardEpsilon` 0.25 — a chord may overshoot the isoline outward by a
 *   quarter pixel before it splits; the inset covers it.
 * - `insetPx` 0.5 — covers the outward allowance plus the renderer's own ~1 px
 *   anti-aliased coverage band at half weight. Tuned against glow-lab
 *   montages: at 0 a faint dark seam survives on ramp edges, by 1.0 small
 *   screw-on chips visibly shrink.
 *
 * One shared constant set for every sprite board: the isoline values are
 * resolution-independent, and the pixel quantities (ε, inset) span 0.015-0.05 r
 * across the catalogue's placement radii — inside the range they were tuned at,
 * with MoonBoard's 650 px art at the top of it (its cell routing goes through
 * `MOONBOARD_CELL_SETS`, but once a field exists the sprite pipeline is the
 * same). Woods stays on the default profile: a white-keyed photograph is a
 * binary mask with no alpha isoline to snap to.
 */
const CRISP_PROFILE: TracerProfile = {
  alphaFloor: 128,
  simplifyEpsilon: 0.75,
  outwardEpsilon: 0.25,
  snapToAlpha: 128,
  insetPx: 0.5,
  contestedCutsOnly: true,
};

const CRISP_TRACER_PROFILES: Record<string, TracerProfile> = {
  'kilter/1': CRISP_PROFILE,
  'kilter/8': CRISP_PROFILE,
  'tension/9': CRISP_PROFILE,
  'tension/10': CRISP_PROFILE,
  'tension/11': CRISP_PROFILE,
  'decoy/2': CRISP_PROFILE,
  'grasshopper/1': CRISP_PROFILE,
  'soill/1': CRISP_PROFILE,
  'touchstone/1': CRISP_PROFILE,
  'moonboard/1': CRISP_PROFILE,
  'moonboard/2': CRISP_PROFILE,
  'moonboard/3': CRISP_PROFILE,
  'moonboard/4': CRISP_PROFILE,
  'moonboard/5': CRISP_PROFILE,
  'moonboard/6': CRISP_PROFILE,
  'moonboard/7': CRISP_PROFILE,
};

function profileFor(boardName: string, layoutId: number): TracerProfile {
  return CRISP_TRACER_PROFILES[`${boardName}/${layoutId}`] ?? DEFAULT_TRACER_PROFILE;
}

/**
 * Layouts whose holds are traced ONCE per layout and projected into every size
 * shard, keyed `<boardName>/<layoutId>`.
 *
 * The same physical hold is drawn on up to four art files per layout (one per
 * size family), and tracing each independently ships up to four slightly
 * different silhouettes for one hold. The canonical run traces the layout's
 * best-resolution art, and each size's shard receives that ring shifted by the
 * size's measured art-registration offset — see `canonicalLayoutFor` and
 * `scripts/canonical-outlines.ts`.
 */
const CANONICAL_LAYOUTS = new Set<string>(Object.keys(CRISP_TRACER_PROFILES));
/**
 * IoU a projected canonical ring must reach against the config's own direct
 * trace before it replaces it. Below the floor the two renders genuinely
 * disagree — a differently-drawn hold, or a pullback from a neighbour that
 * exists on only one of the two layers — and the direct trace ships instead
 * (the honest per-config answer, counted in the shard header).
 *
 * 0.9: on Kilter Homewall the same hold re-traced across families agrees to
 * ~0.91+ raw IoU even before registration correction; after the correction a
 * genuine match sits well above 0.9 and a hold pulled back on one layer only
 * falls well below it.
 */
const CANONICAL_AGREEMENT_FLOOR = 0.9;
/**
 * Registration spread that flags a pair of art files as disagreeing beyond a
 * rigid shift. The offset still applies (it is a median), but the run says so —
 * a large spread on a new board is the signal to check its report before
 * trusting projections there.
 */
const REGISTRATION_IQR_WARN_PX = 1.5;
/** Correlation windows sampled per image pair when measuring registration. */
const REGISTRATION_MAX_SAMPLES = 40;

/** Annulus a selector ring occupies, as fractions of the placement radius. */
const ANNULUS_INNER_FRACTION = 0.85;
const ANNULUS_OUTER_FRACTION = 1.15;

/** Radius of the sample disc at the LED, in board pixels. */
const LED_SAMPLE_RADIUS = 3;
/** A centre this many times brighter than the surrounding hold is a painted LED. */
const LED_BRIGHT_RATIO = 2.5;
/**
 * And bright in absolute terms, not only relative to its own hold. On the ratio
 * alone Kilter Original flags ten mid-grey bolt holes whose ratios (2.52-3.41)
 * sit on a continuum with the unflagged ones (2.38-2.44) — a dark hole in a
 * darker hold, which a takeover has nothing to cover. Measured on the blob those
 * ten reach 0.44 linear luma at best while all 234 of Grasshopper's painted LEDs
 * are 0.967 and up.
 */
const LED_BRIGHT_LUMA_FLOOR = 0.6;
/** How far from the LED to look for the blob's brightest pixel, in board pixels. */
const LED_BLOB_SEED_RADIUS = 4;
/** Pixels this bright and up are part of the painted blob. */
const LED_BLOB_LUMA_THRESHOLD = 0.5;
/**
 * Hard stop on the blob flood, in board pixels from its seed. Grasshopper's blobs
 * run about 4.2 px in radius (p90 4.33), so three times that reaches all of one
 * and still keeps a hold whose whole face is near-white from dragging the
 * centroid off the LED.
 */
const LED_BLOB_MAX_RADIUS = 12;

type Point = [number, number];

const ORTHOGONAL: readonly Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The neck-trim and cut-clearance radius for a placement, in board pixels. The
 * floor of 2 is where a disc stops being one: at radius 1 the erosion disc is a
 * single pixel and the neck trim can never fire.
 */
function radiusForPlacement(placementRadius: number): number {
  return Math.max(2, Math.round(TRIM_RADIUS_PER_PLACEMENT_RADIUS * placementRadius));
}

/**
 * Open and closed discs of a radius, as offsets. Testing a disc of background
 * pixels around each pixel is exactly a Euclidean distance transform thresholded
 * at the radius, without a chamfer pass's approximation error — at a radius of 2
 * or 3 that error would be most of the decision.
 *
 * The `<` on the erosion against `<=` on the dilation is deliberate, and it is
 * what sets the neck cut-off. At radius 3 the open disc reaches 2 px along the
 * axes, so a straight limb keeps a core from 5 px wide up; the closed disc
 * reaches 3, which would demand 7 and cut real 5- and 6-px rails. The dilation
 * has to be the wider of the two either way: it strictly contains the erosion
 * disc, so every pixel a core pixel needed filled to qualify comes back and no
 * straight edge is shaved by the round trip.
 */
function discOffsets(radius: number): { erosion: Point[]; dilation: Point[] } {
  const erosion: Point[] = [];
  const dilation: Point[] = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const squared = dx * dx + dy * dy;
      if (squared < radius * radius) erosion.push([dx, dy]);
      if (squared <= radius * radius) dilation.push([dx, dy]);
    }
  }
  return { erosion, dilation };
}

/** Moore-neighbour border following, clockwise, from the leftmost-topmost filled pixel. */
function traceBorder(filled: Uint8Array, width: number, height: number, start: Point): Point[] {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && filled[y * width + x] === 1;
  const offsets: Point[] = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  const border: Point[] = [];
  let current = start;
  let backtrackIndex = 0;
  const maxSteps = width * height * 4;

  for (let step = 0; step < maxSteps; step += 1) {
    border.push(current);
    let moved = false;
    for (let turn = 1; turn <= 8; turn += 1) {
      const index = (backtrackIndex + turn) % 8;
      const candidate: Point = [current[0] + offsets[index][0], current[1] + offsets[index][1]];
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

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const deltaX = lineEnd[0] - lineStart[0];
  const deltaY = lineEnd[1] - lineStart[1];
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  return (
    Math.abs(deltaY * point[0] - deltaX * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]) / length
  );
}

function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let worstIndex = 0;
  let worstDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (distance > worstDistance) {
      worstDistance = distance;
      worstIndex = index;
    }
  }
  if (worstDistance <= epsilon) return [points[0], points[points.length - 1]];
  return [
    ...simplify(points.slice(0, worstIndex + 1), epsilon).slice(0, -1),
    ...simplify(points.slice(worstIndex), epsilon),
  ];
}

/**
 * Douglas-Peucker with a one-sided tolerance: a chord may cut INWARD (under the
 * traced boundary, towards the hold body) by up to `epsilonIn`, but may sit
 * OUTWARD of it by no more than `epsilonOut`.
 *
 * The two directions are not symmetric for a glow mask. The glow paints only
 * outside the polygon, so a chord that cuts inward merely lets the glow overlap
 * opaque art — invisible — while a chord that bulges outward keeps un-glowed
 * dark edge ramp inside the polygon, which is the black ring this exists to
 * kill. Classic DP hands out its full ε in both directions; on a concave arc
 * that is a 1.6 px outward bulge.
 *
 * `epsilonOut` is small but NOT zero: a hard zero splits on every residual
 * quarter-pixel of snap noise and the vertex count explodes. What the allowance
 * lets through is covered by the profile's `insetPx`.
 *
 * Which side is "outward" comes from the ring's own winding (shoelace sign),
 * derived rather than assumed so the function cannot be broken by a change in
 * the border follower's direction.
 */
function simplifyInwardOnly(points: Point[], epsilonIn: number, epsilonOut: number): Point[] {
  if (points.length < 3) return points;
  // Shoelace over the implicitly-closed ring. In y-down pixel coordinates a
  // clockwise ring sums positive, and for a clockwise ring a point on the
  // POSITIVE cross side of a chord lies towards the interior.
  let doubledArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    doubledArea += ax * by - bx * ay;
  }
  const inwardSign = doubledArea >= 0 ? 1 : -1;

  const segment = (slice: Point[]): Point[] => {
    if (slice.length < 3) return slice;
    const [ax, ay] = slice[0];
    const [bx, by] = slice[slice.length - 1];
    const chordX = bx - ax;
    const chordY = by - ay;
    const chordLength = Math.hypot(chordX, chordY);
    let worstIndex = 0;
    let worstRatio = 0;
    for (let index = 1; index < slice.length - 1; index += 1) {
      const [px, py] = slice[index];
      let inwardDistance: number;
      if (chordLength === 0) {
        // Degenerate chord (the ring folded back onto its endpoints): treat the
        // full offset as an outward violation so the split always happens.
        inwardDistance = -Math.hypot(px - ax, py - ay);
      } else {
        const cross = chordX * (py - ay) - chordY * (px - ax);
        // Positive: the boundary point lies inward of the chord, i.e. the chord
        // bulges OUTWARD past the boundary there. Negative: the chord cuts
        // inward under the boundary.
        inwardDistance = (cross * inwardSign) / chordLength;
      }
      const ratio = inwardDistance >= 0 ? inwardDistance / epsilonOut : -inwardDistance / epsilonIn;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstIndex = index;
      }
    }
    if (worstRatio <= 1) return [slice[0], slice[slice.length - 1]];
    return [...segment(slice.slice(0, worstIndex + 1)).slice(0, -1), ...segment(slice.slice(worstIndex))];
  };
  return segment(points);
}

/**
 * Refine a Moore border to the art's alpha isoline, sub-pixel, and apply the
 * profile's inward inset — the step that turns a ±0.5 px pixel-centre staircase
 * into the smooth curve the one-sided simplifier needs.
 *
 * Per vertex: take the local tangent from the border neighbours two steps out,
 * pick the perpendicular that points towards falling alpha (sampled, not
 * assumed from winding — a cut edge has no falling side and gets skipped), walk
 * ±1.5 px along it in quarter-pixel steps sampling the alpha plane bilinearly,
 * and place the vertex where alpha crosses `targetAlpha`, then `insetPx`
 * further inward.
 *
 * Vertices with NO crossing in the window are left exactly where the border
 * follower put them, and the inset is not applied there either. That is the
 * partition-cut / pullback case: alpha is high on both sides, the boundary is a
 * geometry decision rather than an art edge, and moving it would undo the
 * clearance the pullback just bought.
 */
function snapBorderToIsoline(
  border: Point[],
  alpha: Uint8Array,
  alphaWidth: number,
  alphaHeight: number,
  offsetX: number,
  offsetY: number,
  targetAlpha: number,
  insetPx: number,
): Point[] {
  const sampleAlpha = (x: number, y: number): number => {
    const clampedX = Math.min(Math.max(x, 0), alphaWidth - 1);
    const clampedY = Math.min(Math.max(y, 0), alphaHeight - 1);
    const x0 = Math.floor(clampedX);
    const y0 = Math.floor(clampedY);
    const x1 = Math.min(x0 + 1, alphaWidth - 1);
    const y1 = Math.min(y0 + 1, alphaHeight - 1);
    const fx = clampedX - x0;
    const fy = clampedY - y0;
    const top = alpha[y0 * alphaWidth + x0] * (1 - fx) + alpha[y0 * alphaWidth + x1] * fx;
    const bottom = alpha[y1 * alphaWidth + x0] * (1 - fx) + alpha[y1 * alphaWidth + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  };

  const SNAP_WINDOW_PX = 1.5;
  const SNAP_STEP_PX = 0.25;
  const steps = Math.round((SNAP_WINDOW_PX * 2) / SNAP_STEP_PX);

  const snapped: Point[] = [];
  for (let index = 0; index < border.length; index += 1) {
    const [localX, localY] = border[index];
    const ahead = border[(index + 2) % border.length];
    const behind = border[(index - 2 + border.length) % border.length];
    const tangentX = ahead[0] - behind[0];
    const tangentY = ahead[1] - behind[1];
    const tangentLength = Math.hypot(tangentX, tangentY);
    if (tangentLength === 0) {
      snapped.push([localX, localY]);
      continue;
    }
    let normalX = -tangentY / tangentLength;
    let normalY = tangentX / tangentLength;
    const globalX = offsetX + localX;
    const globalY = offsetY + localY;
    // Outward is where alpha falls. Sampled at the window edge on both sides;
    // if neither side is below the target the vertex sits on a cut, not an art
    // edge, and is left alone.
    const positiveSide = sampleAlpha(globalX + normalX * SNAP_WINDOW_PX, globalY + normalY * SNAP_WINDOW_PX);
    const negativeSide = sampleAlpha(globalX - normalX * SNAP_WINDOW_PX, globalY - normalY * SNAP_WINDOW_PX);
    if (positiveSide >= targetAlpha && negativeSide >= targetAlpha) {
      snapped.push([localX, localY]);
      continue;
    }
    if (negativeSide < positiveSide) {
      normalX = -normalX;
      normalY = -normalY;
    }
    // Walk inside-out and take the FIRST crossing, so a second ramp further out
    // (a neighbour's edge entering the window) cannot capture the vertex.
    let previousOffset = -SNAP_WINDOW_PX;
    let previousAlpha = sampleAlpha(globalX + normalX * previousOffset, globalY + normalY * previousOffset);
    let crossing: number | null = null;
    for (let step = 1; step <= steps; step += 1) {
      const offset = -SNAP_WINDOW_PX + step * SNAP_STEP_PX;
      const value = sampleAlpha(globalX + normalX * offset, globalY + normalY * offset);
      if (previousAlpha >= targetAlpha && value < targetAlpha) {
        const span = previousAlpha - value;
        const fraction = span === 0 ? 0 : (previousAlpha - targetAlpha) / span;
        crossing = previousOffset + fraction * SNAP_STEP_PX;
        break;
      }
      previousOffset = offset;
      previousAlpha = value;
    }
    if (crossing === null) {
      snapped.push([localX, localY]);
      continue;
    }
    const placed = crossing - insetPx;
    snapped.push([localX + normalX * placed, localY + normalY * placed]);
  }
  return snapped;
}

/**
 * Nearest-placement label for every pixel, by an EXACT Euclidean distance
 * transform (Felzenszwalb–Huttenlocher, separable) carrying the label along.
 *
 * This is what makes touching holds separable. Without it a flood fill started on
 * one hold walks straight through the contact patch into its neighbour and the
 * pair traces as one blob. With it, each hold's mask is clipped at the midline
 * between its own bolt and the next one, which is where a climber would say the
 * hold ends anyway.
 *
 * WHY NOT THE CHAMFER IT REPLACES
 * -------------------------------
 * Two-pass chamfer propagation is up to ~4% long on a diagonal, and 4% of a
 * bolt-to-bolt pitch is a strip a pixel or two wide either side of every
 * midline that runs diagonally. Those strips were labelled the wrong hold, so
 * the tracer had no reason to pull back from a boundary that was in fact sitting
 * on a neighbour — which is exactly the handful of outlines gate 6 still counted
 * over 5% on a neighbour's art after the pullback landed. The gate measures the
 * exact nearest placement; now so does the generator.
 *
 * DETERMINISM
 * -----------
 * Distances are integer squared distances throughout, and every envelope
 * comparison is done by cross-multiplying the intersection's exact integer
 * numerator and denominator rather than dividing — the magnitudes involved
 * (about 2e10 at the catalogue's largest board) are exact in a double, so no
 * comparison is ever decided by rounding. Ties resolve in one fixed order:
 * lower column, then lower row, then lower placement index.
 */
function buildLabelMap(
  width: number,
  height: number,
  placements: ReadonlyArray<{ cx: number; cy: number }>,
): Int32Array {
  const UNLABELLED = -1;
  const seedLabel = new Int32Array(width * height).fill(UNLABELLED);
  for (const [index, placement] of placements.entries()) {
    const x = Math.round(placement.cx);
    const y = Math.round(placement.cy);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    // Lowest placement index keeps a shared pixel, so two placements rounding to
    // the same board pixel is a stable outcome rather than a load-order one.
    if (seedLabel[y * width + x] === UNLABELLED) seedLabel[y * width + x] = index;
  }

  // Pass 1, down each column: the squared distance to the nearest seed IN THAT
  // COLUMN, and whose it is. Two sweeps, the second replacing only on a strictly
  // shorter distance, so the lower row keeps an exact tie.
  const NO_SEED_IN_COLUMN = Number.MAX_SAFE_INTEGER;
  const columnDistance = new Float64Array(width * height);
  const columnLabel = new Int32Array(width * height).fill(UNLABELLED);
  for (let x = 0; x < width; x += 1) {
    let seedAbove = -1;
    for (let y = 0; y < height; y += 1) {
      const here = y * width + x;
      if (seedLabel[here] !== UNLABELLED) seedAbove = y;
      if (seedAbove < 0) {
        columnDistance[here] = NO_SEED_IN_COLUMN;
        continue;
      }
      columnDistance[here] = (y - seedAbove) * (y - seedAbove);
      columnLabel[here] = seedLabel[seedAbove * width + x];
    }
    let seedBelow = -1;
    for (let y = height - 1; y >= 0; y -= 1) {
      const here = y * width + x;
      if (seedLabel[here] !== UNLABELLED) seedBelow = y;
      if (seedBelow < 0) continue;
      const distance = (seedBelow - y) * (seedBelow - y);
      if (distance >= columnDistance[here]) continue;
      columnDistance[here] = distance;
      columnLabel[here] = seedLabel[seedBelow * width + x];
    }
  }

  // Pass 2, along each row: the lower envelope of the parabolas
  // `(x - column)² + columnDistance[column]`. The winning column's own label is
  // the pixel's label, because that column's nearest seed IS the nearest seed.
  const label = new Int32Array(width * height).fill(UNLABELLED);
  const envelopeColumn = new Int32Array(width);
  // Boundary between envelope entries `k` and `k+1`, as an exact rational
  // `boundaryNumerator / boundaryDenominator` with a positive denominator.
  const boundaryNumerator = new Float64Array(width + 1);
  const boundaryDenominator = new Float64Array(width + 1);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    let top = -1;
    for (let column = 0; column < width; column += 1) {
      const apexDistance = columnDistance[rowOffset + column];
      // A column holding no seed can never win, and carrying its infinity into
      // the intersection arithmetic would poison the exact comparison.
      if (apexDistance === NO_SEED_IN_COLUMN) continue;
      if (top < 0) {
        top = 0;
        envelopeColumn[0] = column;
        boundaryNumerator[0] = -Infinity;
        boundaryDenominator[0] = 1;
        boundaryNumerator[1] = Infinity;
        boundaryDenominator[1] = 1;
        continue;
      }
      let numerator = 0;
      let denominator = 1;
      for (;;) {
        const previous = envelopeColumn[top];
        numerator = apexDistance + column * column - (columnDistance[rowOffset + previous] + previous * previous);
        denominator = 2 * (column - previous);
        // `<=` pops a previous parabola whose span has closed to nothing, which
        // is what leaves the LOWER column owning an exact tie.
        if (top > 0 && numerator * boundaryDenominator[top] <= boundaryNumerator[top] * denominator) {
          top -= 1;
          continue;
        }
        break;
      }
      top += 1;
      envelopeColumn[top] = column;
      boundaryNumerator[top] = numerator;
      boundaryDenominator[top] = denominator;
      boundaryNumerator[top + 1] = Infinity;
      boundaryDenominator[top + 1] = 1;
    }
    // A row with no seeded column anywhere on the board leaves every pixel
    // unowned, which the field contract allows.
    if (top < 0) continue;
    let entry = 0;
    for (let column = 0; column < width; column += 1) {
      while (boundaryNumerator[entry + 1] < column * boundaryDenominator[entry + 1]) entry += 1;
      label[rowOffset + column] = columnLabel[rowOffset + envelopeColumn[entry]];
    }
  }
  return label;
}

/**
 * The 4-connected component of `filled` containing `start`, as flat indices.
 * `visited` is marked for every member, so passing a fresh array in makes it the
 * component's own mask.
 */
function floodComponent(
  filled: Uint8Array,
  width: number,
  height: number,
  start: number,
  visited: Uint8Array,
): number[] {
  const component: number[] = [start];
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
      if (visited[neighbour] === 1 || filled[neighbour] !== 1) continue;
      visited[neighbour] = 1;
      component.push(neighbour);
      stack.push(neighbour);
    }
  }
  return component;
}

/**
 * Fill a mask's enclosed holes: flood the background in from the box border and
 * keep everything it cannot reach. The outer border is the only thing this
 * script emits, so a punched-out bolt hole must never count as boundary — the
 * same reasoning `trimThinNecks` applies before its erosion, extracted for the
 * sprite-aware path that runs no trim at all.
 */
function fillMaskHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const background = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) background[index] = mask[index] === 1 ? 0 : 1;
  const outside = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    const x = index % width;
    const y = (index - x) / width;
    if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
    if (background[index] !== 1 || outside[index] === 1) continue;
    floodComponent(background, width, height, index, outside);
  }
  const solid = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) solid[index] = outside[index] === 1 ? 0 : 1;
  return solid;
}

/**
 * Drop whatever the seed can reach only through a neck too thin to be a hold.
 *
 * The partition is exact where two bolts are the arbiter, and this is the failure
 * it cannot see: where a small hold's bolt is closer to a strip of a neighbour's
 * rim than the neighbour's own bolt is, that strip stays 4-connected to the small
 * hold and the border follower traces it.
 *
 * Erode to the pixels sitting a neck-trim radius clear of the art's edge, keep
 * the one core the seed sits on, grow THAT core alone back over the mask it came
 * from, and keep what the seed can still reach. A neck thinner than the radius
 * carries no core of its own, so a limb behind one is never in the kept core and
 * never grows back; everything joined by real body survives.
 *
 * Growing only the seed's core is load-bearing. Dilating every core first and
 * flooding afterwards is `open(mask) ∩ seedComponent`, which re-bridges a limb
 * carrying a core of its own: the seed's dilation and the limb's meet inside the
 * neck and the flood walks across.
 *
 * The mask is hole-filled first, because the outer border is the only thing this
 * script emits. Without that, the punched-out bolt hole a placement usually sits
 * on counts as edge: the erosion eats the rim around it from both sides at once,
 * and on a small hold with a big hole the whole rim goes, leaving a C the border
 * follower walks into and out of.
 *
 * Two fallbacks keep it off holds that have no body to judge a limb against. A
 * mask with no core at all comes back untouched. Where the seed's own pixel is
 * not core the largest core stands in for it; if even that grows back without
 * covering the seed, the mask is returned untouched.
 */
function trimThinNecks(
  mask: Uint8Array,
  width: number,
  height: number,
  seedIndex: number,
  discs: { erosion: Point[]; dilation: Point[] },
): Uint8Array {
  const background = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) background[index] = mask[index] === 1 ? 0 : 1;
  const outside = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    const x = index % width;
    const y = (index - x) / width;
    if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
    if (background[index] !== 1 || outside[index] === 1) continue;
    floodComponent(background, width, height, index, outside);
  }
  const solid = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) solid[index] = outside[index] === 1 ? 0 : 1;

  const core = new Uint8Array(solid.length);
  let hasCore = false;
  for (let index = 0; index < solid.length; index += 1) {
    if (solid[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    let clear = true;
    for (const [stepX, stepY] of discs.erosion) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      // Off the search box counts as background: art cut by the box has been cut
      // somewhere arbitrary, and an arbitrary cut is not a core.
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height || solid[nextY * width + nextX] !== 1) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    core[index] = 1;
    hasCore = true;
  }
  if (!hasCore) return mask;

  // The hold's body is the core the bolt sits on. Where the bolt sits on a bolt
  // hole's rim, or on art thinner than the radius, it is on no core at all and
  // the largest core stands in — not a tie-break but the only anchor those holds
  // have.
  const coreVisited = new Uint8Array(core.length);
  let body: number[] = [];
  if (core[seedIndex] === 1) {
    body = floodComponent(core, width, height, seedIndex, coreVisited);
  } else {
    for (let index = 0; index < core.length; index += 1) {
      if (core[index] !== 1 || coreVisited[index] === 1) continue;
      const component = floodComponent(core, width, height, index, coreVisited);
      if (component.length > body.length) body = component;
    }
  }

  const grown = new Uint8Array(solid.length);
  for (const index of body) {
    const x = index % width;
    const y = (index - x) / width;
    for (const [stepX, stepY] of discs.dilation) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      const neighbour = nextY * width + nextX;
      if (solid[neighbour] === 1) grown[neighbour] = 1;
    }
  }
  // A body that grows back without reaching the bolt is not this hold's body, so
  // nothing is trimmed rather than trimming towards whichever lobe is biggest.
  if (grown[seedIndex] !== 1) return mask;

  const trimmed = new Uint8Array(grown.length);
  floodComponent(grown, width, height, seedIndex, trimmed);
  return trimmed;
}

/**
 * Pull the mask back off every boundary it shares with a neighbour's art.
 *
 * The partition is exact and the neck trim is exact, and this is the third
 * failure, which neither can see. Where two holds' art genuinely touches, the
 * mask ends on the midline between the two bolts — and that midline is not an
 * edge of anything, it runs through solid art. Whatever the renderer draws from
 * the silhouette then starts ON THE NEIGHBOURING HOLD: a straight cut with the
 * glow's brightest band laid along it, which reads as a wedge of the neighbour
 * belonging to the lit hold. The trim cannot catch it because a wedge joined by
 * wide contact carries a core of its own.
 *
 * So: mark every mask pixel with a neighbour-owned art pixel in its 8
 * neighbourhood, delete everything within the clearance of one, and keep the
 * component the bolt is still in. Holds whose art touches nothing have no
 * contact pixel and come back untouched, which is why the boards that do not
 * have the problem do not pay for the fix.
 */
function pullBackFromCuts(
  mask: Uint8Array,
  neighbourArt: Uint8Array,
  width: number,
  height: number,
  seedIndex: number,
  clearanceOffsets: readonly Point[],
): { mask: Uint8Array; contacted: boolean } {
  const contact: number[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    let touches = false;
    for (let stepY = -1; stepY <= 1 && !touches; stepY += 1) {
      for (let stepX = -1; stepX <= 1; stepX += 1) {
        const nextX = x + stepX;
        const nextY = y + stepY;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
        if (neighbourArt[nextY * width + nextX] === 1) {
          touches = true;
          break;
        }
      }
    }
    if (touches) contact.push(index);
  }
  if (contact.length === 0) return { mask, contacted: false };

  const kept = new Uint8Array(mask);
  for (const index of contact) {
    const x = index % width;
    const y = (index - x) / width;
    for (const [stepX, stepY] of clearanceOffsets) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      kept[nextY * width + nextX] = 0;
    }
  }
  // A hold small enough that the clearance swallows its bolt keeps its untouched
  // mask rather than collapsing.
  if (kept[seedIndex] !== 1) return { mask, contacted: true };

  const pulled = new Uint8Array(kept.length);
  floodComponent(kept, width, height, seedIndex, pulled);
  return { mask: pulled, contacted: true };
}

/** Distance from each placement to its nearest neighbour, used to size the seed disc. */
function nearestPitch(placements: ReadonlyArray<{ cx: number; cy: number }>): number[] {
  return placements.map((placement, index) => {
    let best = Infinity;
    for (const [otherIndex, other] of placements.entries()) {
      if (otherIndex === index) continue;
      const distance = (other.cx - placement.cx) ** 2 + (other.cy - placement.cy) ** 2;
      if (distance < best) best = distance;
    }
    return Number.isFinite(best) ? Math.sqrt(best) : 0;
  });
}

/**
 * Share of a polygon's perimeter lying on the search-box boundary. A real hold
 * silhouette never runs along a straight axis-aligned line for long; a trace that
 * hit the box and followed it always does.
 */
function boxEdgeShare(flat: number[], box: number): number {
  let onEdge = 0;
  let perimeter = 0;
  for (let index = 0; index < flat.length; index += 2) {
    const next = (index + 2) % flat.length;
    const length = Math.hypot(flat[next] - flat[index], flat[next + 1] - flat[index + 1]);
    perimeter += length;
    const onVertical = Math.abs(Math.abs(flat[index]) - box) <= 1 && Math.abs(Math.abs(flat[next]) - box) <= 1;
    const onHorizontal =
      Math.abs(Math.abs(flat[index + 1]) - box) <= 1 && Math.abs(Math.abs(flat[next + 1]) - box) <= 1;
    if (onVertical || onHorizontal) onEdge += length;
  }
  return perimeter === 0 ? 1 : onEdge / perimeter;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function srgbToLinear(channel: number): number {
  const normalised = channel / 255;
  return normalised <= 0.04045 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
}

function oklabLightness(red: number, green: number, blue: number): number {
  const linearRed = srgbToLinear(red);
  const linearGreen = srgbToLinear(green);
  const linearBlue = srgbToLinear(blue);
  const long = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue);
  const medium = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue);
  const short = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue);
  return 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
}

function linearLuma(red: number, green: number, blue: number): number {
  return 0.2126 * srgbToLinear(red) + 0.7152 * srgbToLinear(green) + 0.0722 * srgbToLinear(blue);
}

type BoardArt = { pixels: Buffer; width: number; height: number };

/** Alpha-weighted mean OkLab lightness over whatever pixels the caller visits. */
function accumulateLightness(art: BoardArt): { add: (x: number, y: number) => void; mean: () => number | null } {
  let weighted = 0;
  let weight = 0;
  return {
    add(x, y) {
      if (x < 0 || y < 0 || x >= art.width || y >= art.height) return;
      const offset = (y * art.width + x) * 4;
      // Alpha-weighted: a transparent gap is play field, not black art.
      const alpha = art.pixels[offset + 3] / 255;
      if (alpha === 0) return;
      weighted += oklabLightness(art.pixels[offset], art.pixels[offset + 1], art.pixels[offset + 2]) * alpha;
      weight += alpha;
    },
    mean: () => (weight === 0 ? null : roundTo(weighted / weight, LIGHTNESS_DECIMALS)),
  };
}

/**
 * Mean lightness of the art in the ring's annulus — mostly OUTSIDE the hold,
 * which is what a mark's legibility is decided against. `null` means no art
 * anywhere in the band, i.e. the ring would sit on bare play field.
 */
function measureAnnulus(art: BoardArt, centreX: number, centreY: number, radius: number): number | null {
  const inner = (radius * ANNULUS_INNER_FRACTION) ** 2;
  const outer = (radius * ANNULUS_OUTER_FRACTION) ** 2;
  const bound = Math.ceil(radius * ANNULUS_OUTER_FRACTION);

  const accumulator = accumulateLightness(art);
  for (let stepY = -bound; stepY <= bound; stepY += 1) {
    for (let stepX = -bound; stepX <= bound; stepX += 1) {
      const distance = stepX * stepX + stepY * stepY;
      if (distance < inner || distance > outer) continue;
      accumulator.add(Math.round(centreX + stepX), Math.round(centreY + stepY));
    }
  }
  return accumulator.mean();
}

/**
 * Mean lightness of the art inside a traced silhouette, by even-odd scanline fill.
 *
 * The polygon's coordinates are relative to the ROUNDED placement centre — the
 * frame the tracer emits them in — so the anchor here rounds the same way or the
 * mask walks off the hold on half the board.
 */
function measureSilhouette(art: BoardArt, centreX: number, centreY: number, outline: number[]): number | null {
  const pointCount = outline.length / 2;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 1; index < outline.length; index += 2) {
    minY = Math.min(minY, outline[index]);
    maxY = Math.max(maxY, outline[index]);
  }

  const accumulator = accumulateLightness(art);
  const crossings: number[] = [];
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y += 1) {
    crossings.length = 0;
    for (let index = 0; index < pointCount; index += 1) {
      const startX = outline[index * 2];
      const startY = outline[index * 2 + 1];
      const endIndex = (index + 1) % pointCount;
      const endX = outline[endIndex * 2];
      const endY = outline[endIndex * 2 + 1];
      // Half-open in y, so a vertex counts once and a horizontal edge drops out.
      const startsAbove = startY <= y;
      const endsAbove = endY <= y;
      if (startsAbove === endsAbove) continue;
      crossings.push(startX + ((y - startY) * (endX - startX)) / (endY - startY));
    }
    crossings.sort((left, right) => left - right);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      for (let x = Math.ceil(crossings[pair]); x <= Math.floor(crossings[pair + 1]); x += 1) {
        accumulator.add(centreX + x, centreY + y);
      }
    }
  }
  return accumulator.mean();
}

// ---------------------------------------------------------------------------
// Painted LEDs
// ---------------------------------------------------------------------------

/**
 * The white dots at the centre of Grasshopper's holds are not bolt holes, they
 * are LED locations painted into the art — and they are painted inconsistently.
 * 234 of 305 sampled Grasshopper placements have a centre more than 2.5x brighter
 * than the surrounding hold (median 10.2x), while Tension Original draws the same
 * location DARKER than the hold (median 0.29x) and Kilter draws a dark bolt hole
 * (0.42x). An unlit white dot competes with a lit mark, so the renderer takes the
 * LED over — and to cover it, it needs to know where the painter actually put it:
 * on Grasshopper the bright blob's centroid sits a median 2.2 board px off the
 * placement, which is why a dot drawn at the centre leaves a bright crescent on
 * 190 of 316 unlit holds.
 */
function findPaintedLedBlob(
  art: BoardArt,
  lumaAt: (x: number, y: number) => number | null,
  sampleDisc: (centreX: number, centreY: number, outer: number, inner?: number) => number | null,
  ledX: number,
  ledY: number,
): { offset: [number, number]; luma: number } | null {
  const anchorX = Math.round(ledX);
  const anchorY = Math.round(ledY);
  let seedX = -1;
  let seedY = -1;
  let seedLuma = LED_BLOB_LUMA_THRESHOLD;
  for (let stepY = -LED_BLOB_SEED_RADIUS; stepY <= LED_BLOB_SEED_RADIUS; stepY += 1) {
    for (let stepX = -LED_BLOB_SEED_RADIUS; stepX <= LED_BLOB_SEED_RADIUS; stepX += 1) {
      if (stepX * stepX + stepY * stepY > LED_BLOB_SEED_RADIUS * LED_BLOB_SEED_RADIUS) continue;
      const value = lumaAt(anchorX + stepX, anchorY + stepY);
      if (value === null || value < seedLuma) continue;
      seedLuma = value;
      seedX = anchorX + stepX;
      seedY = anchorY + stepY;
    }
  }
  if (seedX < 0) return null;

  const seedIndex = seedY * art.width + seedX;
  const visited = new Set<number>([seedIndex]);
  const pending = [seedIndex];
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  while (pending.length > 0) {
    const index = pending.pop();
    if (index === undefined) break;
    const x = index % art.width;
    const y = (index - x) / art.width;
    sumX += x;
    sumY += y;
    count += 1;
    for (const [stepX, stepY] of ORTHOGONAL) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (Math.abs(nextX - seedX) > LED_BLOB_MAX_RADIUS || Math.abs(nextY - seedY) > LED_BLOB_MAX_RADIUS) continue;
      const nextIndex = nextY * art.width + nextX;
      if (visited.has(nextIndex)) continue;
      const value = lumaAt(nextX, nextY);
      if (value === null || value < LED_BLOB_LUMA_THRESHOLD) continue;
      visited.add(nextIndex);
      pending.push(nextIndex);
    }
  }
  if (count === 0) return null;
  const blobX = sumX / count;
  const blobY = sumY / count;
  return {
    offset: [blobX - ledX, blobY - ledY],
    luma: sampleDisc(blobX, blobY, LED_SAMPLE_RADIUS) ?? 0,
  };
}

/**
 * Board pixels below the placement centre where the LED sits.
 *
 * MoonBoard has no LED table in `@boardsesh/board-constants` and does not need
 * one: its holds and LEDs are both on a regular grid, with the LED grid offset
 * down by half a row, so every hold maps to the LED half a cell below it.
 * DERIVED from the placement spacing rather than hardcoded — the Mini's grid is
 * a different pitch to the standard board's. Everywhere else the LED is central
 * (Grasshopper, Tension, Woods) or is the bolt hole itself (Kilter).
 */
function ledOffsetYFor(boardName: string, placements: ReadonlyArray<{ cy: number }>): number {
  if (boardName !== 'moonboard') return 0;
  const rows = [...new Set(placements.map((placement) => Math.round(placement.cy)))].sort((a, b) => a - b);
  const gaps = rows.slice(1).map((row, index) => row - rows[index]);
  gaps.sort((a, b) => a - b);
  const rowSpacing = gaps[Math.floor(gaps.length / 2)] ?? 0;
  return rowSpacing / 2;
}

// ---------------------------------------------------------------------------
// Per-config work
// ---------------------------------------------------------------------------

type ShardTables = {
  outlines: Map<number, number[]>;
  silhouetteLightness: Map<number, number>;
  ledBright: Map<number, [number, number]>;
  /**
   * LED base-plate inner boundaries, in radius units like `outlines`.
   *
   * Two sources, in this order: the automatic extractor
   * (`scripts/led-ring-extract.ts`) fills the table on the configs whose art
   * actually carries a two-tone plate, and a committed `led_inner` override then
   * REPLACES whatever it produced for that placement. Annotations are the
   * extractor's calibration ground truth, so they have to win.
   */
  ledInner: Map<number, number[]>;
};

type ConfigResult = {
  key: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  tables: ShardTables;
  wall: { mean: number; coverage: number };
  counts: { traced: number; placements: number };
  summary: string;
  report: ConfigReportRow;
  /** What the LED extractor measured, whether or not the config qualified. */
  ledRings: LedRingConfigResult & { qualified: boolean };
  elapsedMs: number;
};

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  // `-0` serialises as `-0`, which is a pointless diff against a later run that
  // happens to produce `0`.
  return rounded === 0 ? 0 : rounded;
}

/** One set's art, decoded once and resampled into board space. */
type DecodedLayer = { relativePath: string; art: BoardArt };

/**
 * Every layer of a config's art, decoded once.
 *
 * Board art is authored at assorted sizes; the placement coordinates are in
 * board space, so every layer is resampled to it here and nowhere else. Decoding
 * once is what lets a mask provider read a single set's art without paying for a
 * second pass over the files.
 */
async function decodeLayers(relativePaths: string[], width: number, height: number): Promise<DecodedLayer[]> {
  const layers: DecodedLayer[] = [];
  for (const relativePath of relativePaths) {
    const pixels = await sharp(path.join(PUBLIC_DIR, relativePath))
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    layers.push({ relativePath, art: { pixels, width, height } });
  }
  return layers;
}

/** The layers stacked bottom-to-top, which is the board a climber looks at. */
async function compositeLayers(layers: DecodedLayer[], width: number, height: number): Promise<BoardArt> {
  const rawLayer = { width, height, channels: 4 as const };
  let composite: Buffer | null = null;
  for (const layer of layers) {
    composite =
      composite === null
        ? layer.art.pixels
        : await sharp(composite, { raw: rawLayer })
            .composite([{ input: layer.art.pixels, raw: rawLayer, blend: 'over' }])
            .raw()
            .toBuffer();
  }
  if (composite === null) throw new Error('no layers');
  return { pixels: composite, width, height };
}

/** Hold substance, as a bitmap: an image's alpha channel and nothing else. */
function buildOpaqueMask(art: BoardArt, alphaFloor: number = ALPHA_FLOOR): Uint8Array {
  const opaque = new Uint8Array(art.width * art.height);
  for (let pixel = 0; pixel < art.width * art.height; pixel += 1) {
    opaque[pixel] = art.pixels[pixel * 4 + 3] >= alphaFloor ? 1 : 0;
  }
  return opaque;
}

/** The raw alpha plane, kept beside the binary mask for sub-pixel isoline snapping. */
function extractAlphaPlane(art: BoardArt): Uint8Array {
  const alpha = new Uint8Array(art.width * art.height);
  for (let pixel = 0; pixel < art.width * art.height; pixel += 1) {
    alpha[pixel] = art.pixels[pixel * 4 + 3];
  }
  return alpha;
}

// ---------------------------------------------------------------------------
// The mask-provider seam
// ---------------------------------------------------------------------------

/**
 * One image's worth of hold substance, with the placements that live in it and
 * the nearest-placement partition over them.
 *
 * The tracer below reads NOTHING else — no alpha channel, no sharp, no file
 * paths. That is the point of the seam: what counts as "hold substance" is a
 * decision about the art and belongs to whoever decoded it, while the
 * flood/trim/pullback/border pipeline is a decision about geometry and should be
 * replaceable without touching it.
 */
type TraceField = {
  /** Which art the mask came from. Reports and error messages only. */
  sourceKey: string;
  width: number;
  height: number;
  /** 1 = hold substance, 0 = not. */
  mask: Uint8Array;
  /**
   * The placements this field owns and traces. Every placement id is in at most
   * one field, counting `aliasesOf` — a field traces `placements` and emits under
   * `placements` plus every alias.
   */
  placements: RenderableHold[];
  /** Pixel -> index into `placements`; -1 where no placement owns the pixel. */
  label: Int32Array;
  /**
   * Half-width of the search box for this field, in placement radii.
   *
   * Per field rather than one constant, because it is a property of the ART: a
   * sprite sheet's holds are small against their bolt pitch and a photographed
   * wall's are not. Transparent-art fields use `SEARCH_RADII`; a keyed
   * photographic field uses `PHOTO_SEARCH_RADII`.
   */
  searchRadii: number;
  /**
   * Canonical placement id -> the other placements sharing its centre, which the
   * canonical is traced FOR and whose ids the outline is emitted under.
   *
   * Empty for every transparent-art field. See `mergeCoincidentPlacements`: two
   * bolts inside one hold split it down the midline between them, and where both
   * round to the same board pixel the partition cannot even seed the second one.
   */
  aliasesOf: Map<number, RenderableHold[]>;
  /** Which edge the silhouette follows — see `TracerProfile`. */
  profile: TracerProfile;
  /**
   * The layer's raw alpha plane, present only when `profile.snapToAlpha` asks
   * for it. The binary mask stays the tracer's substance; this is the continuous
   * field the border is refined against. A keyed photographic mask has no alpha
   * to read, so the photo provider never carries one.
   */
  alpha?: Uint8Array;
};

/**
 * How a config's decoded art becomes fields to trace.
 *
 * Deliberately takes the LAYERS and not the composite. Every colour reading in
 * this script measures the composite, because what a mark has to be legible
 * against is the stack a climber sees; what a hold's silhouette is, is a
 * question about the one image that draws it.
 */
type MaskProvider = (details: BoardRenderDetails, layers: DecodedLayer[]) => TraceField[];

/**
 * Which art layer draws each placement, as an index into the layer list.
 *
 * `-1` for a placement no layer draws — MoonBoard's grid has cells that carry no
 * hold in any set, and those have nothing to trace on any image.
 *
 * The index is the position in `images_to_holds`, because `getBackgroundRelPaths`
 * walks exactly those keys in exactly that order, so key `i` is layer `i`.
 *
 * Aurora boards state it outright: `images_to_holds` IS image -> hold tuples, so
 * the map is that relation inverted. MoonBoard's map has empty values (its
 * geometry is a synthetic grid, not a per-image placement table), so the routing
 * goes through `MOONBOARD_CELL_SETS`: grid cell -> hold set -> that set's image.
 *
 * A placement drawn by two layers would make the disjoint-union contract a lie,
 * so it is asserted rather than assumed. No config in the catalogue has one.
 */
function placementFieldIndex(details: BoardRenderDetails): Map<number, number> {
  const imageKeys = Object.keys(details.images_to_holds);
  const fieldOf = new Map<number, number>();

  if (details.board_name === 'moonboard') {
    const layoutEntry = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === details.layout_id);
    if (layoutEntry === undefined) throw new Error(`moonboard layout ${details.layout_id} has no entry`);
    const sets = MOONBOARD_SETS[layoutEntry[0] as keyof typeof MOONBOARD_SETS] ?? [];
    const layerOfSet = new Map<number, number>();
    for (const set of sets) {
      const index = imageKeys.indexOf(`${details.layoutFolder}/${set.imageFile}`);
      // A set the config did not mount has no layer, which is not an error: the
      // shard is traced with every set of the layout, but the lookup is by name.
      if (index >= 0) layerOfSet.set(set.id, index);
    }
    const cells = MOONBOARD_CELL_SETS[details.layout_id] ?? {};
    for (const placement of details.holdsData) {
      const setId = cells[placement.id];
      const index = setId === undefined ? undefined : layerOfSet.get(setId);
      fieldOf.set(placement.id, index ?? -1);
    }
    return fieldOf;
  }

  for (const [index, imageKey] of imageKeys.entries()) {
    for (const [holdId] of details.images_to_holds[imageKey]) {
      const existing = fieldOf.get(holdId);
      if (existing !== undefined && existing !== index) {
        throw new Error(`placement ${holdId} is drawn by two layers (${imageKeys[existing]} and ${imageKey})`);
      }
      fieldOf.set(holdId, index);
    }
  }
  // A board that states no routing at all but ships ONE image has an unambiguous
  // one: that image draws every placement. Woods is the case — like MoonBoard its
  // `images_to_holds` carries a key with an empty value, because its geometry is a
  // detected hold table rather than Aurora's per-image tuples — and without this
  // every one of its placements routes to no layer and falls back to a ring. The
  // guard is on an EMPTY map rather than on a board name, so it cannot quietly
  // re-route a board that does state its layers: all 49 transparent-art configs
  // fill this map from real tuples and never reach here.
  if (fieldOf.size === 0 && imageKeys.length === 1) {
    for (const placement of details.holdsData) fieldOf.set(placement.id, 0);
    return fieldOf;
  }
  for (const placement of details.holdsData) {
    if (!fieldOf.has(placement.id)) fieldOf.set(placement.id, -1);
  }
  return fieldOf;
}

/**
 * One field per art layer: each set's own alpha channel, partitioned only over
 * the placements that set draws.
 *
 * WHY NOT THE COMPOSITE
 * ---------------------
 * The composite is what a climber sees, and it is the wrong thing to trace
 * against. Two holds from different sets are mounted in different bolt holes and
 * their art overlaps by almost nothing (0.06% of opaque pixels catalogue-wide),
 * but on the composite they touch — and "touching" is what drives the whole
 * chopping machinery. On Kilter Homewall 12x12, 439 of 499 placements are
 * art-adjacent to a differently-labelled hold on the composite and only 64 are
 * when each layer is measured on its own. The other 375 were being cut apart at
 * a boundary that only exists because two sets were stacked into one bitmap.
 *
 * Every colour measurement stays on the composite, because those measure what
 * the mark has to be legible against, which is the stack.
 */
const perImageMaskProvider: MaskProvider = (details, layers) => {
  const fieldOf = placementFieldIndex(details);
  const profile = profileFor(details.board_name, details.layout_id);
  const perLayer: RenderableHold[][] = layers.map(() => []);
  for (const placement of details.holdsData) {
    const index = fieldOf.get(placement.id) ?? -1;
    if (index >= 0) perLayer[index].push(placement);
  }

  const fields: TraceField[] = [];
  for (const [index, layer] of layers.entries()) {
    const placements = perLayer[index];
    // A layer nothing is placed on — MoonBoard's wall photograph — is not a
    // field. There is no partition to build and nothing to trace.
    if (placements.length === 0) continue;
    fields.push({
      sourceKey: layer.relativePath,
      width: layer.art.width,
      height: layer.art.height,
      mask: buildOpaqueMask(layer.art, profile.alphaFloor),
      placements,
      label: buildLabelMap(layer.art.width, layer.art.height, placements),
      searchRadii: SEARCH_RADII,
      aliasesOf: new Map(),
      profile,
      alpha: profile.snapToAlpha === null ? undefined : extractAlphaPlane(layer.art),
    });
  }
  return fields;
};

/** One photographic layer's recovered hold substance, keyed off its white ground. */
type KeyedPhotoLayer = {
  /** The lossless source the mask was keyed from — a `.png` sibling of the shipped art. */
  relativePath: string;
  /** 1 = hold substance, 0 = board ground. Board-sized, never resampled. */
  mask: Uint8Array;
  groundShare: number;
  maskShare: number;
};

/**
 * One field per photographic layer: the white-keyed mask in place of an alpha
 * channel, over the placements that layer draws, with coincident placements
 * merged into one seed.
 *
 * A factory rather than a plain `MaskProvider` because the mask does not come
 * from the decoded layers the seam hands over: it is keyed from the LOSSLESS
 * `.png` sibling of the shipped art. Keying the shipped `.webp` instead
 * disagrees on 0.30% of pixels — compression ringing around every hold edge,
 * which is speckle the tracer would then have to survive. The colour tables still
 * measure the shipped composite, because that is what a climber sees.
 *
 * The MERGE is what a photographed board needs and a sprite sheet does not. Woods
 * lists pairs of placements 0-2 board pixels apart (the same physical hold at two
 * bolt orientations). Seed the partition with both and it cuts that one hold in
 * half down the midline between them; where the pair rounds to the same board
 * pixel the second one gets no seed at all and silently falls back to a ring. One
 * group is one seed, one trace, and one outline emitted under every member id —
 * which is what is on the wall.
 */
function photoMaskProvider(keyedLayers: KeyedPhotoLayer[]): MaskProvider {
  return (details, layers) => {
    const fieldOf = placementFieldIndex(details);
    const perLayer: RenderableHold[][] = layers.map(() => []);
    for (const placement of details.holdsData) {
      const index = fieldOf.get(placement.id) ?? -1;
      if (index >= 0) perLayer[index].push(placement);
    }

    const fields: TraceField[] = [];
    for (const [index, layer] of layers.entries()) {
      const drawn = perLayer[index];
      if (drawn.length === 0) continue;
      const keyed = keyedLayers[index];

      const groups = mergeCoincidentPlacements(drawn);
      const byId = new Map(drawn.map((placement) => [placement.id, placement]));
      // Every id a group names came out of `drawn`, so this cannot miss — which
      // is a reason to state the invariant rather than cast past the compiler.
      // A grouping that ever returned an id it was not given would otherwise
      // ship `undefined` into the label map and fail somewhere unrecognisable.
      const placementFor = (id: number): RenderableHold => {
        const placement = byId.get(id);
        if (placement === undefined) throw new Error(`coincident group names ${id}, which this layer does not draw`);
        return placement;
      };

      // Walked in PLACEMENT order rather than group-discovery order, so the label
      // map's index ties resolve the way they would without a merge. Only a
      // group's canonical has a `membersOf` entry, so this picks exactly the
      // canonicals and needs no sort afterwards.
      const canonicals: RenderableHold[] = [];
      const aliasesOf = new Map<number, RenderableHold[]>();
      for (const placement of drawn) {
        const memberIds = groups.membersOf.get(placement.id);
        if (memberIds === undefined) continue;
        canonicals.push(placement);
        if (memberIds.length > 1) {
          aliasesOf.set(placement.id, memberIds.filter((id) => id !== placement.id).map(placementFor));
        }
      }

      fields.push({
        sourceKey: keyed.relativePath,
        width: layer.art.width,
        height: layer.art.height,
        mask: keyed.mask,
        placements: canonicals,
        label: buildLabelMap(layer.art.width, layer.art.height, canonicals),
        searchRadii: PHOTO_SEARCH_RADII,
        aliasesOf,
        // A keyed mask is binary substance with no alpha ramp behind it — there
        // is no isoline to snap to, so the photographic path stays on the
        // default profile whatever the board's sprite profile says.
        profile: DEFAULT_TRACER_PROFILE,
      });
    }
    return fields;
  };
}

/**
 * What one placement's trace cost, for the report and for gate 7.
 *
 * `cellAlphaArea` is the denominator: the seed's own 4-connected art body inside
 * the search box, taken from this placement's partition cell before any trim,
 * pullback or simplification. `tracedArea` is what survived to the emitted mask.
 * Their ratio is the only number that says whether the silhouette is still the
 * hold's shape or a fragment of it — perimeter measures and spur opens both read
 * fine on a hold that simply lost half of itself to a cut.
 *
 * The CONNECTED body, not the whole cell. A partition cell routinely contains
 * art that was never this hold's: a neighbouring macro's rim can sit closer to
 * this bolt than to its own and land in the cell without ever touching the hold.
 * Counting it read as a chop on 145 of 181 holds the tracer had removed nothing
 * from.
 */
type HoldTraceStats = {
  holdId: number;
  traced: boolean;
  /** Board px² of the emitted mask. 0 when the placement fell back to a ring. */
  tracedArea: number;
  /** Board px² of the seed's connected art body in this placement's cell, pre-trim. */
  cellAlphaArea: number;
  /** `tracedArea / cellAlphaArea`, or 0 when there was no art to recover. */
  areaRecovery: number;
  /** Board px² the neck trim and the pullback dropped between them. */
  droppedArea: number;
  pulledBack: boolean;
  /** Why the placement carries no outline, or `null` when it does. */
  fallbackReason:
    | 'search-box-degenerate'
    | 'no-art-of-its-own'
    | 'perimeter-too-short'
    | 'traced-the-box'
    | 'self-intersecting'
    | null;
};

/** The counters the run's one-line summary is built from, per field. */
type TraceCounts = {
  attempted: number;
  rejectedBox: number;
  rejectedCrossing: number;
  neckTrimmed: number;
  pulledBack: number;
};

/**
 * Trace every placement in one field.
 *
 * Provider-agnostic by construction: the only inputs are the field's mask, its
 * partition and its placements, so what the mask MEANS — a composited alpha
 * channel, one set's layer, something else entirely — is not this function's
 * business.
 */
function traceOutlines(field: TraceField): {
  outlines: Map<number, number[]>;
  stats: Map<number, HoldTraceStats>;
  counts: TraceCounts;
} {
  const {
    width: boardWidth,
    height: boardHeight,
    mask: opaque,
    label,
    placements,
    searchRadii,
    aliasesOf,
    profile,
    alpha,
  } = field;
  const pitches = nearestPitch(placements);
  // Cached per distinct radius: a config's placements almost always share one
  // (`r` is `xSpacing * 4`), and building the discs is O(radius²).
  const discCache = new Map<number, { erosion: Point[]; dilation: Point[] }>();
  const discsFor = (placementRadius: number) => {
    const radius = radiusForPlacement(placementRadius);
    const cached = discCache.get(radius);
    if (cached !== undefined) return cached;
    const built = discOffsets(radius);
    discCache.set(radius, built);
    return built;
  };

  const outlines = new Map<number, number[]>();
  const stats = new Map<number, HoldTraceStats>();
  let attempted = 0;
  let rejectedBox = 0;
  let rejectedCrossing = 0;
  let neckTrimmed = 0;
  let pulledBack = 0;

  // A coincident group falls back or traces as one: every member gets the same
  // verdict, because there is one hold under all of them.
  const recordFallback = (
    groupIds: readonly number[],
    reason: NonNullable<HoldTraceStats['fallbackReason']>,
    cellArea: number,
  ) => {
    for (const holdId of groupIds) {
      stats.set(holdId, {
        holdId,
        traced: false,
        tracedArea: 0,
        cellAlphaArea: cellArea,
        areaRecovery: 0,
        droppedArea: 0,
        pulledBack: false,
        fallbackReason: reason,
      });
    }
  };

  const attemptedIds = new Set<number>();
  for (const [placementIndex, placement] of placements.entries()) {
    // Guarded on the outline table, not on `stats`: a board can list the same
    // placement under two sets, and where the first attempt fell back the second
    // is retried exactly as it always was. `stats` is overwritten to match.
    if (outlines.has(placement.id)) continue;
    const aliases = aliasesOf.get(placement.id) ?? [];
    const groupIds = [placement.id, ...aliases.map((alias) => alias.id)];
    // Counted per PLACEMENT, not per attempt. A duplicate id whose first attempt
    // fell back is retried, and counting the retry would make the summary's
    // denominator larger than the board has placements. An alias counts as its
    // own placement, because the board has one.
    for (const holdId of groupIds) {
      if (attemptedIds.has(holdId)) continue;
      attemptedIds.add(holdId);
      attempted += 1;
    }
    const centreX = Math.round(placement.cx);
    const centreY = Math.round(placement.cy);
    const box = Math.round(placement.r * searchRadii);

    const left = Math.max(0, centreX - box);
    const top = Math.max(0, centreY - box);
    const right = Math.min(boardWidth - 1, centreX + box);
    const bottom = Math.min(boardHeight - 1, centreY + box);
    if (right <= left || bottom <= top) {
      recordFallback(groupIds, 'search-box-degenerate', 0);
      continue;
    }
    const localWidth = right - left + 1;
    const localHeight = bottom - top + 1;

    // The mask is this placement's own territory only: opaque art whose nearest
    // placement is this one. Everything else opaque in the box is a neighbour's
    // art, and `pullBackFromCuts` needs it by name — the two masks are
    // complementary only INSIDE the art, so a hold's own background cannot be
    // told from a neighbour's without keeping both.
    const local = new Uint8Array(localWidth * localHeight);
    const neighbourArt = new Uint8Array(localWidth * localHeight);
    for (let y = 0; y < localHeight; y += 1) {
      for (let x = 0; x < localWidth; x += 1) {
        const global = (top + y) * boardWidth + (left + x);
        if (opaque[global] !== 1) continue;
        if (label[global] === placementIndex) local[y * localWidth + x] = 1;
        else neighbourArt[y * localWidth + x] = 1;
      }
    }
    // Seed strictly near the placement, never "nearest filled pixel in the box",
    // and never further out than the placement's own radius even on a layer so
    // sparse that its nearest-neighbour pitch spans half the board.
    const seedRadius = Math.max(
      MIN_SEED_RADIUS,
      Math.min(pitches[placementIndex] * SEED_PITCH_FRACTION, placement.r * SEED_MAX_RADII),
    );
    const localCentre: Point = [centreX - left, centreY - top];
    let seed: Point | null = null;
    let bestDistance = Infinity;
    const seedBound = Math.ceil(seedRadius);
    for (let stepY = -seedBound; stepY <= seedBound; stepY += 1) {
      for (let stepX = -seedBound; stepX <= seedBound; stepX += 1) {
        const distance = stepX * stepX + stepY * stepY;
        if (distance > seedRadius * seedRadius || distance >= bestDistance) continue;
        const x = localCentre[0] + stepX;
        const y = localCentre[1] + stepY;
        if (x < 0 || y < 0 || x >= localWidth || y >= localHeight) continue;
        if (local[y * localWidth + x] !== 1) continue;
        bestDistance = distance;
        seed = [x, y];
      }
    }
    // No art of its own under the placement: emit nothing and let the renderer
    // fall back to a ring. On the synthetic MoonBoard grids this is the honest
    // answer for most cells.
    if (seed === null) {
      recordFallback(groupIds, 'no-art-of-its-own', 0);
      continue;
    }

    const seedIndex = seed[1] * localWidth + seed[0];

    // The sprite-aware path: flood the seed over ALL art in the box, labels
    // ignored. A component that contains no other placement's centre is one
    // hold's own sprite — it ships whole (holes filled, since only the outer
    // border is emitted), skipping partition clipping, neck trim and pullback,
    // none of which have anything legitimate to cut on an uncontested sprite.
    // The cut machinery below stays exactly as it was for components genuinely
    // shared between placements, and for every board still on the default
    // profile.
    let uncontestedSprite: Uint8Array | null = null;
    let uncontestedArea = 0;
    if (profile.contestedCutsOnly) {
      const boxArt = new Uint8Array(localWidth * localHeight);
      for (let y = 0; y < localHeight; y += 1) {
        for (let x = 0; x < localWidth; x += 1) {
          if (opaque[(top + y) * boardWidth + (left + x)] === 1) boxArt[y * localWidth + x] = 1;
        }
      }
      const sprite = new Uint8Array(localWidth * localHeight);
      floodComponent(boxArt, localWidth, localHeight, seedIndex, sprite);
      // Contested is asked of the FILLED sprite, not the raw component. The
      // component itself never touches a neighbour's centre, but a sprite that
      // curls AROUND one (two TB2 12x12 Wide rails do) encloses it the moment
      // the holes are filled — and an outline swallowing another placement is
      // exactly what gate 2 forbids. Encirclement is contention: those two go
      // through the partition cut like any genuinely shared component.
      const filledSprite = fillMaskHoles(sprite, localWidth, localHeight);
      let contested = false;
      for (const other of placements) {
        if (groupIds.includes(other.id)) continue;
        const otherX = Math.round(other.cx) - left;
        const otherY = Math.round(other.cy) - top;
        if (otherX < 0 || otherY < 0 || otherX >= localWidth || otherY >= localHeight) continue;
        if (filledSprite[otherY * localWidth + otherX] === 1) {
          contested = true;
          break;
        }
      }
      if (!contested) {
        for (let index = 0; index < sprite.length; index += 1) uncontestedArea += sprite[index];
        uncontestedSprite = filledSprite;
      }
    }

    let cellAlphaArea: number;
    let traced: Uint8Array;
    let droppedArea = 0;
    let contacted = false;
    if (uncontestedSprite !== null) {
      cellAlphaArea = uncontestedArea;
      traced = uncontestedSprite;
    } else {
      const region = new Uint8Array(localWidth * localHeight);
      floodComponent(local, localWidth, localHeight, seedIndex, region);
      // The denominator, and it is the seed's own connected art body — NOT every
      // cell pixel in the box. A placement's partition cell routinely contains art
      // that was never this hold's to keep: a neighbouring macro's rim can lie
      // closer to this bolt than to its own, and it lands in the cell without ever
      // touching the hold. Counting it made 145 of 181 "chopped" holds
      // catalogue-wide holds the tracer had removed nothing from at all
      // (grasshopper/1-4's 293 read 0.250 with a droppedArea of zero).
      cellAlphaArea = 0;
      for (let index = 0; index < region.length; index += 1) cellAlphaArea += region[index];

      const discs = discsFor(placement.r);
      const trimmed = trimThinNecks(region, localWidth, localHeight, seedIndex, discs);
      const pulled = pullBackFromCuts(trimmed, neighbourArt, localWidth, localHeight, seedIndex, discs.dilation);
      // Trim again, because the pullback makes necks of its own: a hold in contact
      // along two sides comes back joined through whatever the two clearance discs
      // left between them. Thirteen outlines on two boards failed gate 5 with a
      // single trim, and every one was a sliver the first trim never saw because it
      // did not exist yet.
      traced = pulled.contacted ? trimThinNecks(pulled.mask, localWidth, localHeight, seedIndex, discs) : pulled.mask;
      contacted = pulled.contacted;

      for (let index = 0; index < region.length; index += 1) {
        if (region[index] === 1 && traced[index] !== 1) droppedArea += 1;
      }
    }
    let tracedArea = 0;
    for (let index = 0; index < traced.length; index += 1) tracedArea += traced[index];

    // Row-major, so the first filled pixel is the topmost-leftmost one — where
    // the Moore follower has to start.
    let topmost = seed;
    for (let index = 0; index < traced.length; index += 1) {
      if (traced[index] !== 1) continue;
      const x = index % localWidth;
      topmost = [x, (index - x) / localWidth];
      break;
    }

    const border = traceBorder(traced, localWidth, localHeight, topmost);
    if (border.length < MIN_PERIMETER_POINTS) {
      recordFallback(groupIds, 'perimeter-too-short', cellAlphaArea);
      continue;
    }
    // The crisp path refines the border to the alpha isoline and simplifies
    // one-sidedly; the default path is the historical trace, byte for byte.
    // Crisp runs a deterministic retry ladder — snapped one-sided, unsnapped
    // one-sided, classic — so one pathological border degrades a rung at a time
    // instead of falling straight to a ring, and gate 4's counts hold still.
    const crisp = profile.snapToAlpha !== null && alpha !== undefined;
    let flat: number[];
    if (crisp) {
      const epsilonOut = profile.outwardEpsilon ?? profile.simplifyEpsilon;
      const snapped = snapBorderToIsoline(
        border,
        alpha,
        boardWidth,
        boardHeight,
        left,
        top,
        profile.snapToAlpha as number,
        profile.insetPx,
      );
      const candidates: { points: Point[]; rounded: boolean }[] = [
        { points: simplifyInwardOnly(snapped, profile.simplifyEpsilon, epsilonOut), rounded: false },
        { points: simplifyInwardOnly(border, profile.simplifyEpsilon, epsilonOut), rounded: false },
        { points: simplify(border, SIMPLIFY_EPSILON), rounded: true },
      ];
      let chosen: number[] | null = null;
      for (const candidate of candidates) {
        const candidateFlat: number[] = [];
        for (const [x, y] of candidate.points) {
          candidateFlat.push(
            candidate.rounded ? Math.round(left + x - centreX) : left + x - centreX,
            candidate.rounded ? Math.round(top + y - centreY) : top + y - centreY,
          );
        }
        const candidateRing: Point[] = [];
        for (let index = 0; index < candidateFlat.length; index += 2) {
          candidateRing.push([candidateFlat[index], candidateFlat[index + 1]]);
        }
        if (!isSimpleRing(candidateRing)) continue;
        chosen = candidateFlat;
        break;
      }
      if (chosen === null) {
        rejectedCrossing += 1;
        recordFallback(groupIds, 'self-intersecting', cellAlphaArea);
        continue;
      }
      if (boxEdgeShare(chosen, box) > MAX_BOX_EDGE_SHARE) {
        rejectedBox += 1;
        recordFallback(groupIds, 'traced-the-box', cellAlphaArea);
        continue;
      }
      flat = chosen;
    } else {
      const simplified = simplify(border, profile.simplifyEpsilon);
      flat = [];
      for (const [x, y] of simplified) {
        flat.push(Math.round(left + x - centreX), Math.round(top + y - centreY));
      }
      // Backstop: a trace that ran into the search box and followed it is not a
      // silhouette, whatever it looks like.
      if (boxEdgeShare(flat, box) > MAX_BOX_EDGE_SHARE) {
        rejectedBox += 1;
        recordFallback(groupIds, 'traced-the-box', cellAlphaArea);
        continue;
      }
      // Backstop for the defect the neck trim exists to prevent, kept because the
      // trim is a fix and this is a proof — the same pairing
      // `segmentation/led-ring.ts` already makes for the LED plate's inner ring.
      //
      // A 1-pixel isthmus the trim did not take makes the border follower walk out
      // along one side of a limb and back along the other, and Douglas-Peucker
      // then replaces that round trip with a pair of segments that cross. The
      // result is not a silhouette a renderer can fill: even-odd fill punches the
      // overlap out, so the mark would show a hole where the hold is solid.
      //
      // Every sprite-sheet board's outlines are simple, so this changes nothing
      // for them. It rejects two of Woods' 1,337, both slivers of a hold its
      // detector put several centres on — see `WOODS_GEOMETRY` in
      // `@boardsesh/board-config`. A ring at the placement radius is the honest
      // answer for those, and it is the same fallback an untraceable hold takes.
      const ring: Point[] = [];
      for (let index = 0; index < flat.length; index += 2) ring.push([flat[index], flat[index + 1]]);
      if (!isSimpleRing(ring)) {
        rejectedCrossing += 1;
        recordFallback(groupIds, 'self-intersecting', cellAlphaArea);
        continue;
      }
    }
    // Counted here, not where it was measured: an outline that then fell back is
    // not in the table, and the gates measure the table.
    if (droppedArea > NOTABLE_TRIM_AREA) neckTrimmed += 1;
    if (contacted) pulledBack += 1;
    outlines.set(placement.id, flat);
    stats.set(placement.id, {
      holdId: placement.id,
      traced: true,
      tracedArea,
      cellAlphaArea,
      areaRecovery: cellAlphaArea === 0 ? 0 : tracedArea / cellAlphaArea,
      droppedArea,
      pulledBack: contacted,
      fallbackReason: null,
    });
    // The group's members share the hold, so they share the silhouette —
    // RE-ANCHORED to each one's own rounded centre, because that is the frame
    // `measureConfig` divides by the radius in. The shift is 0-2 board pixels by
    // construction, and re-anchoring rather than reusing the canonical's numbers
    // is what keeps gate 1 (an outline sits on its own placement) true for both.
    for (const alias of aliases) {
      const shiftX = centreX - Math.round(alias.cx);
      const shiftY = centreY - Math.round(alias.cy);
      outlines.set(
        alias.id,
        flat.map((value, index) => value + (index % 2 === 0 ? shiftX : shiftY)),
      );
      stats.set(alias.id, { ...(stats.get(placement.id) as HoldTraceStats), holdId: alias.id });
    }
  }

  // No area backstop. Before the partition, a flood fill could walk through a
  // contact patch into the neighbouring hold, and an "area far above the board
  // median" rule was the only way to catch it. After it, a region is by
  // construction made only of pixels whose nearest placement is this one, so a
  // merge is not expressible — and the rule was deleting real outlines: on
  // Grasshopper it took 14, all of them the board's genuinely large square holds.
  return { outlines, stats, counts: { attempted, rejectedBox, rejectedCrossing, neckTrimmed, pulledBack } };
}

/**
 * Every field's trace, as one config's tables.
 *
 * The union is disjoint by the field contract — each placement id lives in at
 * most one field — and asserted rather than assumed, because a provider that
 * handed the same hold to two images would silently emit whichever traced last.
 * Placements no field claims are recorded as fallbacks here: a hold whose set
 * carries no art for it has none to trace, which is the same answer the
 * composite gave when it found nothing under the bolt.
 */
function mergeFieldTraces(
  fields: TraceField[],
  allPlacements: RenderableHold[],
): { outlines: Map<number, number[]>; stats: Map<number, HoldTraceStats>; summary: string } {
  const outlines = new Map<number, number[]>();
  const stats = new Map<number, HoldTraceStats>();
  const totals: TraceCounts = { attempted: 0, rejectedBox: 0, rejectedCrossing: 0, neckTrimmed: 0, pulledBack: 0 };

  for (const field of fields) {
    const traced = traceOutlines(field);
    for (const [holdId, flat] of traced.outlines) {
      if (outlines.has(holdId)) throw new Error(`placement ${holdId} traced by two fields (${field.sourceKey})`);
      outlines.set(holdId, flat);
    }
    for (const [holdId, entry] of traced.stats) stats.set(holdId, entry);
    totals.attempted += traced.counts.attempted;
    totals.rejectedBox += traced.counts.rejectedBox;
    totals.rejectedCrossing += traced.counts.rejectedCrossing;
    totals.neckTrimmed += traced.counts.neckTrimmed;
    totals.pulledBack += traced.counts.pulledBack;
  }

  for (const placement of allPlacements) {
    if (stats.has(placement.id)) continue;
    totals.attempted += 1;
    stats.set(placement.id, {
      holdId: placement.id,
      traced: false,
      tracedArea: 0,
      cellAlphaArea: 0,
      areaRecovery: 0,
      droppedArea: 0,
      pulledBack: false,
      fallbackReason: 'no-art-of-its-own',
    });
  }

  const missing = totals.attempted - outlines.size;
  const summary =
    `${outlines.size}/${totals.attempted} traced ` +
    `(${missing} fell back: ${totals.rejectedBox} hit the search box, ` +
    // Only mentioned where it happened. This line is the header comment on every
    // shard, so an unconditional "0 crossed themselves" would rewrite all 51
    // files to say nothing had gone wrong on any of them.
    (totals.rejectedCrossing > 0 ? `${totals.rejectedCrossing} crossed themselves, ` : '') +
    `${missing - totals.rejectedBox - totals.rejectedCrossing} had no art of their own; ` +
    `${totals.neckTrimmed} lost more than ${NOTABLE_TRIM_AREA} px² to the neck trim and the pullback together; ` +
    `${totals.pulledBack} pulled back off a neighbour's art)`;
  return { outlines, stats, summary };
}

// ---------------------------------------------------------------------------
// Report (`--report=<dir>`)
// ---------------------------------------------------------------------------

/**
 * What one config's trace looks like in aggregate. Written to the report's
 * `summary.txt`, and the row a before/after run is compared on.
 */
type ConfigReportRow = {
  key: string;
  placements: number;
  traced: number;
  pulledBack: number;
  chopped: number;
  recoveryMean: number;
  recoveryP10: number;
  recoveryMin: number;
};

/** Ground the report paints the art on, so a transparent gutter is visibly a gutter. */
const REPORT_BACKDROP = '#141414';
const REPORT_STROKE_TRACED = '#33FF99';
const REPORT_STROKE_PULLED_BACK = '#FFB000';
const REPORT_STROKE_CHOPPED = '#FF2D55';
const REPORT_STROKE_UNTRACED = '#8A8A8A';
/**
 * The extracted LED base plate's inner edge. Cyan because it has to be told
 * apart from all four silhouette states at a glance on the same sheet, and
 * nothing else on the board art is that colour — the plate itself is beige.
 */
const REPORT_STROKE_LED_INNER = '#00D4FF';
/** Board pixels of backdrop between the two halves of a `--report-crop` image. */
const REPORT_CROP_GUTTER = 8;

/** A `--report-crop=x,y,size` region, in board pixels. */
type ReportCrop = { left: number; top: number; width: number; height: number };

function reportRowFor(key: string, placementCount: number, stats: Map<number, HoldTraceStats>): ConfigReportRow {
  const recoveries = [...stats.values()].filter((entry) => entry.traced).map((entry) => entry.areaRecovery);
  recoveries.sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    recoveries.length === 0 ? 0 : recoveries[Math.min(recoveries.length - 1, Math.floor(fraction * recoveries.length))];
  return {
    key,
    placements: placementCount,
    traced: recoveries.length,
    pulledBack: [...stats.values()].filter((entry) => entry.pulledBack).length,
    chopped: recoveries.filter((value) => value < MIN_AREA_RECOVERY).length,
    recoveryMean:
      recoveries.length === 0 ? 0 : recoveries.reduce((total, value) => total + value, 0) / recoveries.length,
    recoveryP10: percentile(0.1),
    recoveryMin: recoveries.length === 0 ? 0 : recoveries[0],
  };
}

/**
 * The board art with every traced silhouette stroked on it, plus a per-hold
 * metric table beside it.
 *
 * The picture is the point: an area ratio says a hold lost a third of itself,
 * and only the picture says whether the third it lost was a neighbour's rim it
 * should never have had or the hold's own jug.
 */
async function writeConfigReport(
  reportDir: string,
  row: ConfigReportRow,
  art: BoardArt,
  placements: RenderableHold[],
  outlines: Map<number, number[]>,
  stats: Map<number, HoldTraceStats>,
  ledInnerBoardPx: ReadonlyMap<number, number[]>,
  crop: ReportCrop | null,
): Promise<void> {
  const shapes: string[] = [];
  const seen = new Set<number>();
  for (const placement of placements) {
    if (seen.has(placement.id)) continue;
    seen.add(placement.id);
    const flat = outlines.get(placement.id);
    if (flat === undefined) {
      shapes.push(
        `<circle cx="${placement.cx.toFixed(1)}" cy="${placement.cy.toFixed(1)}" r="${placement.r.toFixed(1)}" ` +
          `fill="none" stroke="${REPORT_STROKE_UNTRACED}" stroke-width="1" stroke-dasharray="4 4"/>`,
      );
      continue;
    }
    const holdStats = stats.get(placement.id);
    const stroke =
      holdStats !== undefined && holdStats.areaRecovery < MIN_AREA_RECOVERY
        ? REPORT_STROKE_CHOPPED
        : holdStats !== undefined && holdStats.pulledBack
          ? REPORT_STROKE_PULLED_BACK
          : REPORT_STROKE_TRACED;
    const centreX = Math.round(placement.cx);
    const centreY = Math.round(placement.cy);
    const points: string[] = [];
    for (let index = 0; index < flat.length; index += 2) {
      points.push(`${centreX + flat[index]},${centreY + flat[index + 1]}`);
    }
    shapes.push(`<polygon points="${points.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);

    // Drawn after the silhouette so it sits on top where the two nearly meet —
    // on a hold whose plate is a hairline along the lit top edge, that is the
    // only place the pair is distinguishable at sheet scale.
    const ledInner = ledInnerBoardPx.get(placement.id);
    if (ledInner === undefined) continue;
    const ledPoints: string[] = [];
    for (let index = 0; index < ledInner.length; index += 2) {
      ledPoints.push(`${centreX + ledInner[index]},${centreY + ledInner[index + 1]}`);
    }
    shapes.push(
      `<polygon points="${ledPoints.join(' ')}" fill="none" stroke="${REPORT_STROKE_LED_INNER}" stroke-width="1"/>`,
    );
  }

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${art.width}" height="${art.height}">${shapes.join('')}</svg>`,
  );
  const imagePath = path.join(reportDir, `${row.key}.png`);
  mkdirSync(path.dirname(imagePath), { recursive: true });
  const flat = sharp(art.pixels, { raw: { width: art.width, height: art.height, channels: 4 } })
    .flatten({ background: REPORT_BACKDROP })
    .png();
  await flat
    .clone()
    .composite([{ input: overlay }])
    .toFile(imagePath);

  // The sheet is a whole 1080x1920 board and a base plate is a few pixels wide,
  // so the sheet alone cannot answer "is the cyan line on the right edge". The
  // crop is the same region twice, bare art beside the same art with the rings
  // on it, which is the comparison a reviewer can actually make.
  if (crop !== null) {
    // Cropped from the FINISHED images rather than mid-pipeline: sharp applies
    // an extract before a composite, so cropping in the same pipeline would try
    // to lay a whole-board overlay over a 360-pixel square and throw.
    const bare = await sharp(await flat.clone().toBuffer())
      .extract(crop)
      .toBuffer();
    const marked = await sharp(readFileSync(imagePath)).extract(crop).toBuffer();
    await sharp({
      create: {
        width: crop.width * 2 + REPORT_CROP_GUTTER,
        height: crop.height,
        channels: 4,
        background: REPORT_BACKDROP,
      },
    })
      .composite([
        { input: bare, left: 0, top: 0 },
        { input: marked, left: crop.width + REPORT_CROP_GUTTER, top: 0 },
      ])
      .png()
      .toFile(path.join(reportDir, `${row.key}-crop.png`));
  }

  const rows = [...stats.values()]
    .sort((left, right) => left.holdId - right.holdId)
    .map((entry) =>
      [
        String(entry.holdId).padStart(6),
        String(entry.tracedArea).padStart(8),
        String(entry.cellAlphaArea).padStart(9),
        entry.areaRecovery.toFixed(3).padStart(9),
        String(entry.droppedArea).padStart(8),
        (entry.pulledBack ? 'yes' : 'no').padStart(6),
        entry.fallbackReason ?? '-',
      ].join('  '),
    );
  writeFileSync(
    path.join(reportDir, `${row.key}.txt`),
    `${row.key}\n` +
      `${row.traced}/${row.placements} traced, ${row.chopped} chopped (recovery < ${MIN_AREA_RECOVERY}), ` +
      `${row.pulledBack} pulled back\n` +
      `recovery mean ${row.recoveryMean.toFixed(3)}, p10 ${row.recoveryP10.toFixed(3)}, min ${row.recoveryMin.toFixed(3)}\n` +
      `\n` +
      `${'holdId'.padStart(6)}  ${'traced'.padStart(8)}  ${'cellArea'.padStart(9)}  ${'recovery'.padStart(9)}  ` +
      `${'dropped'.padStart(8)}  ${'pulled'.padStart(6)}  fallback\n` +
      `${rows.join('\n')}\n`,
  );
}

/**
 * Mean absolute per-channel difference the shipped art may sit from the lossless
 * source it is exported from, in 0-255 levels.
 *
 * Measured, not guessed: Woods' shipped `.webp` sits 1.58 and 1.62 levels from
 * its `.png` (worst single channel 57 and 30, on the antialiased hold rims where
 * the codec spends its error). 6 is ~4x that headroom, and any real drift — one
 * of the pair re-exported from a different photo, a crop, a colour-managed
 * round trip — moves the mean by tens of levels rather than by ones.
 */
const LOSSLESS_MEAN_DIFF_CEILING = 6;

/**
 * Fail loudly when the shipped art and the lossless source it is keyed from stop
 * being the same picture.
 *
 * The two are read from different files by different code paths for different
 * reasons — the mask is cut from the `.png` because compression ringing is
 * speckle the tracer would have to survive, and every colour reading measures the
 * `.webp` because that is what a climber sees. Regenerate one without the other
 * and nothing else in this script notices: the silhouettes would describe one
 * photo and the lightness readings another, and both would look plausible.
 */
function assertLosslessMatchesShipped(
  shipped: DecodedLayer,
  lossless: { pixels: Buffer; channels: number; relativePath: string },
): void {
  const pixelCount = shipped.art.width * shipped.art.height;
  let absoluteDifference = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const shippedOffset = pixel * 4;
    const losslessOffset = pixel * lossless.channels;
    for (let channel = 0; channel < 3; channel += 1) {
      absoluteDifference += Math.abs(
        shipped.art.pixels[shippedOffset + channel] - lossless.pixels[losslessOffset + channel],
      );
    }
  }
  const meanDifference = absoluteDifference / (pixelCount * 3);
  if (meanDifference <= LOSSLESS_MEAN_DIFF_CEILING) return;
  throw new Error(
    `${lossless.relativePath} and the shipped ${shipped.relativePath} differ by a mean of ` +
      `${meanDifference.toFixed(2)} levels per channel, over a ceiling of ${LOSSLESS_MEAN_DIFF_CEILING}. ` +
      `They are meant to be the same picture — the mask is keyed from the lossless one and every colour ` +
      `reading measures the shipped one — so re-export both from the same source.`,
  );
}

/**
 * Recover a photographic board's hold substance from its LOSSLESS sources.
 *
 * Deliberately not `decodeLayers`: that resizes into board space, and here a
 * resample would be a bug rather than a convenience. A photographic board's art
 * is authored AT board size — both Woods sizes are byte-for-byte the board's own
 * `720x1000` and `1225x1400` — so the mask lines up with the placement
 * coordinates with no interpolation at all, and interpolating would blur the
 * antialiased rim the erode is there to remove. A mismatch is asserted rather
 * than resampled: it means the art and the geometry have drifted apart, which is
 * worth a stopped run.
 *
 * Returns a `reason` instead of layers when the key found no ground, which is
 * what a photographic board shot on something other than a white sweep looks
 * like. See `OPAQUE_ART_CEILING`.
 */
async function keyPhotographicLayers(
  layers: DecodedLayer[],
  boardWidth: number,
  boardHeight: number,
): Promise<{ layers: KeyedPhotoLayer[] } | { reason: string }> {
  const keyed: KeyedPhotoLayer[] = [];
  for (const layer of layers) {
    const losslessPath = layer.relativePath.replace(/\.(webp|jpg|jpeg)$/i, '.png');
    if (!existsSync(path.join(PUBLIC_DIR, losslessPath))) {
      return { reason: `no lossless source beside ${layer.relativePath} — expected ${losslessPath}` };
    }
    const { data, info } = await sharp(path.join(PUBLIC_DIR, losslessPath)).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== boardWidth || info.height !== boardHeight) {
      throw new Error(
        `${losslessPath} is ${info.width}x${info.height} but the board is ${boardWidth}x${boardHeight}; ` +
          `the white key does not resample, so the art and the placement geometry have drifted apart`,
      );
    }
    assertLosslessMatchesShipped(layer, { pixels: data, channels: info.channels, relativePath: losslessPath });
    const mask = buildWhiteKeyMask(data, info.width, info.height, info.channels, { erodePx: WHITE_KEY_ERODE_PX });
    if (mask.maskShare >= OPAQUE_ART_CEILING) {
      return {
        reason:
          `keying the white ground out of ${losslessPath} left ${(mask.maskShare * 100).toFixed(1)}% of it opaque ` +
          `(only ${(mask.groundShare * 100).toFixed(1)}% flooded from the corners) — its corners are not board ground`,
      };
    }
    keyed.push({
      relativePath: losslessPath,
      mask: mask.mask,
      groundShare: mask.groundShare,
      maskShare: mask.maskShare,
    });
  }
  return { layers: keyed };
}

/**
 * Give the composite back the alpha the photograph never carried, so every
 * COLOUR reading below sees board ground as play field rather than as art.
 *
 * `wallLightness` is what this is FOR, and the difference is not marginal. It is
 * the brightness a selector ring has to compete with over the 0.85r..1.15r
 * annulus — mostly the gap BETWEEN holds, which on a photographed board is white
 * sweep. Measured with the photograph's own alpha it reads that sweep as a very
 * bright wall: 0.743 on the 8x10 and 0.766 on the 12x12, at 100% coverage. Keyed,
 * the same annuli read 0.530 and 0.540 at 93% coverage, because the ground is now
 * excluded exactly the way every other board's transparent gutter already is, and
 * the placements whose annulus is nothing BUT ground are excluded rather than
 * averaged in as bright.
 *
 * `ledBright` is the second reason to do it before the colour pass, and on Woods
 * it is a guard rather than a fix. A placement on bare white ground reads a linear
 * luma of 1.0 at its centre, which is the first thing `findPaintedLedBlob` looks
 * for — but its surround disc sits on the same white sweep, so the ratio stays
 * near 1 and neither size flags a single painted LED with or without this. That is
 * a fact about THIS board's ground rather than about photographic art, and it
 * stops holding the moment one ships shot on a dark sweep.
 *
 * The mask comes from the lossless source and the pixels from the shipped one.
 * That is deliberate: the mask is a question about the geometry (key it clean),
 * the colours are a question about what a climber sees (measure what ships).
 * `assertLosslessMatchesShipped` is what keeps that pair honest.
 *
 * IT WRITES THROUGH TO THE LAYER on a single-layer board. `compositeLayers`
 * returns `layers[0].art.pixels` unchanged when there is one layer, so `art`
 * and that layer share a buffer and this zeroes the layer's alpha too. Harmless
 * as the code stands — a photographic field takes its substance from the keyed
 * mask and never reads the layer's own alpha — but anything later that wants
 * the layer's original alpha has to copy first.
 */
function applyRecoveredAlpha(art: BoardArt, keyedLayers: KeyedPhotoLayer[]): void {
  for (let pixel = 0; pixel < art.width * art.height; pixel += 1) {
    let substance = false;
    for (const layer of keyedLayers) {
      if (layer.mask[pixel] === 1) {
        substance = true;
        break;
      }
    }
    if (!substance) art.pixels[pixel * 4 + 3] = 0;
  }
}

// ---------------------------------------------------------------------------
// Canonical per-layout traces
// ---------------------------------------------------------------------------

/** One placement's ring from a canonical trace, ready to project into any size. */
type CanonicalEntry = {
  /** Unrounded radius units relative to the placement's exact centre. */
  ringUnits: number[];
  /** Config the trace ran on, e.g. `kilter/8-23`. Reports and summaries only. */
  sourceConfigKey: string;
  /** The art layer it was traced against — the registration pair's left half. */
  sourceImage: string;
};

/** Everything a target config needs to receive a layout's canonical rings. */
type CanonicalLayout = {
  /** Placement id -> canonical rings, best source first. */
  entriesById: Map<number, CanonicalEntry[]>;
  /** Canonical layers' alpha planes, for registration, keyed by relative path. */
  layerAlpha: Map<string, AlphaPlane>;
  /** Placement id -> exact centre, per canonical layer. */
  centresByImage: Map<string, Map<number, [number, number]>>;
  /** Placement radius per canonical layer (uniform per config on Aurora boards). */
  radiusByImage: Map<string, number>;
  /** Measured art offsets, keyed `<sourceImage>-><targetImage>`. Shared across configs. */
  registrationByPair: Map<string, PairRegistration | null>;
};

const canonicalLayoutCache = new Map<string, Promise<CanonicalLayout | null>>();

/**
 * Trace the layout's canonical configs once and cache the result for every
 * size of the layout in this run.
 *
 * Two canonical sources, not one, and the order matters:
 * - PRIMARY is the highest-resolution config (most board px per grid unit; most
 *   placements as the tiebreak) — the sharpest art the layout ships.
 * - COVERAGE is the config with the most placements, for the holds the primary's
 *   smaller wall never mounts, and as the fallback when a projection from the
 *   primary disagrees with a target's own trace. The coverage config mounts
 *   every neighbour, so its pullbacks match what a full board actually needs —
 *   the primary's art can omit a touching neighbour that only the bigger sizes
 *   carry, and a ring traced without that neighbour would overreach onto it.
 */
async function canonicalLayoutFor(boardName: string, layoutId: number): Promise<CanonicalLayout | null> {
  const cacheKey = `${boardName}/${layoutId}`;
  const cached = canonicalLayoutCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const built = buildCanonicalLayout(boardName, layoutId);
  canonicalLayoutCache.set(cacheKey, built);
  return built;
}

async function buildCanonicalLayout(boardName: string, layoutId: number): Promise<CanonicalLayout | null> {
  const configs = listCatalogueEntries().filter(
    (entry) => entry.boardName === boardName && entry.layoutId === layoutId,
  );
  if (configs.length < 2) return null;

  type SourceConfig = {
    key: string;
    details: BoardRenderDetails;
    pxPerUnit: number;
    placementCount: number;
    sizeId: number;
  };
  const sources: SourceConfig[] = [];
  for (const config of configs) {
    let details: BoardRenderDetails;
    try {
      details = getBoardDetailsForBoard({
        board_name: config.boardName,
        layout_id: config.layoutId,
        size_id: config.sizeId,
        set_ids: config.setIds,
      });
    } catch {
      continue;
    }
    sources.push({
      key: `${config.boardName}/${config.layoutId}-${config.sizeId}`,
      details,
      pxPerUnit: details.boardWidth / (details.edge_right - details.edge_left),
      placementCount: new Set(details.holdsData.map((placement) => placement.id)).size,
      sizeId: config.sizeId,
    });
  }
  if (sources.length < 2) return null;

  const byResolution = [...sources].sort(
    (left, right) =>
      right.pxPerUnit - left.pxPerUnit || right.placementCount - left.placementCount || left.sizeId - right.sizeId,
  );
  const byCoverage = [...sources].sort(
    (left, right) =>
      right.placementCount - left.placementCount || right.pxPerUnit - left.pxPerUnit || left.sizeId - right.sizeId,
  );
  const primary = byResolution[0];
  const coverage = byCoverage[0];
  const canonicalSources = primary.key === coverage.key ? [primary] : [primary, coverage];

  const layout: CanonicalLayout = {
    entriesById: new Map(),
    layerAlpha: new Map(),
    centresByImage: new Map(),
    radiusByImage: new Map(),
    registrationByPair: new Map(),
  };

  for (const source of canonicalSources) {
    const relativePaths = getBackgroundRelPaths(source.details, false);
    if (relativePaths.some((relativePath) => !existsSync(path.join(PUBLIC_DIR, relativePath)))) continue;
    const layers = await decodeLayers(relativePaths, source.details.boardWidth, source.details.boardHeight);
    const fields = perImageMaskProvider(source.details, layers);
    for (const field of fields) {
      const { outlines } = traceOutlines(field);
      const layer = layers.find((candidate) => candidate.relativePath === field.sourceKey);
      if (layer === undefined) throw new Error(`${source.key}: field ${field.sourceKey} has no decoded layer`);
      if (!layout.layerAlpha.has(field.sourceKey)) {
        layout.layerAlpha.set(
          field.sourceKey,
          field.alpha !== undefined
            ? { data: field.alpha, width: field.width, height: field.height }
            : { data: extractAlphaPlane(layer.art), width: field.width, height: field.height },
        );
      }
      const centres = layout.centresByImage.get(field.sourceKey) ?? new Map<number, [number, number]>();
      layout.centresByImage.set(field.sourceKey, centres);
      for (const placement of field.placements) {
        if (!centres.has(placement.id)) centres.set(placement.id, [placement.cx, placement.cy]);
        if (!layout.radiusByImage.has(field.sourceKey)) layout.radiusByImage.set(field.sourceKey, placement.r);
      }
      for (const [placementId, flat] of outlines) {
        const centre = centres.get(placementId);
        const radius = field.placements.find((placement) => placement.id === placementId)?.r;
        if (centre === undefined || radius === undefined) continue;
        // The exact inverse of the emission maths, WITHOUT the final rounding:
        // the projection into each target adds its offset first and rounds once,
        // so configs sharing the canonical image emit byte-identical rows.
        const roundingX = Math.round(centre[0]) - centre[0];
        const roundingY = Math.round(centre[1]) - centre[1];
        const ringUnits: number[] = [];
        for (let index = 0; index < flat.length; index += 2) {
          ringUnits.push((flat[index] + roundingX) / radius, (flat[index + 1] + roundingY) / radius);
        }
        const entries = layout.entriesById.get(placementId) ?? [];
        entries.push({ ringUnits, sourceConfigKey: source.key, sourceImage: field.sourceKey });
        layout.entriesById.set(placementId, entries);
      }
    }
  }
  return layout.entriesById.size === 0 ? null : layout;
}

/**
 * The registration offset from one canonical image to one target image, cached
 * per pair for the whole run (configs of one family share images, so the ten
 * Kilter Homewall configs measure each pair once).
 *
 * The same image needs no measuring, and forcing it to exactly (0, 0) is a
 * correctness point, not an optimisation: it is what keeps the shards of sizes
 * that share art byte-identical on their shared placements.
 */
function registrationFor(
  layout: CanonicalLayout,
  sourceImage: string,
  targetImage: string,
  targetAlpha: () => AlphaPlane,
  samples: () => RegistrationSample[],
  canonicalPerTargetPx: number,
): { dx: number; dy: number } | null {
  if (sourceImage === targetImage) return { dx: 0, dy: 0 };
  const pairKey = `${sourceImage}->${targetImage}`;
  let registration = layout.registrationByPair.get(pairKey);
  if (registration === undefined) {
    const canonicalAlpha = layout.layerAlpha.get(sourceImage);
    registration =
      canonicalAlpha === undefined
        ? null
        : measurePairRegistration(targetAlpha(), canonicalAlpha, samples(), canonicalPerTargetPx);
    if (registration === null) {
      console.warn(`[board-art-geometry] ${pairKey}: registration unmeasurable — projections skip this pair`);
    } else {
      const spreadWarning =
        registration.iqrX > REGISTRATION_IQR_WARN_PX || registration.iqrY > REGISTRATION_IQR_WARN_PX
          ? ' — the two renders disagree beyond a rigid shift; check the report before trusting projections here'
          : '';
      console.log(
        `[board-art-geometry] ${pairKey}: registration (${registration.dx.toFixed(2)}, ` +
          `${registration.dy.toFixed(2)}) px, iqr (${registration.iqrX.toFixed(2)}, ` +
          `${registration.iqrY.toFixed(2)}), ${registration.samples} windows${spreadWarning}`,
      );
    }
    layout.registrationByPair.set(pairKey, registration);
  }
  return registration === null ? null : { dx: registration.dx, dy: registration.dy };
}

async function measureConfig(
  entry: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    setIds: number[];
  },
  reportDir: string | null,
  reportCrop: ReportCrop | null,
  maskProvider: MaskProvider,
): Promise<ConfigResult | { skipped: string }> {
  const startedAt = Date.now();
  const key = `${entry.boardName}/${entry.layoutId}-${entry.sizeId}`;

  let details;
  try {
    details = getBoardDetailsForBoard({
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      set_ids: entry.setIds,
    });
  } catch (error) {
    return { skipped: `${key}: board details threw — ${error instanceof Error ? error.message : String(error)}` };
  }

  const relativePaths = getBackgroundRelPaths(details, false);
  const missingArt = relativePaths.filter((relativePath) => !existsSync(path.join(PUBLIC_DIR, relativePath)));
  if (relativePaths.length === 0) return { skipped: `${key}: no board art layers` };
  if (missingArt.length > 0) return { skipped: `${key}: missing art — ${missingArt.join(', ')}` };

  const layers = await decodeLayers(relativePaths, details.boardWidth, details.boardHeight);
  const art = await compositeLayers(layers, details.boardWidth, details.boardHeight);
  // The opaque-art ceiling is a question about the COMPOSITE and stays one: a
  // board whose stack is a photograph has no alpha channel to read no matter how
  // the tracer partitions it.
  const opaque = buildOpaqueMask(art);
  let opaqueCount = 0;
  for (let index = 0; index < opaque.length; index += 1) opaqueCount += opaque[index];
  const opaqueShare = opaqueCount / opaque.length;
  let provider = maskProvider;
  if (opaqueShare >= OPAQUE_ART_CEILING) {
    // Not a skip any more, a ROUTE. The alpha channel is full, so the question
    // becomes whether the substance can be recovered by keying the ground out;
    // only a board where that also fails falls back to rings.
    const keyed = await keyPhotographicLayers(layers, details.boardWidth, details.boardHeight);
    if ('reason' in keyed) {
      return {
        skipped:
          `${key}: art is ${(opaqueShare * 100).toFixed(1)}% opaque — a photograph, not a stack of ` +
          `transparent hold layers, so there is no silhouette in the alpha channel to trace ` +
          `(${keyed.reason})`,
      };
    }
    provider = photoMaskProvider(keyed.layers);
    applyRecoveredAlpha(art, keyed.layers);
    console.log(
      `[board-art-geometry] ${key.padEnd(20)} photographic art — keyed ` +
        keyed.layers
          .map(
            (layer) =>
              `${layer.relativePath} to ${(layer.groundShare * 100).toFixed(2)}% ground / ` +
              `${(layer.maskShare * 100).toFixed(2)}% hold`,
          )
          .join(', '),
    );
  }

  const placements = details.holdsData;
  const { outlines, summary, stats } = mergeFieldTraces(provider(details, layers), placements);
  const uniquePlacements = new Set(placements.map((placement) => placement.id)).size;

  const radiusById = new Map<number, number>();
  const centreById = new Map<number, [number, number]>();
  for (const placement of placements) {
    if (radiusById.has(placement.id)) continue;
    radiusById.set(placement.id, placement.r);
    centreById.set(placement.id, [placement.cx, placement.cy]);
  }

  // --- Canonical projection: one trace per hold, per layout --------------------
  //
  // For activated layouts every placement's own trace is compared against the
  // layout's canonical ring projected into this config's frame (shifted by the
  // measured art-registration offset). Agreement means the canonical ring ships
  // — the SAME silhouette on every size — and disagreement means this config's
  // art genuinely differs there, so its own trace ships and the summary says so.
  // The direct trace is never skipped: it is both the comparison baseline and
  // the honest fallback.
  const projectedUnitsById = new Map<number, number[]>();
  let canonicalProjected = 0;
  let canonicalFallbacks = 0;
  if (CANONICAL_LAYOUTS.has(`${entry.boardName}/${entry.layoutId}`) && provider === maskProvider) {
    const layout = await canonicalLayoutFor(entry.boardName, entry.layoutId);
    if (layout !== null) {
      const fieldOf = placementFieldIndex(details);
      const targetAlphaByIndex = new Map<number, AlphaPlane>();
      const targetAlphaFor = (layerIndex: number): (() => AlphaPlane) => {
        return () => {
          let plane = targetAlphaByIndex.get(layerIndex);
          if (plane === undefined) {
            const art = layers[layerIndex].art;
            plane = { data: extractAlphaPlane(art), width: art.width, height: art.height };
            targetAlphaByIndex.set(layerIndex, plane);
          }
          return plane;
        };
      };
      const samplesFor = (sourceImage: string, layerIndex: number): (() => RegistrationSample[]) => {
        return () => {
          const canonicalCentres = layout.centresByImage.get(sourceImage);
          if (canonicalCentres === undefined) return [];
          const sharedIds: number[] = [];
          const seenSampleIds = new Set<number>();
          for (const placement of placements) {
            if (seenSampleIds.has(placement.id)) continue;
            seenSampleIds.add(placement.id);
            if ((fieldOf.get(placement.id) ?? -1) !== layerIndex) continue;
            if (!canonicalCentres.has(placement.id)) continue;
            sharedIds.push(placement.id);
          }
          sharedIds.sort((left, right) => left - right);
          const stride = Math.max(1, Math.ceil(sharedIds.length / REGISTRATION_MAX_SAMPLES));
          const samples: RegistrationSample[] = [];
          for (let index = 0; index < sharedIds.length; index += stride) {
            const placementId = sharedIds[index];
            const targetCentre = centreById.get(placementId) as [number, number];
            const canonicalCentre = canonicalCentres.get(placementId) as [number, number];
            samples.push({
              targetX: targetCentre[0],
              targetY: targetCentre[1],
              canonicalX: canonicalCentre[0],
              canonicalY: canonicalCentre[1],
              radiusPx: radiusById.get(placementId) as number,
            });
          }
          return samples;
        };
      };

      const routedIds = new Set<number>();
      const rejectedAgreements: number[] = [];
      for (const placement of placements) {
        if (routedIds.has(placement.id)) continue;
        routedIds.add(placement.id);
        const tiers = layout.entriesById.get(placement.id);
        if (tiers === undefined) continue;
        const layerIndex = fieldOf.get(placement.id) ?? -1;
        if (layerIndex < 0) continue;
        const targetImage = layers[layerIndex].relativePath;
        const directFlat = outlines.get(placement.id);
        const radius = placement.r;
        const roundingX = Math.round(placement.cx) - placement.cx;
        const roundingY = Math.round(placement.cy) - placement.cy;
        let accepted = false;
        for (const tier of tiers) {
          const canonicalRadius = layout.radiusByImage.get(tier.sourceImage);
          if (canonicalRadius === undefined) continue;
          const offset = registrationFor(
            layout,
            tier.sourceImage,
            targetImage,
            targetAlphaFor(layerIndex),
            samplesFor(tier.sourceImage, layerIndex),
            canonicalRadius / radius,
          );
          if (offset === null) continue;
          const projectedUnits = projectRingUnits(tier.ringUnits, offset, radius);
          const projectedFlat: number[] = [];
          for (let index = 0; index < projectedUnits.length; index += 2) {
            projectedFlat.push(
              projectedUnits[index] * radius - roundingX,
              projectedUnits[index + 1] * radius - roundingY,
            );
          }
          if (directFlat !== undefined) {
            const agreement = ringAgreement(projectedFlat, directFlat);
            if (agreement < CANONICAL_AGREEMENT_FLOOR) {
              rejectedAgreements.push(agreement);
              continue;
            }
          }
          outlines.set(placement.id, projectedFlat);
          projectedUnitsById.set(placement.id, projectedUnits);
          canonicalProjected += 1;
          accepted = true;
          break;
        }
        if (!accepted && directFlat !== undefined) canonicalFallbacks += 1;
      }
      if (rejectedAgreements.length > 0) {
        rejectedAgreements.sort((left, right) => left - right);
        const middle = rejectedAgreements[rejectedAgreements.length >> 1];
        console.log(
          `[board-art-geometry] ${key}: ${canonicalFallbacks} placement(s) kept their own trace — rejected ` +
            `projection agreement min ${rejectedAgreements[0].toFixed(3)} / median ${middle.toFixed(3)} / ` +
            `max ${rejectedAgreements[rejectedAgreements.length - 1].toFixed(3)} against floor ${CANONICAL_AGREEMENT_FLOOR}`,
        );
      }
    }
  }

  // --- Override merge, point 1 of 3: put the hand-drawn silhouette in ---------
  //
  // At the emission boundary and nowhere else. The tracer has finished and its
  // stats are already recorded; from here the overridden placements are simply
  // placements that have an outline, so everything downstream — the lightness
  // measurement, the counts, the report — reads the shape that ships rather than
  // the shape a human already rejected.
  //
  // Converted back into the tracer's own frame (integer board pixels offset from
  // the ROUNDED centre) because that is what `measureSilhouette` scans and what
  // the radius-unit conversion below undoes. Exactly inverse: emission does
  // `(px + rounding) / r`, so this does `v * r - rounding`. Floats are fine —
  // the scanline fill takes them — and the stored 4-decimal values go into the
  // shard verbatim at point 2 regardless, so nothing round-trips.
  const overrides = loadOverridesFor(key, radiusById.keys());
  // Corrections drawn on a SIBLING config apply here too wherever the two
  // configs draw the placement from the same art image — identical art,
  // identical frame, verbatim ring. See `adoptSameImageOverrides` for why a
  // different art family never adopts one.
  if (CANONICAL_LAYOUTS.has(`${entry.boardName}/${entry.layoutId}`) && provider === maskProvider) {
    const imageByPlacementFor = (
      configDetails: BoardRenderDetails,
      configRelativePaths: string[],
    ): Map<number, string> => {
      const imageByPlacement = new Map<number, string>();
      for (const [placementId, layerIndex] of placementFieldIndex(configDetails)) {
        if (layerIndex >= 0) imageByPlacement.set(placementId, configRelativePaths[layerIndex]);
      }
      return imageByPlacement;
    };
    let ownImageByPlacement: Map<number, string> | null = null;
    for (const sibling of listCatalogueEntries()) {
      if (sibling.boardName !== entry.boardName || sibling.layoutId !== entry.layoutId) continue;
      if (sibling.sizeId === entry.sizeId) continue;
      const siblingKey = `${sibling.boardName}/${sibling.layoutId}-${sibling.sizeId}`;
      if (!existsSync(path.join(OVERRIDES_DIR, `${siblingKey}.json`))) continue;
      const siblingDetails = getBoardDetailsForBoard({
        board_name: sibling.boardName,
        layout_id: sibling.layoutId,
        size_id: sibling.sizeId,
        set_ids: sibling.setIds,
      });
      const siblingIds = new Set(siblingDetails.holdsData.map((placement) => placement.id));
      const siblingOverrides = loadOverridesFor(siblingKey, siblingIds);
      ownImageByPlacement ??= imageByPlacementFor(details, relativePaths);
      adoptSameImageOverrides(overrides, key, ownImageByPlacement, {
        key: siblingKey,
        overrides: siblingOverrides,
        imageByPlacement: imageByPlacementFor(siblingDetails, getBackgroundRelPaths(siblingDetails, false)),
      });
    }
  }
  for (const [holdId, ring] of overrides.outlines) {
    const radius = radiusById.get(holdId) as number;
    const [exactX, exactY] = centreById.get(holdId) as [number, number];
    const roundingX = Math.round(exactX) - exactX;
    const roundingY = Math.round(exactY) - exactY;
    const tracerPixels: number[] = [];
    for (let index = 0; index < ring.length; index += 2) {
      tracerPixels.push(ring[index] * radius - roundingX, ring[index + 1] * radius - roundingY);
    }
    outlines.set(holdId, tracerPixels);
  }

  // --- The LED base plate ----------------------------------------------------
  //
  // Run on the silhouettes that SHIP, hand-corrected ones included, because the
  // extractor's whole input is "the art inside this polygon" and a corrected
  // polygon is the one a renderer will subtract the inner ring from.
  //
  // Run on EVERY config, not on a list of boards. Whether a config's art carries
  // a two-tone plate is a measurement — the acceptance rate — and a hand-kept
  // board list would go stale the moment a board ships new art. A config that
  // does not clear `MIN_CONFIG_ACCEPTANCE` emits no table at all, which is the
  // same bytes it emitted before this extractor existed.
  const measuredLedRings = extractConfigLedRings(art, placements, outlines, COORDINATE_DECIMALS);
  const ledQualified = qualifies(measuredLedRings);
  // Annotations replace extractions, never the other way round: a `led_inner`
  // override is the ground truth this extractor is calibrated against. The rule
  // lives in `assembleLedInner` rather than in two loops here, because two loops
  // here were indistinguishable from the same two loops in the wrong order —
  // nothing in the repo has a `led_inner` annotation to notice with.
  const ledInner = assembleLedInner(ledQualified ? measuredLedRings.rings : new Map(), overrides.ledInner);

  const reportRow = reportRowFor(key, uniquePlacements, stats);
  if (reportDir !== null) {
    await writeConfigReport(
      reportDir,
      reportRow,
      art,
      placements,
      outlines,
      stats,
      ledQualified ? measuredLedRings.boardPixelRings : new Map(),
      reportCrop,
    );
  }

  const silhouetteLightness = new Map<number, number>();
  const ledBright = new Map<number, [number, number]>();
  let annulusTotal = 0;
  let annulusCount = 0;
  let annulusPlacements = 0;

  const ledOffsetY = ledOffsetYFor(entry.boardName, placements);
  const lumaAt = (x: number, y: number): number | null => {
    if (x < 0 || y < 0 || x >= art.width || y >= art.height) return null;
    const offset = (y * art.width + x) * 4;
    if (art.pixels[offset + 3] < 128) return null;
    return linearLuma(art.pixels[offset], art.pixels[offset + 1], art.pixels[offset + 2]);
  };
  const sampleDisc = (centreX: number, centreY: number, outer: number, inner = 0): number | null => {
    let total = 0;
    let count = 0;
    const bound = Math.ceil(outer);
    for (let stepY = -bound; stepY <= bound; stepY += 1) {
      for (let stepX = -bound; stepX <= bound; stepX += 1) {
        const distance = stepX * stepX + stepY * stepY;
        if (distance > outer * outer || distance < inner * inner) continue;
        const value = lumaAt(Math.round(centreX + stepX), Math.round(centreY + stepY));
        if (value === null) continue;
        total += value;
        count += 1;
      }
    }
    return count === 0 ? null : total / count;
  };

  const seen = new Set<number>();
  for (const placement of placements) {
    if (seen.has(placement.id)) continue;
    seen.add(placement.id);
    annulusPlacements += 1;

    const annulus = measureAnnulus(art, placement.cx, placement.cy, placement.r);
    if (annulus !== null && annulus > 0) {
      annulusTotal += annulus;
      annulusCount += 1;
    }

    const outline = outlines.get(placement.id);
    if (outline !== undefined && outline.length >= 6) {
      const inside = measureSilhouette(art, Math.round(placement.cx), Math.round(placement.cy), outline);
      if (inside !== null) silhouetteLightness.set(placement.id, inside);
    }

    // Measure where the dot is drawn, not where the placement is. On MoonBoard
    // those are 25 board px apart and the art at the placement is bare field.
    const ledY = placement.cy + ledOffsetY;
    const centre = sampleDisc(placement.cx, ledY, LED_SAMPLE_RADIUS);
    const surround = sampleDisc(placement.cx, ledY, placement.r * 0.55, placement.r * 0.3);
    if (centre === null || surround === null) continue;
    if (centre / Math.max(1e-4, surround) <= LED_BRIGHT_RATIO) continue;
    const blob = findPaintedLedBlob(art, lumaAt, sampleDisc, placement.cx, ledY);
    if (blob === null || blob.luma < LED_BRIGHT_LUMA_FLOOR) continue;
    // Folded into radius units from the PLACEMENT centre, `ledOffsetY` included,
    // so the shard needs no second table to place the dot.
    ledBright.set(placement.id, [
      roundTo(blob.offset[0] / placement.r, COORDINATE_DECIMALS),
      roundTo((ledOffsetY + blob.offset[1]) / placement.r, COORDINATE_DECIMALS),
    ]);
  }

  const radiusUnitOutlines = new Map<number, number[]>();
  for (const [holdId, flat] of outlines) {
    // --- Override merge, point 2 of 3: emit the stored ring verbatim ----------
    //
    // Not `v * r - rounding` back through `(px + rounding) / r`. That round trip
    // is algebraically the identity and numerically is not: it re-rounds a value
    // that was already rounded to 4 decimals, so a ring could come out a digit
    // different from the one the reviewer approved and the one the database
    // holds. Verbatim makes the shard byte-predictable from the JSON alone,
    // which is what lets `overrides.test.ts` prove the merge actually ran.
    const stored = overrides.outlines.get(holdId);
    if (stored !== undefined) {
      radiusUnitOutlines.set(holdId, stored);
      continue;
    }
    const converted: number[] = [];
    const projected = projectedUnitsById.get(holdId);
    if (projected !== undefined) {
      // A canonical ring is already in radius units relative to the exact
      // centre; it rounds here ONCE, so two configs sharing the canonical image
      // emit byte-identical rows — the property the cross-size dedup promises.
      for (const value of projected) converted.push(roundTo(value, COORDINATE_DECIMALS));
    } else {
      const radius = radiusById.get(holdId) as number;
      const [exactX, exactY] = centreById.get(holdId) as [number, number];
      // The tracer works in integer board pixels offset from the ROUNDED centre.
      // Undo that rounding before dividing, so the emitted polygon is relative to
      // the exact placement centre a renderer positions the mark at.
      const roundingX = Math.round(exactX) - exactX;
      const roundingY = Math.round(exactY) - exactY;
      for (let index = 0; index < flat.length; index += 2) {
        converted.push(
          roundTo((flat[index] + roundingX) / radius, COORDINATE_DECIMALS),
          roundTo((flat[index + 1] + roundingY) / radius, COORDINATE_DECIMALS),
        );
      }
    }
    // A ring the tracer emits is held to the caps a hand-drawn correction is
    // held to (`isValidOutlineRing`). The crisp profile halves ε and can only
    // raise vertex counts, so the caps are asserted here — where the config and
    // placement can be named — rather than discovered later by the package's
    // shard sweep.
    if (converted.length > MAX_RING_NUMBERS) {
      throw new Error(
        `${key} placement ${holdId}: outline has ${converted.length / 2} points (cap ${MAX_RING_NUMBERS / 2})`,
      );
    }
    for (const value of converted) {
      if (!Number.isFinite(value) || Math.abs(value) > MAX_RING_COORDINATE) {
        throw new Error(
          `${key} placement ${holdId}: outline coordinate ${value} exceeds ±${MAX_RING_COORDINATE} radii`,
        );
      }
    }
    radiusUnitOutlines.set(holdId, converted);
  }

  // --- Override merge, point 3 of 3: counts and the shard header --------------
  //
  // `outlines.size` already includes the overridden placements — an override can
  // ADD an outline to a placement the tracer never traced, and a hand-drawn
  // silhouette is as traced as any other from a consumer's point of view — so
  // gate 4's pin moves with the correction rather than against it. The header
  // says how many, so a shard diff is self-explanatory; a config with no
  // overrides gets no extra text and stays byte-identical.
  //
  // ROWS, not placements, and the wording says so: one hold carrying both a
  // silhouette and an LED-inner annotation is two rows in the table, two entries
  // in the JSON and two lines of shard diff, so counting it as one would
  // under-report exactly what the reader is looking at.
  const summaryWithCanonical =
    canonicalProjected === 0
      ? summary
      : `${summary}; ${canonicalProjected} outline(s) from the layout's canonical traces` +
        (canonicalFallbacks === 0 ? '' : ` (${canonicalFallbacks} kept their own trace)`);
  const overrideCount = overrides.outlines.size + overrides.ledInner.size;
  const summaryWithOverrides =
    overrideCount === 0
      ? summaryWithCanonical
      : `${summaryWithCanonical}; ${overrideCount} hand-corrected override row(s) applied`;

  return {
    key,
    boardName: entry.boardName,
    layoutId: entry.layoutId,
    sizeId: entry.sizeId,
    tables: { outlines: radiusUnitOutlines, silhouetteLightness, ledBright, ledInner },
    wall: {
      mean: annulusCount === 0 ? 0 : roundTo(annulusTotal / annulusCount, LIGHTNESS_DECIMALS),
      coverage: annulusPlacements === 0 ? 0 : roundTo(annulusCount / annulusPlacements, LIGHTNESS_DECIMALS),
    },
    counts: { traced: outlines.size, placements: annulusPlacements },
    summary: summaryWithOverrides,
    report: reportRow,
    ledRings: { ...measuredLedRings, qualified: ledQualified },
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const DO_NOT_EDIT = '// Generated by scripts/generate-board-art-geometry.ts — do not edit by hand.';

function renderShard(result: ConfigResult): string {
  const numericAscending = (left: [number, unknown], right: [number, unknown]): number => left[0] - right[0];
  const outlineRows = [...result.tables.outlines.entries()]
    .sort(numericAscending)
    .map(([holdId, flat]) => `    ${holdId}: [${flat.join(',')}],`)
    .join('\n');
  const lightnessRows = [...result.tables.silhouetteLightness.entries()]
    .sort(numericAscending)
    .map(([holdId, value]) => `    ${holdId}: ${value},`)
    .join('\n');
  const ledRows = [...result.tables.ledBright.entries()]
    .sort(numericAscending)
    .map(([holdId, [dx, dy]]) => `    ${holdId}: [${dx},${dy}],`)
    .join('\n');
  const ledInnerRows = [...result.tables.ledInner.entries()]
    .sort(numericAscending)
    .map(([holdId, flat]) => `    ${holdId}: [${flat.join(',')}],`)
    .join('\n');

  // `ledInner` is written only where there is one. The field is optional in the
  // contract precisely so that a shard with no LED annotations is the same bytes
  // it was before this table existed, and 49 shards growing an empty `{}` would
  // be a catalogue-wide diff saying nothing.
  const ledInnerNote = ledInnerRows
    ? `// ledInner:            placementId -> flat ring of the LED base plate's INNER edge, same\n` +
      `//                      units. The lit region is the silhouette minus it. Extracted from\n` +
      `//                      the art's two-tone plate, or hand-annotated where someone drew one.\n`
    : '';
  const ledInnerTable = ledInnerRows ? `  ledInner: {\n${ledInnerRows}\n  },\n` : '';

  return (
    `${DO_NOT_EDIT}\n` +
    `// ${result.key} — ${result.summary}\n` +
    `//\n` +
    `// outlines:            placementId -> flat [x0,y0,...] in units of the placement radius,\n` +
    `//                      relative to its centre. A placement with no traceable art is absent.\n` +
    `// silhouetteLightness: placementId -> OkLab L of the art inside the traced silhouette.\n` +
    `// ledBright:           placementId -> [dx,dy] radius units to the bright LED blob the art\n` +
    `//                      already paints, for the placements where it paints one.\n` +
    ledInnerNote +
    `module.exports = {\n` +
    `  outlines: {\n${outlineRows}${outlineRows ? '\n' : ''}  },\n` +
    `  silhouetteLightness: {\n${lightnessRows}${lightnessRows ? '\n' : ''}  },\n` +
    `  ledBright: {\n${ledRows}${ledRows ? '\n' : ''}  },\n` +
    ledInnerTable +
    `};\n`
  );
}

function renderWallLightness(results: ConfigResult[]): string {
  const rows = results
    .map((result) => `  '${result.key}': { mean: ${result.wall.mean}, coverage: ${result.wall.coverage} },`)
    .join('\n');
  return (
    `${DO_NOT_EDIT}\n` +
    `// Mean OkLab lightness of the board art in the annulus a selector ring is drawn in\n` +
    `// (0.85r..1.15r), alpha-weighted so a transparent gap counts as play field rather than\n` +
    `// as black art, over the placements that HAVE a reading. \`coverage\` is the share of the\n` +
    `// board's placements that do. Placements with no art in the band are excluded from the\n` +
    `// mean, not averaged in as 0: averaging them measures how empty a board is rather than\n` +
    `// how bright, and it turned both MoonBoards' veil off entirely.\n` +
    `module.exports = {\n${rows}\n};\n`
  );
}

function renderOutlineCounts(results: ConfigResult[]): string {
  const rows = results
    .map((result) => `  '${result.key}': { traced: ${result.counts.traced}, placements: ${result.counts.placements} },`)
    .join('\n');
  return (
    `${DO_NOT_EDIT}\n` +
    `// Traced outlines against total placements, per shard, as counted by the run that wrote\n` +
    `// the tables. Gate 4 pins these: a drop means the seed containment got too tight, and a\n` +
    `// jump on a MoonBoard means a set joined its composite (every shard mounts them all) (those\n` +
    `// layouts are a synthetic 11x18 grid and most cells genuinely carry no hold).\n` +
    `module.exports = {\n${rows}\n};\n`
  );
}

/**
 * The shard index: one literal `require` per shard so Metro and webpack can
 * resolve them statically and evaluate only the board being drawn.
 *
 * The dual `require` / `createRequire` shim is copied from
 * `@boardsesh/board-constants`' `hole-placements.ts`. It is the only shape that
 * works in all four runtimes we load this from: Metro (mobile), webpack (web),
 * bare Node ESM (these generator scripts, the backend) and vitest.
 */
function renderShardIndex(results: ConfigResult[]): string {
  const loaders = results
    .map(
      (result) =>
        `  '${result.key}': () =>\n` +
        `    hasGlobalRequire\n` +
        `      ? (require('./${result.key}.cjs') as BoardArtGeometry)\n` +
        `      : (nodeRequire()('./${result.key}.cjs') as BoardArtGeometry),`,
    )
    .join('\n');

  return `${DO_NOT_EDIT}
/// <reference types="node" />
/**
 * Lazy per-config loader map for the traced board art. Each config's silhouettes
 * live in their own \`.cjs\` shard under \`generated/<board>/\`; the index requires
 * only the config that is asked for, so Hermes (Android, no JIT) never has to
 * evaluate every board's polygons at once.
 *
 * The \`/// <reference types="node" />\` above types the global \`require\` and
 * \`process\` this file uses, in every consuming package. It is a type-only
 * directive, so it changes nothing at runtime in Metro/webpack.
 *
 * This file is structural apart from the key list, so regenerating with unchanged
 * board data produces a byte-identical file and no spurious diff.
 */

import type { BoardArtGeometry, OutlineCountsTable, WallLightnessTable } from '../types';

// Metro (mobile), webpack (web), and the vitest test runtime inject a global,
// synchronous \`require\`; the literal \`require('./<board>/<layout>-<size>.cjs')\`
// calls below let those bundlers statically resolve each shard and lazily
// evaluate only the requested config.
//
// Bare Node ESM (the tsx-run generator scripts, the backend) has no global
// \`require\`. There we build one with \`createRequire\`, reached through
// \`process.getBuiltinModule\` so this module never statically imports a Node
// builtin (which Metro could not resolve) and never touches \`import.meta\` (which
// Metro's CommonJS transform does not support). That Node \`createRequire\` is
// anchored to this module's URL, so the same relative shard paths resolve in both
// branches.
const hasGlobalRequire = typeof require === 'function';

let cachedNodeRequire: ((path: string) => unknown) | null = null;
function nodeRequire(): (path: string) => unknown {
  if (cachedNodeRequire) return cachedNodeRequire;
  const getBuiltinModule = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    // process.getBuiltinModule landed in Node 22.3. The repo pins
    // \`engines.node: 22.x\`, so this only fires if the package is consumed by a
    // bare Node ESM runtime older than that — surface it clearly rather than
    // failing on an undefined call.
    throw new Error(
      'No global require, and process.getBuiltinModule is unavailable. ' +
        'Loading board-art-geometry shards from bare Node ESM needs Node 22.3+ (the repo pins engines.node 22.x).',
    );
  }
  const moduleBuiltin = getBuiltinModule('node:module') as {
    createRequire: (path: string | URL) => (path: string) => unknown;
  };
  // Anchor createRequire to *this* module's URL so the relative shard paths
  // resolve next to the index, regardless of the caller's cwd or how the
  // workspace is linked. \`import.meta.url\` is only read here, in the Node-only
  // branch — Metro/webpack/vitest take the global-\`require\` branch above and
  // never evaluate this function.
  cachedNodeRequire = moduleBuiltin.createRequire(import.meta.url);
  return cachedNodeRequire;
}

/* eslint-disable @typescript-eslint/no-require-imports */
export const BOARD_ART_GEOMETRY_SHARDS: Record<string, () => BoardArtGeometry> = {
${loaders}
};

/** Eager: 2 numbers per config, and the veil decision is made before any shard is needed. */
export const WALL_LIGHTNESS: WallLightnessTable = hasGlobalRequire
  ? (require('./wall-lightness.cjs') as WallLightnessTable)
  : (nodeRequire()('./wall-lightness.cjs') as WallLightnessTable);

/** Lazy: a generation record the gates pin, not something the renderer reads. */
export function loadOutlineCounts(): OutlineCountsTable {
  return hasGlobalRequire
    ? (require('./outline-counts.cjs') as OutlineCountsTable)
    : (nodeRequire()('./outline-counts.cjs') as OutlineCountsTable);
}
/* eslint-enable @typescript-eslint/no-require-imports */
`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function argumentValue(flag: string): string | null {
  const match = process.argv.find((argument) => argument.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : null;
}

/** Every `.cjs` shard currently on disk, as `<board>/<layout>-<size>` keys. */
function existingShardKeys(): string[] {
  if (!existsSync(GENERATED_DIR)) return [];
  const keys: string[] = [];
  for (const boardEntry of readdirSync(GENERATED_DIR, { withFileTypes: true })) {
    if (!boardEntry.isDirectory()) continue;
    for (const shardEntry of readdirSync(path.join(GENERATED_DIR, boardEntry.name), { withFileTypes: true })) {
      if (!shardEntry.isFile() || !shardEntry.name.endsWith('.cjs')) continue;
      keys.push(`${boardEntry.name}/${shardEntry.name.slice(0, -'.cjs'.length)}`);
    }
  }
  return keys.sort();
}

function writeOrCompare(
  relativePath: string,
  contents: string,
  checkOnly: boolean,
  stale: string[],
): 'written' | 'unchanged' | 'stale' {
  const absolutePath = path.join(GENERATED_DIR, relativePath);
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
  if (existing === contents) return 'unchanged';
  if (checkOnly) {
    stale.push(relativePath);
    return 'stale';
  }
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  return 'written';
}

async function main(): Promise<number> {
  const checkOnly = process.argv.includes('--check');
  const boardFilter = argumentValue('--board');
  const configFilter = argumentValue('--config');
  const filtered = boardFilter !== null || configFilter !== null;
  // A report run writes pictures and tables and touches no generated file, so a
  // before/after pair can be captured from a dirty tree without the drift gate
  // ever seeing it.
  const reportArgument = argumentValue('--report');
  const reportDir = reportArgument === null ? null : path.resolve(reportArgument);
  if (reportDir !== null) {
    mkdirSync(reportDir, { recursive: true });
    console.log(`[board-art-geometry] report run — writing to ${reportDir}, no generated files touched.`);
  }
  // `--report-crop=x,y,size`: also write `<key>-crop.png`, the same square of
  // board art twice, bare beside marked. A full-board sheet cannot show whether
  // a base-plate ring landed on the right edge — the plate is a few pixels wide
  // on a 1080-pixel board — so a reviewer needs one region at native scale.
  const cropArgument = argumentValue('--report-crop');
  let reportCrop: ReportCrop | null = null;
  if (cropArgument !== null) {
    const parts = cropArgument.split(',').map(Number);
    if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value) || value < 0)) {
      console.error(`[board-art-geometry] --report-crop expects three non-negative integers x,y,size`);
      return 1;
    }
    reportCrop = { left: parts[0], top: parts[1], width: parts[2], height: parts[2] };
  }

  const entries = listCatalogueEntries()
    .filter((entry) => boardFilter === null || entry.boardName === boardFilter)
    .filter((entry) => configFilter === null || `${entry.layoutId}-${entry.sizeId}` === configFilter)
    .sort((left, right) =>
      left.boardName === right.boardName
        ? left.layoutId - right.layoutId || left.sizeId - right.sizeId
        : left.boardName < right.boardName
          ? -1
          : 1,
    );

  if (entries.length === 0) {
    console.error(`[board-art-geometry] no catalogue entries matched ${boardFilter ?? ''} ${configFilter ?? ''}`);
    return 1;
  }

  const results: ConfigResult[] = [];
  const skipped: string[] = [];
  const perBoardMs = new Map<string, number>();
  const startedAt = Date.now();

  for (const entry of entries) {
    const measured = await measureConfig(entry, reportDir, reportCrop, perImageMaskProvider);
    if ('skipped' in measured) {
      skipped.push(measured.skipped);
      console.warn(`[board-art-geometry] SKIP ${measured.skipped}`);
      continue;
    }
    results.push(measured);
    perBoardMs.set(measured.boardName, (perBoardMs.get(measured.boardName) ?? 0) + measured.elapsedMs);
    console.log(
      `[board-art-geometry] ${measured.key.padEnd(20)} ${measured.summary} ` +
        `| wall L ${measured.wall.mean} coverage ${measured.wall.coverage} ` +
        `| ${measured.tables.ledBright.size} painted LEDs | ${(measured.elapsedMs / 1000).toFixed(1)}s`,
    );
    console.log(
      `[board-art-geometry] ${' '.repeat(20)} ${describeLedRings(measured.ledRings)} ` +
        `| ${measured.ledRings.qualified ? 'EMITTED' : 'not emitted'}`,
    );
  }

  if (reportDir !== null) {
    const header =
      `${'shard'.padEnd(16)}  ${'traced'.padStart(11)}  ${'chopped'.padStart(7)}  ${'pulled'.padStart(6)}  ` +
      `${'recMean'.padStart(7)}  ${'recP10'.padStart(6)}  ${'recMin'.padStart(6)}`;
    const rows = results.map(
      (result) =>
        `${result.report.key.padEnd(16)}  ` +
        `${`${result.report.traced}/${result.report.placements}`.padStart(11)}  ` +
        `${String(result.report.chopped).padStart(7)}  ${String(result.report.pulledBack).padStart(6)}  ` +
        `${result.report.recoveryMean.toFixed(3).padStart(7)}  ${result.report.recoveryP10.toFixed(3).padStart(6)}  ` +
        `${result.report.recoveryMin.toFixed(3).padStart(6)}`,
    );
    writeFileSync(
      path.join(reportDir, 'summary.txt'),
      `Board-art tracer report — ${results.length} config(s), ${skipped.length} skipped.\n` +
        `chopped = traced outlines keeping less than ${MIN_AREA_RECOVERY} of the connected art body\n` +
        `their seed sits on.\n` +
        `Stroke colours in the PNGs: green traced clean, amber pulled back off a neighbour,\n` +
        `red chopped, dashed grey untraced (the renderer falls back to a ring),\n` +
        `cyan the extracted LED base plate's inner edge.\n\n` +
        `${header}\n${rows.join('\n')}\n\n` +
        `LED base-plate extraction (a config emits a ledInner table only above ` +
        `${(MIN_CONFIG_ACCEPTANCE * 100).toFixed(0)}%):\n` +
        results
          .map(
            (result) =>
              `  ${result.key.padEnd(16)}  ${result.ledRings.qualified ? 'EMITTED    ' : 'not emitted'}  ` +
              describeLedRings(result.ledRings),
          )
          .join('\n') +
        `\n` +
        (skipped.length > 0 ? `\nskipped:\n${skipped.map((line) => `  - ${line}`).join('\n')}\n` : ''),
    );
    console.log(`[board-art-geometry] report written to ${reportDir}`);
    // Falls through deliberately when `--check` is also set. A report run that
    // swallowed the drift comparison would let `--report --check` exit 0 on a
    // stale tree, which is the one thing `--check` exists to prevent. Without
    // `--check` the writes below are ordinary generation and a report run is
    // meant to touch nothing, so it stops here.
    if (!checkOnly) return 0;
  }

  const stale: string[] = [];
  let written = 0;
  let shardBytes = 0;

  for (const result of results) {
    const contents = renderShard(result);
    shardBytes += Buffer.byteLength(contents);
    if (writeOrCompare(`${result.key}.cjs`, contents, checkOnly, stale) === 'written') written += 1;
  }

  if (filtered) {
    console.log('[board-art-geometry] filtered run — wall-lightness.cjs, outline-counts.cjs and shards.ts left alone.');
  } else {
    if (writeOrCompare('wall-lightness.cjs', renderWallLightness(results), checkOnly, stale) === 'written') {
      written += 1;
    }
    if (writeOrCompare('outline-counts.cjs', renderOutlineCounts(results), checkOnly, stale) === 'written') {
      written += 1;
    }
    if (writeOrCompare('shards.ts', renderShardIndex(results), checkOnly, stale) === 'written') written += 1;

    // A config that leaves the catalogue leaves a shard behind that nothing
    // indexes; the drift gate has to see that too, or the tables and the index
    // silently disagree.
    const expected = new Set(results.map((result) => result.key));
    const orphaned = existingShardKeys().filter((key) => !expected.has(key));
    for (const key of orphaned) {
      if (checkOnly) stale.push(`${key}.cjs (orphaned — no catalogue entry)`);
      else {
        rmSync(path.join(GENERATED_DIR, `${key}.cjs`));
        console.log(`[board-art-geometry] removed orphaned ${key}.cjs`);
      }
    }
    // A board whose last config went away leaves an empty directory behind, which
    // git does not track but a later `existingShardKeys()` walk still visits.
    if (!checkOnly) {
      for (const boardEntry of readdirSync(GENERATED_DIR, { withFileTypes: true })) {
        if (!boardEntry.isDirectory()) continue;
        const boardDir = path.join(GENERATED_DIR, boardEntry.name);
        if (readdirSync(boardDir).length === 0) rmSync(boardDir, { recursive: true });
      }
    }
  }

  const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const perBoard = [...perBoardMs.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([boardName, milliseconds]) => `${boardName} ${(milliseconds / 1000).toFixed(1)}s`)
    .join(', ');
  console.log(
    `[board-art-geometry] ${results.length} config(s), ${skipped.length} skipped, ` +
      `${(shardBytes / 1024).toFixed(0)} KB of shards, ${wallSeconds}s wall (${perBoard})`,
  );

  if (checkOnly) {
    if (stale.length > 0) {
      console.error(
        `ERROR: ${stale.length} board-art-geometry file(s) are stale or missing:\n` +
          stale.map((file) => `  - ${file}`).join('\n') +
          `\nRun: vp run generate:board-art-geometry`,
      );
      return 1;
    }
    console.log('==> Board-art geometry tables are up to date.');
    return 0;
  }

  console.log(
    written === 0
      ? '==> Board-art geometry tables already up to date.'
      : `==> Wrote ${written} board-art geometry file(s).`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[board-art-geometry] failed:', error);
    process.exit(1);
  });
