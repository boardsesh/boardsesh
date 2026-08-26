/// <reference types="node" />

/**
 * Spike (issue #2202): trace the actual silhouette of every hold, on every board
 * the spike draws.
 *
 * Usage: vp run spike:hold-outlines
 *
 * The point of a halo, per the issue, is to show the *shape* of the hold so you
 * can find that shape on the wall — and hold sizes on one board range from a
 * fingernail-sized foot chip to a jug three times its width. A ring at the
 * placement radius says nothing about either. So this traces the real outline
 * out of the art's alpha channel and ships it as paths the renderer can stroke.
 *
 * Per placement: flood-fill the opaque region under the placement centre
 * (bounded to a box around it so a hold that touches its neighbour cannot run
 * away across the board), drop the limbs joined to it only through a thin neck,
 * follow the outer border of what is left, then simplify with Douglas-Peucker.
 * Coordinates are emitted as integers relative to the placement centre, so the
 * renderer adds cx/cy and strokes.
 *
 * Known limits, both visible in the output. Where a hold's art touches a
 * neighbour's, the pair is cut at the midline between the two bolts, so a rim
 * that genuinely belongs to the neighbour but sits nearer this bolt stays —
 * whatever survives the neck trim of it, which is anything joined to this hold's
 * body by 5 board px or more. And a placement with no art under it yields
 * nothing and is simply absent from the table; that is not an edge case on
 * MoonBoard — its placements are a synthetic 11x18 grid and most cells genuinely
 * have no hold — so consumers must fall back to a ring.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { getBoardRenderData } from '../src/lib/board-details';
import { SPIKE_BOARDS } from '../src/components/board-spike/spike-boards';

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const IMAGES_DIR = path.join(ROOT_DIR, 'packages/web/public/images');
const OUTPUT_FILE = path.join(ROOT_DIR, 'packages/mobile/src/components/board-spike/spike-hold-outlines.ts');

/** A pixel counts as hold if its alpha is at least this. */
const ALPHA_FLOOR = 96;
/**
 * Half-width of the search box around a placement, in placement radii. Generous
 * on purpose: the nearest-placement partition below is what stops a hold running
 * into its neighbour, so the box only has to be big enough to contain the
 * largest real hold. At 1.25 it was smaller than a Kilter Homewall mainline
 * hold, and 43% of that board's outlines came back with a piece of the box
 * boundary traced into them as a straight edge.
 */
const SEARCH_RADII = 2.6;
/**
 * Seed disc around the placement centre, as a fraction of the distance to the
 * nearest other placement. Big enough to step off a punched-out bolt hole, far
 * too small to reach a neighbour — the old "nearest filled pixel anywhere in the
 * box" rule put 22% of MoonBoard Masters' lit holds on the wrong hold, because
 * that board's placements are a synthetic grid and most cells have no art of
 * their own to find.
 */
const SEED_PITCH_FRACTION = 0.15;
const MIN_SEED_RADIUS = 4;
/** Fraction of perimeter allowed to sit on the search-box boundary before the trace is junk. */
const MAX_BOX_EDGE_SHARE = 0.1;
/** Douglas-Peucker tolerance in board pixels. Bigger = fewer points, blockier outline. */
const SIMPLIFY_EPSILON = 1.6;
/** Outlines shorter than this many pixels of perimeter are noise, not a hold. */
const MIN_PERIMETER_POINTS = 24;
/**
 * How far inside the art a pixel has to sit to count as the hold's core, in
 * board pixels. A limb that reaches the rest of the mask only through a neck too
 * thin to hold a pixel this far clear of the art's edge is not part of this
 * hold — see `trimThinNecks`.
 */
const NECK_TRIM_RADIUS = 3;
/**
 * Board pixels a trim has to drop before the run reports it, on the same
 * threshold design review 2's gate 5 fails an outline at. The two measures are
 * not the same — the run counts what `trimThinNecks` took off the raw region,
 * the gate counts what a plain open takes off the emitted polygon — so the run
 * line runs higher; sharing the threshold is what makes them comparable.
 */
const NOTABLE_TRIM_AREA = 20;

type Point = [number, number];

