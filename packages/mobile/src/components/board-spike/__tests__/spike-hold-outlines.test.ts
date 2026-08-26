import { describe, expect, it } from 'vitest';
import { getBoardRenderData } from '../../../lib/board-details';
import { SPIKE_BOARDS, type SpikeBoardConfig } from '../spike-boards';
import { SPIKE_HOLD_OUTLINES } from '../spike-hold-outlines';

/**
 * Design review §5's pre-rollout capture gates, run against the committed
 * `SPIKE_HOLD_OUTLINES` table (issue #2202).
 *
 * They were written as "throwaway scripts to re-run after changing the tracer",
 * and that is exactly why the record drifted: nobody re-ran them, and the
 * README's traced counts stayed on a pre-fix run for two rounds of fixes. The
 * whole table is 2,360 polygons of at most ~40 points, so all five gates cost a
 * couple of seconds — cheap enough that they belong in CI rather than in a
 * paragraph telling the next person to write them again.
 *
 * Every gate carries a fixture that must trip it. A silhouette gate that has
 * never failed is indistinguishable from one that cannot fail, and three of the
 * five were originally reported against defects that are now zero everywhere.
 */

/**
 * Mirrors of `scripts/spike-hold-outlines.ts`. Deliberately restated rather than
 * imported: the generator is a node script that pulls in sharp, and a gate that
 * shares its constants with the code it audits stops being a check on anything
 * the moment one of them moves.
 */
const SEARCH_RADII = 2.6;
const MAX_BOX_EDGE_SHARE = 0.1;
const NECK_TRIM_RADIUS = 3;

/** Within this of an image axis, a segment is straight enough to be a crop-box side. */
const AXIS_TOLERANCE = Math.tan((2 * Math.PI) / 180);
/** A crop rectangle is four axis-aligned runs and almost nothing else; a hold never is. */
const CROP_BOX_MIN_RUNS = 4;
const CROP_BOX_PERIMETER_SHARE = 0.8;
/** Board px² a 3-px open may cost an outline before the trimmed part counts as a spur. */
const MAX_SPUR_AREA = 20;

/**
 * Gate 4's pins: traced outlines against total placements, per board.
 *
 * Read out of the committed table, not copied from a document. The MoonBoard
 * shortfalls are the honest answer — those layouts are a synthetic 11x18 grid
 * and most cells carry no hold — so what this gate watches is movement, in
 * either direction. A drop means the seed containment got too tight; a jump on
 * MoonBoard means the tracer started finding holds that are not there.
 */
const PINNED_OUTLINE_COUNTS: Record<string, { traced: number; placements: number }> = {
  'grasshopper-master': { traced: 332, placements: 332 },
  'tension-classic': { traced: 303, placements: 303 },
  'tension-mirror-12x12': { traced: 498, placements: 498 },
  'kilter-homewall-10x12': { traced: 499, placements: 499 },
  'kilter-original-12x12': { traced: 476, placements: 476 },
  'moonboard-2016': { traced: 140, placements: 198 },
  'moonboard-masters-2019': { traced: 112, placements: 198 },
};

type Placement = { id: number; cx: number; cy: number; r: number };

/** Crossing-count containment for a flat [x0, y0, x1, y1, ...] polygon. */
function containsPoint(flat: number[], pointX: number, pointY: number): boolean {
  let inside = false;
  const count = flat.length / 2;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const currentX = flat[index * 2];
    const currentY = flat[index * 2 + 1];
    const previousX = flat[previous * 2];
    const previousY = flat[previous * 2 + 1];
    if (currentY > pointY === previousY > pointY) continue;
    const crossingX = ((previousX - currentX) * (pointY - currentY)) / (previousY - currentY) + currentX;
    if (pointX < crossingX) inside = !inside;
  }
  return inside;
}

/**
 * Share of perimeter lying on the search-box boundary. A trace that ran into the
 * box and followed it always has one; a real silhouette never does. This is the
 * generator's own backstop restated, so the gate catches a box edge that slipped
 * past a loosened threshold rather than only one the generator already rejects.
 */
