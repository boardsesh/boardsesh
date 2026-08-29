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
 * One `(board, layout, size)` with EVERY set of that layout and size mounted.
 * The nearest-placement partition below is only conservative when all the
 * neighbours are present: trace a subset and a hold whose neighbour is missing
 * grows into the space that neighbour would have occupied. Per-subset shards
 * would also be combinatorial (Decoy 2-1 mounts 19 layers) for a difference no
 * renderer draws.
 *
 * THE THREE BUGS THE DESIGN REVIEW FOUND, and the rule each one bought:
 *   1. A flood fill walks through a contact patch into the neighbouring hold and
 *      the pair traces as one blob — one glow covering three holds on Kilter
 *      Homewall. Fixed by the nearest-placement partition (`buildLabelMap`).
 *   2. A hold keeps a limb joined to it only through a thin neck of a
 *      neighbour's rim — Kilter Homewall's STARTING 4628 traced as a numeral 6.
 *      Fixed by the erosion/dilation neck trim (`trimThinNecks`).
 *   3. Where two holds' art genuinely touches, the partition cut runs through
 *      solid art, so the mark's brightest band lands ON the neighbour. Fixed by
 *      the contact pullback (`pullBackFromCuts`).
 * Every one of those is restated as a gate in the package's tests.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { listCatalogueEntries } from '../packages/shared/board-render/src/render-version-projection';
import { getBoardDetailsForBoard } from '../packages/shared/board-render/src/board-details';
import { getBackgroundRelPaths } from '../packages/shared/board-render/src/background';
import type { BoardRenderDetails, RenderableHold } from '../packages/shared/board-render/src/types';

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
 * Seed disc around the placement centre, as a fraction of the distance to the
 * nearest other placement. Big enough to step off a punched-out bolt hole, far
 * too small to reach a neighbour — the old "nearest filled pixel anywhere in the
 * box" rule put 22% of MoonBoard Masters' lit holds on the wrong hold.
 */
const SEED_PITCH_FRACTION = 0.15;
const MIN_SEED_RADIUS = 4;
/** Fraction of perimeter allowed on the search-box boundary before the trace is junk. */
const MAX_BOX_EDGE_SHARE = 0.1;
/** Douglas-Peucker tolerance in board pixels. Bigger = fewer points, blockier outline. */
const SIMPLIFY_EPSILON = 1.6;
/** Outlines shorter than this many pixels of perimeter are noise, not a hold. */
const MIN_PERIMETER_POINTS = 24;
/**
 * The board width the two radii below are quoted at, and the width the play view
 * renders at. MoonBoard's art box is 650 px wide against 1080 for most of the
 * catalogue, so an absolute board-pixel radius bites 1.66x harder there.
 */
const RADIUS_REFERENCE_WIDTH = 1080;
/**
 * How far inside the art a pixel has to sit to count as the hold's core, at the
 * reference width. A limb reaching the rest of the mask only through a neck too
 * thin to hold a pixel this far clear of the art's edge is not part of this hold.
 * Both MoonBoards come out at 2, which is the same 5 board px of neck at 1080
 * the wider boards get; a flat 3 cut a real lobe off two MoonBoard 2016 holds.
 */
const NECK_TRIM_AT_REFERENCE = 3;
/**
 * How far the emitted silhouette keeps clear of a neighbour's art, at the
 * reference width. 3 covers the glow's own shoulder, so the mark's brightest ink
 * lands on the hold's own art everywhere. At 2 the shoulder ink sitting on a
 * neighbour is 731 board px² over the spike's seven boards against 25 at 3; at 4
 * it saves 3 more px² and costs another 22,148 px² of hold.
 */
const CUT_CLEARANCE_AT_REFERENCE = 3;
/** Board px² a trim has to drop before the run reports it, on gate 5's threshold. */
const NOTABLE_TRIM_AREA = 20;
/**
 * Share of a placement's own partition-cell art the emitted silhouette has to
 * keep before the hold counts as chopped.
 *
 * Not a tuning knob on the tracer — nothing branches on it — but the single
 * number the whole rework is measured by: `tracedArea / cellAlphaArea`, where the
 * denominator is every art pixel in the search box the partition gave to this
 * placement. A hold whose neck trim and pullback between them threw away more
 * than a fifth of its own art is a hold whose glow no longer matches the shape on
 * the wall, which is the defect this pipeline exists to avoid.
 */