const ORTHOGONAL: readonly Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Discs of radius `NECK_TRIM_RADIUS`, as offsets. Testing a disc of background
 * pixels around each pixel is exactly a Euclidean distance transform thresholded
 * at the radius, without a chamfer pass's approximation error — at a radius of 3
 * the error would be most of the decision.
 *
 * The `<` on the erosion against `<=` on the dilation is deliberate, and it is
 * what sets the neck cut-off. The open disc is 25 offsets reaching 2 px along
 * the axes, so a straight limb keeps a core from 5 px wide up; the closed disc
 * is 29 offsets reaching 3, which would demand 7 and cut real 5- and 6-px rails.
 * Design review 2 asked for necks narrower than 4 px to go, so 5 is the wanted
 * cut-off. The dilation then has to be the wider of the two: it strictly
 * contains the erosion disc, so every pixel a core pixel needed filled to
 * qualify comes back, and no straight edge is shaved by the round trip.
 */
const NECK_EROSION_OFFSETS: Point[] = [];
const NECK_DILATION_OFFSETS: Point[] = [];
for (let dy = -NECK_TRIM_RADIUS; dy <= NECK_TRIM_RADIUS; dy += 1) {
  for (let dx = -NECK_TRIM_RADIUS; dx <= NECK_TRIM_RADIUS; dx += 1) {
    const squared = dx * dx + dy * dy;
    if (squared < NECK_TRIM_RADIUS * NECK_TRIM_RADIUS) NECK_EROSION_OFFSETS.push([dx, dy]);
    if (squared <= NECK_TRIM_RADIUS * NECK_TRIM_RADIUS) NECK_DILATION_OFFSETS.push([dx, dy]);
  }
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
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  return Math.abs(dy * point[0] - dx * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]) / length;
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
 * This is what makes touching holds separable. Without it a flood fill started
 * on one hold walks straight through the contact patch into its neighbour and
 * the pair traces as one blob — visible as a single glow covering three holds on
 * Kilter Homewall. With it, each hold's mask is clipped at the midline between
 * its own bolt and the next one, which is where a climber would say the hold
 * ends anyway.
 */