function boxEdgeShare(flat: number[], box: number): number {
  let onEdge = 0;
  let perimeter = 0;
  const count = flat.length / 2;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const length = Math.hypot(flat[next * 2] - flat[index * 2], flat[next * 2 + 1] - flat[index * 2 + 1]);
    perimeter += length;
    const onVertical = Math.abs(Math.abs(flat[index * 2]) - box) <= 1 && Math.abs(Math.abs(flat[next * 2]) - box) <= 1;
    const onHorizontal =
      Math.abs(Math.abs(flat[index * 2 + 1]) - box) <= 1 && Math.abs(Math.abs(flat[next * 2 + 1]) - box) <= 1;
    if (onVertical || onHorizontal) onEdge += length;
  }
  return perimeter === 0 ? 1 : onEdge / perimeter;
}

/**
 * Maximal runs of consecutive segments pointing the same way along an image
 * axis, and what share of the perimeter they carry. The direction's sign counts:
 * a rectangle is four runs (right, down, left, up) covering all of it, which is
 * the signature; a hold that happens to have two parallel flats is two.
 */
function axisAlignedRuns(flat: number[]): { runs: number; share: number } {
  const count = flat.length / 2;
  const directions = new Int8Array(count).fill(-1);
  const lengths = new Float64Array(count);
  let perimeter = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const deltaX = flat[next * 2] - flat[index * 2];
    const deltaY = flat[next * 2 + 1] - flat[index * 2 + 1];
    const length = Math.hypot(deltaX, deltaY);
    lengths[index] = length;
    perimeter += length;
    if (length === 0) continue;
    if (Math.abs(deltaY) <= AXIS_TOLERANCE * Math.abs(deltaX)) directions[index] = deltaX > 0 ? 0 : 1;
    else if (Math.abs(deltaX) <= AXIS_TOLERANCE * Math.abs(deltaY)) directions[index] = deltaY > 0 ? 2 : 3;
  }

  let runs = 0;
  let axisLength = 0;
  for (let index = 0; index < count; index += 1) {
    if (directions[index] === -1) continue;
    axisLength += lengths[index];
    if (directions[(index - 1 + count) % count] !== directions[index]) runs += 1;
  }
  return { runs, share: perimeter === 0 ? 0 : axisLength / perimeter };
}

type Raster = { filled: Uint8Array; width: number; height: number; area: number };

/** The polygon's interior plus its border, as a local bitmap in board pixels. */
function rasterise(flat: number[]): Raster {
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
  const left = Math.floor(minX) - 1;
  const top = Math.floor(minY) - 1;
  const width = Math.ceil(maxX) - left + 2;
  const height = Math.ceil(maxY) - top + 2;
  const filled = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const scanY = top + y;
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
      const from = Math.max(0, Math.ceil(crossings[pair] - left));
      const to = Math.min(width - 1, Math.floor(crossings[pair + 1] - left));
      for (let x = from; x <= to; x += 1) filled[y * width + x] = 1;
    }
  }

  // The vertices are border pixels of the original mask, so the border itself is
  // part of the hold. Scanline alone drops it wherever a side runs shallower
  // than a pixel per row, which on a 3-px-wide limb is most of it.
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const fromX = flat[index * 2] - left;
    const fromY = flat[index * 2 + 1] - top;
    const toX = flat[next * 2] - left;
    const toY = flat[next * 2 + 1] - top;
    const steps = Math.max(1, Math.abs(toX - fromX), Math.abs(toY - fromY));
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(fromX + ((toX - fromX) * step) / steps);
      const y = Math.round(fromY + ((toY - fromY) * step) / steps);
      if (x >= 0 && y >= 0 && x < width && y < height) filled[y * width + x] = 1;
    }
  }

  let area = 0;
  for (let index = 0; index < filled.length; index += 1) area += filled[index];
  return { filled, width, height, area };
}

const NECK_EROSION_OFFSETS: Array<[number, number]> = [];
const NECK_DILATION_OFFSETS: Array<[number, number]> = [];
for (let dy = -NECK_TRIM_RADIUS; dy <= NECK_TRIM_RADIUS; dy += 1) {
  for (let dx = -NECK_TRIM_RADIUS; dx <= NECK_TRIM_RADIUS; dx += 1) {
    const squared = dx * dx + dy * dy;
    if (squared < NECK_TRIM_RADIUS * NECK_TRIM_RADIUS) NECK_EROSION_OFFSETS.push([dx, dy]);
    if (squared <= NECK_TRIM_RADIUS * NECK_TRIM_RADIUS) NECK_DILATION_OFFSETS.push([dx, dy]);
  }
}