const MIN_AREA_RECOVERY = 0.8;
/**
 * Opaque share of the composited board above which the art carries no silhouette
 * information at all, and the config is skipped.
 *
 * Every board here is a stack of mostly-transparent layers, and the whole tracer
 * reads that alpha channel — the hold IS the opaque region. Woods breaks the
 * rule: its art is an opaque photograph of the hold set on a white ground (the
 * same fact `scripts/generate-dark-board-art.ts` records for the opposite
 * reason), so the alpha channel is 100% filled and every "silhouette" the tracer
 * returns is a cell of the nearest-placement partition rather than a hold. Both
 * Woods sizes trace that way — a third of their placements hit the search box,
 * and every single one that survived had "pulled back off a neighbour's art",
 * which is what a board with no gutters looks like.
 *
 * Skipping is the honest answer: no shard means the renderer falls back to a
 * ring, which is what it draws for Woods today. The ceiling has a 2.3x margin —
 * Woods is 100.0% and the next densest board in the catalogue, Touchstone, is
 * 40.8% — so it is a check on "is there an alpha channel to read", not a tuning
 * knob. Separating Woods out by name instead would go stale the moment another
 * board ships photographic art.
 */
const OPAQUE_ART_CEILING = 0.95;
/** Decimals the emitted radius-unit coordinates keep. 4 is 0.005 board px at the smallest radius. */
const COORDINATE_DECIMALS = 4;
/** Decimals the emitted lightness readings keep, matching the spike's tables. */
const LIGHTNESS_DECIMALS = 3;

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
 * A radius quoted at `RADIUS_REFERENCE_WIDTH`, in this board's own pixels. The
 * floor of 2 is where a disc stops being one: at radius 1 the erosion disc is a
 * single pixel and the neck trim can never fire.
 */