function buildLabelMap(
  width: number,
  height: number,
  placements: Array<{ id: number; cx: number; cy: number }>,
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
    for (const [dx, dy] of ORTHOGONAL) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = ny * width + nx;
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
 * The partition above is exact where two bolts are the arbiter, and this is the
 * failure it cannot see: where a small hold's bolt is closer to a strip of a
 * neighbour's rim than the neighbour's own bolt is, that strip stays 4-connected
 * to the small hold and the border follower traces it. Kilter Homewall's
 * STARTING 4628 came out as a numeral 6 — a body on the lit hold plus a 37
 * board-px tail running up-left along a pale sliver, which the glow arms then
 * paint across the unlit hold above it. Two more on that board and one on TB2
 * Mirror.
 *
 * Erode to the pixels sitting `NECK_TRIM_RADIUS` clear of the art's edge, keep
 * the one core the seed sits on, grow that core alone back over the mask it came
 * from, and keep what the seed can still reach. A neck thinner than the radius
 * carries no core of its own, so a limb behind one is never in the kept core and
 * never grows back; everything joined by real body survives.
 *
 * Growing only the seed's core is the order design review 2 change 2 asks for,
 * and it is the whole point. Dilating every core first and flooding afterwards
 * is `open(mask) ∩ seedComponent`, which re-bridges a limb carrying a core of
 * its own: the seed's dilation and the limb's meet inside the neck and the flood
 * walks across. Measured against this order, that kept 2,782 board px² on 37
 * outlines and dropped nothing extra anywhere — 1,301 of it on tension-mirror,
 * one of the two boards the change names, where hold 396's 1,225 px² region
 * carries a 484 px² lobe on a neck too thin to hold a core.
 *
 * The mask is hole-filled first, because the outer border is the only thing this
 * script emits. Without that, the punched-out bolt hole a placement usually sits
 * on counts as edge: the erosion eats the rim around it from both sides at once,
 * and on a small hold with a big hole the whole rim goes, leaving a C the border
 * follower walks into and out of. Eleven MoonBoard silhouettes came back as
 * self-crossing polygons that no longer contained their own placement. With the
 * hole-fill in place this order is cheap on the boards it was once said to
 * wreck: four MoonBoard 2016 outlines differ from the dilate-all order, by 6 to
 * 40 px², and gate 1 — "every outline contains its own placement" — is zero on
 * all seven boards.
 *
 * Two fallbacks keep it off holds that have no body to judge a limb against. A
 * mask with no core at all comes back untouched; that is defensive and fires on
 * none of the 2,360 placements the trim runs over, but it is what fixes the
 * radius at 3 rather than higher — MoonBoard 2016's hold 148, the narrowest rail
 * on any of the seven boards, survives on a core of roughly 6 px, and a wider
 * disc would take the whole hold instead of a limb of it. And where the seed's
 * own pixel is not core, which happens on 13 of those 2,360, the largest core
 * stands in for it; if even that grows back without covering the seed, the mask
 * is returned untouched — a guard, not a measured behaviour: it too fires on
 * none of the seven boards.
 */
function trimThinNecks(mask: Uint8Array, width: number, height: number, seedIndex: number): Uint8Array {
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
    for (const [dx, dy] of NECK_EROSION_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      // Off the search box counts as background: art cut by the box has been cut
      // somewhere arbitrary, and an arbitrary cut is not a core.
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || solid[ny * width + nx] !== 1) {
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
  // hole's rim or on art thinner than the radius it is on no core at all, and
  // the largest core stands in — design review 2 change 2's "keep the largest
  // component", which is not a tie-break but the only anchor those holds have.
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
    for (const [dx, dy] of NECK_DILATION_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = ny * width + nx;
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

/** Distance from each placement to its nearest neighbour, used to size the seed disc. */
function nearestPitch(placements: Array<{ cx: number; cy: number }>): number[] {
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

/** One board's silhouettes, plus the one-line count the generated file carries. */
type TracedBoard = { outlines: Map<number, number[]>; summary: string };

async function traceBoard(
  boardKey: string,
  boardName: string,
  layoutId: number,
  sizeId: number,
  setIds: number[],
): Promise<TracedBoard> {
  const renderData = getBoardRenderData({ boardName: boardName as never, layoutId, sizeId, setIds });
  if (!renderData) throw new Error(`${boardKey}: no render data`);
  const { boardWidth, boardHeight, holdsData, backgroundImageKeys } = renderData;
  const rawLayer = { width: boardWidth, height: boardHeight, channels: 4 as const };

  let composite: Buffer | null = null;
  for (const key of backgroundImageKeys) {
    // Board art is authored at assorted sizes; the placement coordinates are in
    // board space, so every layer is resampled to it before compositing.
    const layer = await sharp(path.join(IMAGES_DIR, key))
      .resize(boardWidth, boardHeight, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    composite =
      composite === null
        ? layer
        : await sharp(composite, { raw: rawLayer })
            .composite([{ input: layer, raw: rawLayer, blend: 'over' }])
            .raw()
            .toBuffer();
  }
  if (composite === null) throw new Error(`${boardKey}: no layers`);

  const opaque = new Uint8Array(boardWidth * boardHeight);
  for (let pixel = 0; pixel < boardWidth * boardHeight; pixel += 1) {
    opaque[pixel] = composite[pixel * 4 + 3] >= ALPHA_FLOOR ? 1 : 0;
  }

  const placementList = holdsData.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy }));
  const label = buildLabelMap(boardWidth, boardHeight, placementList);
  const pitches = nearestPitch(placementList);

  const outlines = new Map<number, number[]>();
  let missing = 0;
  let rejectedBox = 0;
  let neckTrimmed = 0;

  for (const [placementIndex, placement] of holdsData.entries()) {
    if (outlines.has(placement.id)) continue;
    const centreX = Math.round(placement.cx);
    const centreY = Math.round(placement.cy);
    const box = Math.round(placement.r * SEARCH_RADII);

    const left = Math.max(0, centreX - box);
    const top = Math.max(0, centreY - box);
    const right = Math.min(boardWidth - 1, centreX + box);
    const bottom = Math.min(boardHeight - 1, centreY + box);
    if (right <= left || bottom <= top) {
      missing += 1;
      continue;
    }
    const localWidth = right - left + 1;
    const localHeight = bottom - top + 1;

    // The mask is this placement's own territory only: opaque art whose nearest
    // placement is this one.
    const local = new Uint8Array(localWidth * localHeight);
    for (let y = 0; y < localHeight; y += 1) {
      for (let x = 0; x < localWidth; x += 1) {
        const global = (top + y) * boardWidth + (left + x);
        local[y * localWidth + x] = opaque[global] === 1 && label[global] === placementIndex ? 1 : 0;
      }
    }

    // Seed strictly near the placement, never "nearest filled pixel in the box".
    const seedRadius = Math.max(MIN_SEED_RADIUS, pitches[placementIndex] * SEED_PITCH_FRACTION);
    const localCentre: Point = [centreX - left, centreY - top];
    let seed: Point | null = null;
    let bestDistance = Infinity;
    const seedBound = Math.ceil(seedRadius);
    for (let dy = -seedBound; dy <= seedBound; dy += 1) {
      for (let dx = -seedBound; dx <= seedBound; dx += 1) {
        const distance = dx * dx + dy * dy;
        if (distance > seedRadius * seedRadius || distance >= bestDistance) continue;
        const x = localCentre[0] + dx;
        const y = localCentre[1] + dy;
        if (x < 0 || y < 0 || x >= localWidth || y >= localHeight) continue;
        if (local[y * localWidth + x] !== 1) continue;
        bestDistance = distance;
        seed = [x, y];
      }
    }
    // No art of its own under the placement: emit nothing and let the renderer
    // fall back. On the synthetic MoonBoard grids this is the honest answer for
    // most cells.
    if (seed === null) {
      missing += 1;
      continue;
    }

    const seedIndex = seed[1] * localWidth + seed[0];
    const region = new Uint8Array(localWidth * localHeight);
    floodComponent(local, localWidth, localHeight, seedIndex, region);

    const traced = trimThinNecks(region, localWidth, localHeight, seedIndex);
    let droppedArea = 0;
    for (let index = 0; index < region.length; index += 1) {
      if (region[index] === 1 && traced[index] !== 1) droppedArea += 1;
    }

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
      missing += 1;
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
      missing += 1;
      continue;
    }
    // Counted here, not at the trim: an outline that then fell back is not in
    // the table, and the gate measures the table.
    if (droppedArea > NOTABLE_TRIM_AREA) neckTrimmed += 1;
    outlines.set(placement.id, flat);
  }

  // No area backstop. Before the partition, a flood fill could walk through a
  // contact patch into the neighbouring hold, and an "area far above the board
  // median" rule was the only way to catch it. After it, a region is by
  // construction made only of pixels whose nearest placement is this one, so it
  // cannot reach another placement's centre and a merge is not expressible.
  // The rule was still firing — on Grasshopper it deleted 14 outlines, and
  // rendering them showed they were the board's genuinely large square holds,
  // not merges. A board with a 6x spread of hold sizes has no safe global area
  // threshold; keeping one costs real holds to catch nothing.

  const summary =
    `${outlines.size}/${holdsData.length} traced ` +
    `(${missing} fell back: ${rejectedBox} hit the search box, ` +
    `${missing - rejectedBox} had no art of their own; ` +
    `${neckTrimmed} lost more than ${NOTABLE_TRIM_AREA} px² to a thin-necked limb)`;
  console.log(`[spike] ${boardKey.padEnd(24)} ${summary}`);
  return { outlines, summary };
}

async function main(): Promise<number> {
  const perBoard: Array<[string, TracedBoard]> = [];
  for (const board of SPIKE_BOARDS) {
    perBoard.push([
      board.key,
      await traceBoard(board.key, board.boardName, board.layoutId, board.sizeId, board.setIds),
    ]);
  }

  const body = perBoard
    .map(([boardKey, { outlines }]) => {
      const entries = [...outlines.entries()].sort((a, b) => a[0] - b[0]);
      return `  '${boardKey}': {\n${entries.map(([holdId, flat]) => `    ${holdId}: [${flat.join(',')}],`).join('\n')}\n  },`;
    })
    .join('\n');

  // The run's own counts, written into the file rather than left in a terminal
  // scrollback: the traced-vs-placements split is quoted in the review and in
  // docs/spike/board-rendering-2202/, and a table that carries the numbers of the
  // run that wrote it cannot drift from them.
  const counts = perBoard.map(([boardKey, { summary }]) => `// ${boardKey.padEnd(24)} ${summary}`).join('\n');

  writeFileSync(
    OUTPUT_FILE,
    `// Generated by packages/mobile/scripts/spike-hold-outlines.ts — do not edit by hand.\n` +
      `// Each hold's real silhouette, traced out of the board art's alpha channel, as flat\n` +
      `// [x0, y0, x1, y1, ...] board pixels RELATIVE to the placement centre, keyed by the\n` +
      `// board keys in spike-boards.ts. A placement with no traceable art is absent.\n` +
      `//\n` +
      `// What the run that wrote this file counted:\n` +
      `${counts}\n` +
      `export const SPIKE_HOLD_OUTLINES: Record<string, Record<number, number[]>> = {\n${body}\n};\n`,
  );
  console.log(`[spike] wrote ${path.relative(ROOT_DIR, OUTPUT_FILE)}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[spike] failed:', error);
    process.exit(1);
  });