/**
 * Board px² a plain 3-px morphological open cuts away from the polygon — the
 * spur measure design review 2's change 2 asked gate 5 for, and not a perimeter
 * one: a 37-board-px tail that paints across the neighbouring hold barely moves
 * the perimeter share, because the tail has perimeter of its own.
 *
 * Erode, dilate every core back inside the mask, and count what never came
 * back. That is deliberately *not* how `scripts/spike-hold-outlines.ts` trims —
 * the tracer grows the seed's core alone, which is the stricter of the two — so
 * this measures the shipped polygons instead of replaying the code that made
 * them. A gate that reproduces the generator's own order passes whatever that
 * order emits.
 *
 * A mask with no core comes back untouched, which is change 2's own "keep the
 * raw mask if nothing survives the erosion". Nothing on the seven boards is that
 * thin — MoonBoard 2016's hold 148, the narrowest rail there, still cores at
 * roughly 6 px — so the branch has no board to pin it and carries a fixture
 * instead.
 */
function openedArea(flat: number[]): number {
  const { filled, width, height } = rasterise(flat);

  const core = new Uint8Array(filled.length);
  for (let index = 0; index < filled.length; index += 1) {
    if (filled[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    let clear = true;
    for (const [dx, dy] of NECK_EROSION_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || filled[ny * width + nx] !== 1) {
        clear = false;
        break;
      }
    }
    if (clear) core[index] = 1;
  }

  const opened = new Uint8Array(filled.length);
  for (let index = 0; index < core.length; index += 1) {
    if (core[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    for (const [dx, dy] of NECK_DILATION_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (filled[ny * width + nx] === 1) opened[ny * width + nx] = 1;
    }
  }
  let survived = 0;
  for (let index = 0; index < opened.length; index += 1) survived += opened[index];
  return survived;
}

function spurArea(flat: number[]): number {
  const survived = openedArea(flat);
  // Change 2's own "keep the raw mask if nothing survives the erosion". Split
  // out from the measure rather than folded into it so a fixture can show the
  // unexempted open deleting the shape, which a `spurArea === 0` alone cannot:
  // an untouched hold and an exempted one both read 0.
  if (survived === 0) return 0;
  return rasterise(flat).area - survived;
}

type BoardAudit = {
  boardKey: string;
  traced: number;
  placements: number;
  withoutOwnPlacement: number[];
  withSecondPlacement: number[];
  onSearchBoxEdge: number[];
  cropBoxShaped: number[];
  spurred: number[];
};

function auditBoard(board: SpikeBoardConfig) {
  const { key: boardKey, boardName, layoutId, sizeId, setIds } = board;
  const renderData = getBoardRenderData({ boardName, layoutId, sizeId, setIds });
  if (renderData === null) throw new Error(`${boardKey}: no render data`);
  const placements: Placement[] = renderData.holdsData.map((hold) => ({
    id: hold.id,
    cx: hold.cx,
    cy: hold.cy,
    r: hold.r,
  }));
  const placementById = new Map(placements.map((placement) => [placement.id, placement]));
  const outlines = SPIKE_HOLD_OUTLINES[boardKey] ?? {};

  const audit: BoardAudit = {
    boardKey,
    traced: Object.keys(outlines).length,
    placements: placements.length,
    withoutOwnPlacement: [],
    withSecondPlacement: [],
    onSearchBoxEdge: [],
    cropBoxShaped: [],
    spurred: [],
  };

  for (const [holdIdText, flat] of Object.entries(outlines)) {
    const holdId = Number(holdIdText);
    const placement = placementById.get(holdId);
    if (placement === undefined) throw new Error(`${boardKey}: outline ${holdId} has no placement`);

    if (!containsPoint(flat, 0, 0)) audit.withoutOwnPlacement.push(holdId);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < flat.length; index += 2) {
      minX = Math.min(minX, flat[index]);
      maxX = Math.max(maxX, flat[index]);
      minY = Math.min(minY, flat[index + 1]);
      maxY = Math.max(maxY, flat[index + 1]);
    }
    for (const other of placements) {
      if (other.id === holdId) continue;
      const offsetX = other.cx - placement.cx;
      const offsetY = other.cy - placement.cy;
      if (offsetX < minX || offsetX > maxX || offsetY < minY || offsetY > maxY) continue;
      if (!containsPoint(flat, offsetX, offsetY)) continue;
      audit.withSecondPlacement.push(holdId);
      break;
    }

    const box = Math.round(placement.r * SEARCH_RADII);
    if (boxEdgeShare(flat, box) > MAX_BOX_EDGE_SHARE) audit.onSearchBoxEdge.push(holdId);
    const { runs, share } = axisAlignedRuns(flat);
    if (runs >= CROP_BOX_MIN_RUNS && share > CROP_BOX_PERIMETER_SHARE) audit.cropBoxShaped.push(holdId);
    if (spurArea(flat) > MAX_SPUR_AREA) audit.spurred.push(holdId);
  }
  return audit;
}

const AUDITS = SPIKE_BOARDS.map(auditBoard);

describe('SPIKE_HOLD_OUTLINES gates', () => {
  it('gate 1: every outline contains its own placement', () => {
    for (const audit of AUDITS) expect([audit.boardKey, audit.withoutOwnPlacement]).toEqual([audit.boardKey, []]);
  });

  it('gate 2: no outline contains a second placement', () => {
    for (const audit of AUDITS) expect([audit.boardKey, audit.withSecondPlacement]).toEqual([audit.boardKey, []]);
  });

  it('gate 3: no outline traces the search box', () => {
    for (const audit of AUDITS) {
      expect([audit.boardKey, audit.onSearchBoxEdge]).toEqual([audit.boardKey, []]);
      expect([audit.boardKey, audit.cropBoxShaped]).toEqual([audit.boardKey, []]);
    }
  });

  it('gate 4: traced count per board holds at the pinned figures', () => {
    const measured = Object.fromEntries(
      AUDITS.map((audit) => [audit.boardKey, { traced: audit.traced, placements: audit.placements }]),
    );
    expect(measured).toEqual(PINNED_OUTLINE_COUNTS);
  });

  // Zero, with no exceptions. Kilter Homewall 4135 and 4634 were pinned here as
  // known failures while the tracer grew every core at once; growing only the
  // seed's core dropped both limbs, and the worst outline on any board now loses
  // 16 px² of the 20 allowed, on kilter-homewall 4219.
  it('gate 5: no outline loses more than 20 board px² to a thin-necked limb', () => {
    for (const audit of AUDITS) {
      expect([audit.boardKey, audit.spurred]).toEqual([audit.boardKey, []]);
    }
  });
});

describe('SPIKE_HOLD_OUTLINES gate fixtures', () => {
  // A silhouette that misses its own placement: a ring sitting off to one side,
  // which is what a neighbour leak produced before the partition landed.
  const OFF_PLACEMENT = [20, -10, 40, -10, 40, 10, 20, 10];
  // The generator's rejected crop-rectangle fallback, at a search box of 40.
  const CROP_BOX = [-40, -40, 40, -40, 40, 40, -40, 40];
  // A 31x31 body with a 30x3 tail — change 2's "numeral 6", minus the curves.
  const SPURRED = [-15, -15, 15, -15, 15, -1, 45, -1, 45, 1, 15, 1, 15, 15, -15, 15];
  // A 4x35 rail: too narrow for a single core pixel at radius 3, so the open
  // would delete the whole hold and the measure has to exempt it. One column
  // wider and it cores 31 pixels and comes back whole through the ordinary
  // path, which is the branch this fixture is here NOT to take.
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
    expect(boxEdgeShare(SPURRED, 40)).toBeLessThan(MAX_BOX_EDGE_SHARE);
  });

  it('gate 5 catches a thin-necked limb and leaves a plain hold alone', () => {
    expect(spurArea(SPURRED)).toBeGreaterThan(MAX_SPUR_AREA);
    expect(spurArea(CROP_BOX)).toBe(0);
  });

  it('gate 5 exempts a hold too thin to core rather than deleting it', () => {
    // Nothing survives the erosion, so an unexempted open takes the whole rail.
    expect(openedArea(RAIL)).toBe(0);
    expect(spurArea(RAIL)).toBe(0);
    // One column wider it cores and comes back whole, so the exemption is not
    // what a plain 5-px rail is relying on.
    expect(openedArea([-2, -17, 2, -17, 2, 17, -2, 17])).toBeGreaterThan(0);
    expect(spurArea([-2, -17, 2, -17, 2, 17, -2, 17])).toBe(0);
  });
});