function radiusForBoard(atReferenceWidth: number, boardWidth: number): number {
  return Math.max(2, Math.round((atReferenceWidth * boardWidth) / RADIUS_REFERENCE_WIDTH));
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
 * Nearest-placement label for every pixel, by two-pass chamfer propagation from
 * the placement centres.
 *
 * This is what makes touching holds separable. Without it a flood fill started on
 * one hold walks straight through the contact patch into its neighbour and the
 * pair traces as one blob. With it, each hold's mask is clipped at the midline
 * between its own bolt and the next one, which is where a climber would say the
 * hold ends anyway.
 */
function buildLabelMap(
  width: number,
  height: number,
  placements: ReadonlyArray<{ cx: number; cy: number }>,
): Int32Array {
  const label = new Int32Array(width * height).fill(-1);
  const distance = new Float64Array(width * height).fill(Infinity);
  for (const [index, placement] of placements.entries()) {
    const x = Math.round(placement.cx);
    const y = Math.round(placement.cy);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    label[y * width + x] = index;
    distance[y * width + x] = 0;
  }

  const relax = (from: number, to: number, step: number): void => {
    const candidate = distance[from] + step;
    if (candidate < distance[to]) {
      distance[to] = candidate;
      label[to] = label[from];
    }
  };
  const DIAGONAL = Math.SQRT2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const here = y * width + x;
      if (x > 0) relax(here - 1, here, 1);
      if (y > 0) relax(here - width, here, 1);
      if (y > 0 && x > 0) relax(here - width - 1, here, DIAGONAL);
      if (y > 0 && x < width - 1) relax(here - width + 1, here, DIAGONAL);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const here = y * width + x;
      if (x < width - 1) relax(here + 1, here, 1);
      if (y < height - 1) relax(here + width, here, 1);
      if (y < height - 1 && x < width - 1) relax(here + width + 1, here, DIAGONAL);
      if (y < height - 1 && x > 0) relax(here + width - 1, here, DIAGONAL);
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
function buildOpaqueMask(art: BoardArt): Uint8Array {
  const opaque = new Uint8Array(art.width * art.height);
  for (let pixel = 0; pixel < art.width * art.height; pixel += 1) {
    opaque[pixel] = art.pixels[pixel * 4 + 3] >= ALPHA_FLOOR ? 1 : 0;
  }
  return opaque;
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
  /** The placements this field owns. Every placement id is in at most one field. */
  placements: RenderableHold[];
  /** Pixel -> index into `placements`; -1 where no placement owns the pixel. */
  label: Int32Array;
  /** Half-width of a placement's search box in radii. `SEARCH_RADII` when absent. */
  searchRadii?: number;
};

/**
 * How a config's decoded art becomes fields to trace.
 *
 * The composite is passed in rather than re-derived because `measureConfig`
 * needs it anyway for every colour reading — silhouette lightness, the ring
 * annulus and the painted LEDs all measure what a climber SEES, which is the
 * stack rather than any one layer.
 */
type MaskProvider = (details: BoardRenderDetails, layers: DecodedLayer[], composite: BoardArt) => TraceField[];

/**
 * One field over the composited alpha channel: the whole board's art, the whole
 * board's placements, one partition.
 *
 * This is what the tracer did before the seam existed, kept as a provider so the
 * seam can be shown to change nothing.
 */
const compositeAlphaMaskProvider: MaskProvider = (details, _layers, composite) => {
  const placements = details.holdsData;
  return [
    {
      sourceKey: 'composite',
      width: composite.width,
      height: composite.height,
      mask: buildOpaqueMask(composite),
      placements,
      label: buildLabelMap(composite.width, composite.height, placements),
    },
  ];
};

/**
 * What one placement's trace cost, for the report and for gate 7.
 *
 * `cellAlphaArea` is the honest denominator: every art pixel inside the search
 * box that the partition gave to THIS placement, before any trim, pullback or
 * simplification. `tracedArea` is what survived to the emitted mask. Their ratio
 * is the only number that says whether the silhouette is still the hold's shape
 * or a fragment of it — perimeter measures and spur opens both read fine on a
 * hold that simply lost half of itself to a cut.
 */
type HoldTraceStats = {
  holdId: number;
  traced: boolean;
  /** Board px² of the emitted mask. 0 when the placement fell back to a ring. */
  tracedArea: number;
  /** Board px² of this placement's own art in the search box, pre-trim. */
  cellAlphaArea: number;
  /** `tracedArea / cellAlphaArea`, or 0 when there was no art to recover. */
  areaRecovery: number;
  /** Board px² the neck trim and the pullback dropped between them. */
  droppedArea: number;
  pulledBack: boolean;
  /** Why the placement carries no outline, or `null` when it does. */
  fallbackReason: 'search-box-degenerate' | 'no-art-of-its-own' | 'perimeter-too-short' | 'traced-the-box' | null;
};

/** The counters the run's one-line summary is built from, per field. */
type TraceCounts = { attempted: number; rejectedBox: number; neckTrimmed: number; pulledBack: number };

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
  const { width: boardWidth, height: boardHeight, mask: opaque, label, placements } = field;
  const searchRadii = field.searchRadii ?? SEARCH_RADII;
  const pitches = nearestPitch(placements);
  const neckDiscs = discOffsets(radiusForBoard(NECK_TRIM_AT_REFERENCE, boardWidth));
  const clearanceOffsets = discOffsets(radiusForBoard(CUT_CLEARANCE_AT_REFERENCE, boardWidth)).dilation;

  const outlines = new Map<number, number[]>();
  const stats = new Map<number, HoldTraceStats>();
  let attempted = 0;
  let rejectedBox = 0;
  let neckTrimmed = 0;
  let pulledBack = 0;

  const recordFallback = (holdId: number, reason: NonNullable<HoldTraceStats['fallbackReason']>, cellArea: number) => {
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
  };

  for (const [placementIndex, placement] of placements.entries()) {
    // Guarded on the outline table, not on `stats`: a board can list the same
    // placement under two sets, and where the first attempt fell back the second
    // is retried exactly as it always was. `stats` is overwritten to match.
    if (outlines.has(placement.id)) continue;
    attempted += 1;
    const centreX = Math.round(placement.cx);
    const centreY = Math.round(placement.cy);
    const box = Math.round(placement.r * searchRadii);

    const left = Math.max(0, centreX - box);
    const top = Math.max(0, centreY - box);
    const right = Math.min(boardWidth - 1, centreX + box);
    const bottom = Math.min(boardHeight - 1, centreY + box);
    if (right <= left || bottom <= top) {
      recordFallback(placement.id, 'search-box-degenerate', 0);
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
    let cellAlphaArea = 0;
    for (let index = 0; index < local.length; index += 1) cellAlphaArea += local[index];

    // Seed strictly near the placement, never "nearest filled pixel in the box".
    const seedRadius = Math.max(MIN_SEED_RADIUS, pitches[placementIndex] * SEED_PITCH_FRACTION);
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
      recordFallback(placement.id, 'no-art-of-its-own', cellAlphaArea);
      continue;
    }

    const seedIndex = seed[1] * localWidth + seed[0];
    const region = new Uint8Array(localWidth * localHeight);
    floodComponent(local, localWidth, localHeight, seedIndex, region);

    const trimmed = trimThinNecks(region, localWidth, localHeight, seedIndex, neckDiscs);
    const pulled = pullBackFromCuts(trimmed, neighbourArt, localWidth, localHeight, seedIndex, clearanceOffsets);
    // Trim again, because the pullback makes necks of its own: a hold in contact
    // along two sides comes back joined through whatever the two clearance discs
    // left between them. Thirteen outlines on two boards failed gate 5 with a
    // single trim, and every one was a sliver the first trim never saw because it
    // did not exist yet.
    const traced = pulled.contacted
      ? trimThinNecks(pulled.mask, localWidth, localHeight, seedIndex, neckDiscs)
      : pulled.mask;

    let droppedArea = 0;
    for (let index = 0; index < region.length; index += 1) {
      if (region[index] === 1 && traced[index] !== 1) droppedArea += 1;
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
      recordFallback(placement.id, 'perimeter-too-short', cellAlphaArea);
      continue;
    }
    const simplified = simplify(border, SIMPLIFY_EPSILON);
    const flat: number[] = [];
    for (const [x, y] of simplified) {
      flat.push(Math.round(left + x - centreX), Math.round(top + y - centreY));
    }
    // Backstop: a trace that ran into the search box and followed it is not a
    // silhouette, whatever it looks like.
    if (boxEdgeShare(flat, box) > MAX_BOX_EDGE_SHARE) {
      rejectedBox += 1;
      recordFallback(placement.id, 'traced-the-box', cellAlphaArea);
      continue;
    }
    // Counted here, not where it was measured: an outline that then fell back is
    // not in the table, and the gates measure the table.
    if (droppedArea > NOTABLE_TRIM_AREA) neckTrimmed += 1;
    if (pulled.contacted) pulledBack += 1;
    outlines.set(placement.id, flat);
    stats.set(placement.id, {
      holdId: placement.id,
      traced: true,
      tracedArea,
      cellAlphaArea,
      areaRecovery: cellAlphaArea === 0 ? 0 : tracedArea / cellAlphaArea,
      droppedArea,
      pulledBack: pulled.contacted,
      fallbackReason: null,
    });
  }

  // No area backstop. Before the partition, a flood fill could walk through a
  // contact patch into the neighbouring hold, and an "area far above the board
  // median" rule was the only way to catch it. After it, a region is by
  // construction made only of pixels whose nearest placement is this one, so a
  // merge is not expressible — and the rule was deleting real outlines: on
  // Grasshopper it took 14, all of them the board's genuinely large square holds.
  return { outlines, stats, counts: { attempted, rejectedBox, neckTrimmed, pulledBack } };
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
  const totals: TraceCounts = { attempted: 0, rejectedBox: 0, neckTrimmed: 0, pulledBack: 0 };

  for (const field of fields) {
    const traced = traceOutlines(field);
    for (const [holdId, flat] of traced.outlines) {
      if (outlines.has(holdId)) throw new Error(`placement ${holdId} traced by two fields (${field.sourceKey})`);
      outlines.set(holdId, flat);
    }
    for (const [holdId, entry] of traced.stats) stats.set(holdId, entry);
    totals.attempted += traced.counts.attempted;
    totals.rejectedBox += traced.counts.rejectedBox;
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
    `${missing - totals.rejectedBox} had no art of their own; ` +
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
  }

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${art.width}" height="${art.height}">${shapes.join('')}</svg>`,
  );
  const imagePath = path.join(reportDir, `${row.key}.png`);
  mkdirSync(path.dirname(imagePath), { recursive: true });
  await sharp(art.pixels, { raw: { width: art.width, height: art.height, channels: 4 } })
    .flatten({ background: REPORT_BACKDROP })
    .composite([{ input: overlay }])
    .png()
    .toFile(imagePath);

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

async function measureConfig(
  entry: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    setIds: number[];
  },
  reportDir: string | null,
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
  if (opaqueShare >= OPAQUE_ART_CEILING) {
    return {
      skipped:
        `${key}: art is ${(opaqueShare * 100).toFixed(1)}% opaque — a photograph, not a stack of ` +
        `transparent hold layers, so there is no silhouette in the alpha channel to trace`,
    };
  }

  const placements = details.holdsData;
  const { outlines, summary, stats } = mergeFieldTraces(maskProvider(details, layers, art), placements);
  const uniquePlacements = new Set(placements.map((placement) => placement.id)).size;
  const reportRow = reportRowFor(key, uniquePlacements, stats);
  if (reportDir !== null) await writeConfigReport(reportDir, reportRow, art, placements, outlines, stats);

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

  const radiusById = new Map<number, number>();
  const centreById = new Map<number, [number, number]>();
  for (const placement of placements) {
    if (radiusById.has(placement.id)) continue;
    radiusById.set(placement.id, placement.r);
    centreById.set(placement.id, [placement.cx, placement.cy]);
  }

  const radiusUnitOutlines = new Map<number, number[]>();
  for (const [holdId, flat] of outlines) {
    const radius = radiusById.get(holdId) as number;
    const [exactX, exactY] = centreById.get(holdId) as [number, number];
    // The tracer works in integer board pixels offset from the ROUNDED centre.
    // Undo that rounding before dividing, so the emitted polygon is relative to
    // the exact placement centre a renderer positions the mark at.
    const roundingX = Math.round(exactX) - exactX;
    const roundingY = Math.round(exactY) - exactY;
    const converted: number[] = [];
    for (let index = 0; index < flat.length; index += 2) {
      converted.push(
        roundTo((flat[index] + roundingX) / radius, COORDINATE_DECIMALS),
        roundTo((flat[index + 1] + roundingY) / radius, COORDINATE_DECIMALS),
      );
    }
    radiusUnitOutlines.set(holdId, converted);
  }

  return {
    key,
    boardName: entry.boardName,
    layoutId: entry.layoutId,
    sizeId: entry.sizeId,
    tables: { outlines: radiusUnitOutlines, silhouetteLightness, ledBright },
    wall: {
      mean: annulusCount === 0 ? 0 : roundTo(annulusTotal / annulusCount, LIGHTNESS_DECIMALS),
      coverage: annulusPlacements === 0 ? 0 : roundTo(annulusCount / annulusPlacements, LIGHTNESS_DECIMALS),
    },
    counts: { traced: outlines.size, placements: annulusPlacements },
    summary,
    report: reportRow,
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

  return (
    `${DO_NOT_EDIT}\n` +
    `// ${result.key} — ${result.summary}\n` +
    `//\n` +
    `// outlines:            placementId -> flat [x0,y0,...] in units of the placement radius,\n` +
    `//                      relative to its centre. A placement with no traceable art is absent.\n` +
    `// silhouetteLightness: placementId -> OkLab L of the art inside the traced silhouette.\n` +
    `// ledBright:           placementId -> [dx,dy] radius units to the bright LED blob the art\n` +
    `//                      already paints, for the placements where it paints one.\n` +
    `module.exports = {\n` +
    `  outlines: {\n${outlineRows}${outlineRows ? '\n' : ''}  },\n` +
    `  silhouetteLightness: {\n${lightnessRows}${lightnessRows ? '\n' : ''}  },\n` +
    `  ledBright: {\n${ledRows}${ledRows ? '\n' : ''}  },\n` +
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
    const measured = await measureConfig(entry, reportDir, compositeAlphaMaskProvider);
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
        `chopped = traced outlines keeping less than ${MIN_AREA_RECOVERY} of their own partition-cell art.\n` +
        `Stroke colours in the PNGs: green traced clean, amber pulled back off a neighbour,\n` +
        `red chopped, dashed grey untraced (the renderer falls back to a ring).\n\n` +
        `${header}\n${rows.join('\n')}\n` +
        (skipped.length > 0 ? `\nskipped:\n${skipped.map((line) => `  - ${line}`).join('\n')}\n` : ''),
    );
    console.log(`[board-art-geometry] report written to ${reportDir}`);
    return 0;
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
