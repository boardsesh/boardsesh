/**
 * Brush editing for a stored hold outline: push an existing ring around with an
 * add/erase brush instead of re-tracing the whole loop.
 *
 * A stored outline is ONE flat, implicitly-closed ring (see `./ring`). A brush
 * stroke is not a ring — it is a swept disc that has to be unioned with, or
 * subtracted from, the area the ring encloses. So the edit round-trips through a
 * bitmap: rasterise the ring, paint the stroke into the bitmap, walk the border
 * back out. Every primitive that does the actual work lives in `./raster`,
 * shared with the tracer; this module is the composition, and the rules about
 * what to do when the result stops being a single clean blob.
 *
 * UNITS. Everything here is in BOARD PIXELS, never radius units, for the reason
 * `./ring` states about `SIMPLIFY_EPSILON_BOARD_PX`: the decimation tolerance is
 * quoted in board pixels, so the ring has to still be in board pixels when it is
 * simplified. The caller converts to radius units afterwards, exactly as
 * `buildOutlineRing` does for a freehand loop.
 *
 * WINDING. `traceMaskBorder` starts at the topmost-leftmost filled cell and
 * walks clockwise, so every ring out of here has positive shoelace area — the
 * same convention every shipped shard ring carries. Nothing downstream reads the
 * sign (the renderer's silhouette fills are nonzero-winding on a single subpath,
 * the plate fill is even-odd, `pointInRing` is even-odd ray casting), and
 * freehand `buildOutlineRing` stores whichever direction the user happened to
 * draw. So this is consistency worth having rather than correctness — nothing
 * may start depending on it.
 */

import {
  MAX_RING_COORDINATE,
  MAX_RING_NUMBERS,
  MIN_RING_NUMBERS,
  SIMPLIFY_EPSILON_BOARD_PX,
  simplifyRing,
  type RingPoint,
} from './ring';
import { components, fillHoles, isSimpleRing, rasteriseRing, traceMaskBorder, trimNecks } from './raster';

/**
 * Bitmap cells per board pixel.
 *
 * Not about the staircase: at one cell per board pixel the Moore follower's
 * quantisation is already around 0.57 board px, nearly three times finer than
 * the 1.6 board-px tolerance the border is then decimated at, and
 * Douglas-Peucker eats it whole. Supersampling buys almost nothing on fidelity.
 *
 * It buys RING SIMPLICITY. A brush leaves one-cell isthmuses that the border
 * follower walks out along and back down, and decimation then replaces the round
 * trip with two chords that cross — the same defect `trimNecks` was written for
 * on the plate extractor. Measured over 250 randomised erase strokes per
 * configuration: 2.8–8.8% of commits self-intersected at one cell per board
 * pixel, 0.4–2.4% at two, and none at two once {@link NECK_TRIM_CELLS} is
 * applied. Four cells costs four times the memory and fixes nothing further.
 */
export const BRUSH_SUPERSAMPLE = 2;

/**
 * Neck-trim radius in CELLS (half a board pixel each at the default supersample).
 *
 * Deliberately far gentler than the tracer's own `0.078 × placement radius`:
 * that one is cleaning up photographed art, this one is cleaning up a brush, and
 * the only thing it has to remove is the one-cell isthmus that makes a ring
 * cross itself. Trimming harder would round off corners a person drew on purpose.
 */
const NECK_TRIM_CELLS = 2;

/**
 * Smallest brush that actually moves a stored ring, in board pixels.
 *
 * Below this a dab is inside the decimation tolerance and simply vanishes:
 * measured on 200 holds, a disc of radius 0.8, 1.2 or 1.6 board px centred on
 * the edge moved the committed ring by 0.62–0.64 board px, which is the raster's
 * own noise floor and indistinguishable from doing nothing. It starts working at
 * about 3. Offering a smaller brush is offering a tool that silently does
 * nothing, so callers clamp to this rather than explaining it afterwards.
 *
 * A broad shave is different and is NOT floored by this: decimation keeps the
 * endpoints of long chords, so shaving half a board pixel off a whole edge moves
 * the ring by half a board pixel. It is localised features that disappear.
 */
export const MIN_BRUSH_RADIUS_BOARD_PX = 3;

/** A sane default brush: comfortably above the floor, and roughly a pencil tip
 *  on screen at the editor's zoom on every board in the catalogue. */
export const DEFAULT_BRUSH_RADIUS_BOARD_PX = 6;

/**
 * How far past the current outline the working bitmap reaches, in units of the
 * placement radius, before the hard cap in {@link frameHalfSpan} applies.
 *
 * A real shard outline runs to about 0.8 radii (2.85 at the very worst, on
 * Woods), so one extra radius of headroom is room to grow a hold noticeably
 * without sizing every session's bitmap for the worst case.
 */
const FRAME_HEADROOM_RADII = 1;

/**
 * Slack in board pixels so a disc painted at the very edge of the frame is not
 * clipped square by it, and so `fillHoles` always has background to flood from:
 * it works by flooding inward from the frame border, and a shape touching that
 * border leaves it nothing to reach, so it would fill the entire bitmap.
 */
const FRAME_MARGIN_BOARD_PX = 4;

/** Which way a stroke moves the boundary. */
export type BrushMode = 'add' | 'erase';

/** Why a brush stroke could not produce a storable ring. */
export type BrushRejection =
  | 'anchor-erased'
  | 'nothing-left'
  | 'no-change'
  | 'self-intersecting'
  | 'too-few-points'
  | 'too-complex';

export type BrushResult =
  | {
      ok: true;
      /** The edited outline in BOARD px, flat and implicitly closed. */
      outlineBoardPx: number[];
      /**
       * Detached pieces the edit produced and this function threw away — an
       * erase that cut the shape in two, or an add that landed clear of it.
       * Non-zero is worth telling the user about: they drew something that was
       * not kept, and dropping it silently reads as a bug.
       */
      droppedPieces: number;
    }
  | { ok: false; reason: BrushRejection };

/** A bitmap of a hold's area, and where it sits in board pixels. */
export type BrushMask = {
  cells: Uint8Array;
  width: number;
  height: number;
  /** Board-px coordinate of cell (0, 0)'s top-left corner. */
  originX: number;
  originY: number;
  /** Cells per board pixel. */
  supersample: number;
  /** The placement centre this mask was framed around, in board px. */
  anchorX: number;
  anchorY: number;
};

function flatten(points: ReadonlyArray<RingPoint>): number[] {
  const flat: number[] = [];
  for (const [x, y] of points) flat.push(x, y);
  return flat;
}

/**
 * Half-width of the working bitmap around the placement centre, in board pixels.
 *
 * Capped at `MAX_RING_COORDINATE` radii because nothing outside that can be
 * stored anyway (`isValidOutlineRing`), so the cap turns what would be an
 * `out-of-bounds` rejection at commit time into the brush quietly stopping at
 * the limit. It is also the memory bound: unbounded, a pencil flick off the hold
 * would size the bitmap from wherever the stroke went, and on the widest board
 * in the catalogue that is megabytes of `Uint8Array` plus a component index over
 * every cell of it.
 */
export function frameHalfSpan(outlineBoardPx: number[], anchorX: number, anchorY: number, holdRadius: number): number {
  let extent = 0;
  for (let index = 0; index + 1 < outlineBoardPx.length; index += 2) {
    extent = Math.max(extent, Math.abs(outlineBoardPx[index] - anchorX), Math.abs(outlineBoardPx[index + 1] - anchorY));
  }
  const wanted = extent + FRAME_HEADROOM_RADII * holdRadius + FRAME_MARGIN_BOARD_PX;
  return Math.min(MAX_RING_COORDINATE * holdRadius, wanted);
}

/**
 * Rasterise a board-px ring into a working bitmap centred on the placement.
 *
 * The frame is anchored to the placement centre, not to the ring's own bounds,
 * for two reasons. It is stable, so a session can keep ONE bitmap across many
 * strokes without regrowing it — which is what stops the ring being re-quantised
 * on every stroke. And it fixes the grid phase: `rasteriseRing` derives its own
 * origin with `Math.floor(minX) - 1`, so a frame sized off the ring would sit on
 * a grid whose alignment depended on the fractional part of the hold's centre,
 * and the same edit would land differently on two holds a third of a pixel apart.
 */
export function outlineToMask(params: {
  outlineBoardPx: number[];
  anchorX: number;
  anchorY: number;
  holdRadius: number;
  supersample?: number;
}): BrushMask {
  const { outlineBoardPx, anchorX, anchorY, holdRadius } = params;
  const supersample = params.supersample ?? BRUSH_SUPERSAMPLE;
  const halfSpan = frameHalfSpan(outlineBoardPx, anchorX, anchorY, holdRadius);

  const originX = anchorX - halfSpan;
  const originY = anchorY - halfSpan;
  const side = Math.max(4, Math.ceil(halfSpan * 2 * supersample));

  // Hand the rasteriser CELL coordinates in this frame, so its own floor/ceil
  // bounds land inside the frame instead of defining one of their own.
  const inCells: number[] = [];
  for (let index = 0; index + 1 < outlineBoardPx.length; index += 2) {
    inCells.push((outlineBoardPx[index] - originX) * supersample, (outlineBoardPx[index + 1] - originY) * supersample);
  }

  const cells = new Uint8Array(side * side);
  if (inCells.length >= MIN_RING_NUMBERS) {
    const raster = rasteriseRing(inCells);
    for (let y = 0; y < raster.height; y += 1) {
      const targetY = raster.originY + y;
      if (targetY < 0 || targetY >= side) continue;
      const sourceRow = y * raster.width;
      const targetRow = targetY * side;
      for (let x = 0; x < raster.width; x += 1) {
        const targetX = raster.originX + x;
        if (targetX < 0 || targetX >= side) continue;
        cells[targetRow + targetX] = raster.mask[sourceRow + x];
      }
    }
  }

  return { cells, width: side, height: side, originX, originY, supersample, anchorX, anchorY };
}

/**
 * Paint a swept disc along `strokeBoardPx` into `mask`, in place.
 *
 * Discs at every sample plus discs stepped along each segment: a stroke is
 * sampled at whatever rate the pointer reported, so consecutive samples can be
 * many pixels apart and stamping only at the samples would leave a dotted line.
 * Stepping at half a cell guarantees the discs overlap.
 *
 * Samples outside the frame are clipped rather than rejected. The frame is the
 * 4-radii limit past which nothing is storable, so a stroke that runs off the
 * hold simply stops having an effect out there.
 *
 * Returns how many cells actually changed, so a caller can tell a stroke that
 * did nothing (an eraser waved over empty space) from one that did.
 */
export function stampBrushStroke(
  mask: BrushMask,
  strokeBoardPx: number[],
  brushRadiusBoardPx: number,
  mode: BrushMode,
): number {
  const { cells, width, height, originX, originY, supersample } = mask;
  const value = mode === 'add' ? 1 : 0;
  const radiusCells = Math.max(0.5, brushRadiusBoardPx * supersample);
  const radiusSquared = radiusCells * radiusCells;
  const span = Math.ceil(radiusCells);
  let changed = 0;

  const stampDisc = (centreX: number, centreY: number): void => {
    const minX = Math.max(0, Math.floor(centreX) - span);
    const maxX = Math.min(width - 1, Math.ceil(centreX) + span);
    const minY = Math.max(0, Math.floor(centreY) - span);
    const maxY = Math.min(height - 1, Math.ceil(centreY) + span);
    for (let y = minY; y <= maxY; y += 1) {
      const deltaY = y - centreY;
      const row = y * width;
      for (let x = minX; x <= maxX; x += 1) {
        const deltaX = x - centreX;
        if (deltaX * deltaX + deltaY * deltaY > radiusSquared) continue;
        if (cells[row + x] === value) continue;
        cells[row + x] = value;
        changed += 1;
      }
    }
  };

  const cellX = (boardX: number): number => (boardX - originX) * supersample;
  const cellY = (boardY: number): number => (boardY - originY) * supersample;

  if (strokeBoardPx.length < 2) return 0;
  stampDisc(cellX(strokeBoardPx[0]), cellY(strokeBoardPx[1]));
  for (let index = 2; index + 1 < strokeBoardPx.length; index += 2) {
    const fromX = cellX(strokeBoardPx[index - 2]);
    const fromY = cellY(strokeBoardPx[index - 1]);
    const toX = cellX(strokeBoardPx[index]);
    const toY = cellY(strokeBoardPx[index + 1]);
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(1, Math.ceil(distance * 2));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      stampDisc(fromX + (toX - fromX) * progress, fromY + (toY - fromY) * progress);
    }
  }
  return changed;
}

/** The cell index of a mask's placement centre, or -1 if it sits outside. */
function anchorIndexOf(mask: BrushMask): number {
  const x = Math.round((mask.anchorX - mask.originX) * mask.supersample);
  const y = Math.round((mask.anchorY - mask.originY) * mask.supersample);
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return -1;
  return y * mask.width + x;
}

export type AnchoredComponent =
  | { ok: true; cells: Uint8Array; droppedPieces: number }
  | { ok: false; reason: 'anchor-erased' | 'nothing-left' };

/**
 * Reduce a mask to the single blob worth keeping, and say how many were thrown
 * away.
 *
 * An erase can cut a hold in two; an add can land a stroke that never touches
 * it. Either way the stored format holds one ring, so one blob has to win, and
 * `traceMaskBorder` on its own would take whichever the scan reached first — the
 * topmost-leftmost, which is an accident of geometry rather than a decision. On
 * a broad brush that is not a rare edge case: measured over 250 erase strokes at
 * a 4 board-px radius, 51% split the shape and 32% of all strokes would have
 * committed the wrong piece.
 *
 * The blob covering the placement centre wins, because the outline has to
 * enclose the placement it belongs to (the backend's own gate) — so the piece on
 * the bolt is definitionally the hold and the rest are offcuts.
 *
 * This step is also a RECONCILIATION, not just a filter, so skipping it when
 * there looks to be only one blob would be wrong: `components` is 4-connected
 * while `traceMaskBorder` is 8-connected Moore, so two blocks meeting at a
 * single diagonal corner are two components to one and one border to the other.
 * Running the component step first makes the follower see what the rest of the
 * pipeline sees.
 */
export function keepAnchoredComponent(mask: BrushMask): AnchoredComponent {
  // Holes are filled BEFORE the blob question is asked, and the order is
  // load-bearing. An eraser poked into the middle of a hold clears the anchor
  // cell, and asking "which blob covers the bolt" first would answer "none" and
  // reject a stroke that a format with no holes in it simply ignores. Filling
  // cannot merge two genuine offcuts: `fillHoles` floods inward from the frame
  // border, and background separating two pieces reaches that border.
  const filled = fillHoles(mask.cells, mask.width, mask.height);
  const blobs = components(filled, mask.width, mask.height);
  if (blobs.length === 0) return { ok: false, reason: 'nothing-left' };

  // A label map rather than a scan: a blob can hold a million cell indices on
  // the widest board, and `blobs.find((blob) => blob.includes(anchor))` walks
  // every one of them.
  const labels = new Int32Array(filled.length).fill(-1);
  for (let blob = 0; blob < blobs.length; blob += 1) {
    for (const index of blobs[blob]) labels[index] = blob;
  }

  const anchor = anchorIndexOf(mask);
  const anchoredLabel = anchor >= 0 ? labels[anchor] : -1;
  // Erasing the placement centre itself is its own failure, not a candidate for
  // "largest blob wins": the largest survivor can be nowhere near the bolt, and
  // the user would then get a message about a ring not covering its centre for a
  // ring they never asked for. Say what they actually did instead.
  if (anchoredLabel < 0) return { ok: false, reason: 'anchor-erased' };
  if (blobs.length === 1) return { ok: true, cells: filled, droppedPieces: 0 };

  const cells = new Uint8Array(filled.length);
  for (const index of blobs[anchoredLabel]) cells[index] = 1;
  return { ok: true, cells, droppedPieces: blobs.length - 1 };
}

/** Drop consecutive duplicate points, including a tail that repeats the head. */
function dedupeConsecutive(points: ReadonlyArray<RingPoint>): RingPoint[] {
  const kept: RingPoint[] = [];
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    kept.push(point);
  }
  while (kept.length > 1) {
    const head = kept[0];
    const tail = kept[kept.length - 1];
    if (head[0] !== tail[0] || head[1] !== tail[1]) break;
    kept.pop();
  }
  return kept;
}

/**
 * Walk a mask's border back out as a simplified ring in BOARD pixels.
 *
 * Thin necks go first: a one-cell isthmus is what the follower walks out along
 * and back down, and decimation then turns that round trip into two crossing
 * chords. Holes are filled after, because the trim can open one — the follower
 * emits an OUTER border only, so a hole would be traced around rather than into
 * and the polygon would claim it anyway. (The eraser-in-the-middle case is
 * already handled a step earlier, in `keepAnchoredComponent`.)
 *
 * Decimation mirrors `buildOutlineRing`: the tracer's own epsilon first, then
 * doubling while the ring is longer than a stored one may be, so a fiddly
 * boundary degrades into a coarser ring instead of a dead end.
 */
export function maskToRing(cells: Uint8Array, mask: BrushMask): BrushResult {
  const anchor = anchorIndexOf(mask);
  const trimmed = anchor >= 0 ? trimNecks(cells, mask.width, mask.height, anchor, NECK_TRIM_CELLS) : cells;
  const filled = fillHoles(trimmed, mask.width, mask.height);
  const border = traceMaskBorder(filled, mask.width, mask.height);
  if (border.length < 3) return { ok: false, reason: 'nothing-left' };

  const boardPx: RingPoint[] = border.map(([x, y]) => [
    mask.originX + x / mask.supersample,
    mask.originY + y / mask.supersample,
  ]);

  let simplified = simplifyRing(boardPx, SIMPLIFY_EPSILON_BOARD_PX);
  let epsilon = SIMPLIFY_EPSILON_BOARD_PX;
  while (simplified.length * 2 > MAX_RING_NUMBERS && epsilon < SIMPLIFY_EPSILON_BOARD_PX * 64) {
    epsilon *= 2;
    simplified = simplifyRing(boardPx, epsilon);
  }
  if (simplified.length * 2 > MAX_RING_NUMBERS) return { ok: false, reason: 'too-complex' };

  // Decimation can leave an interior vertex repeated, and `closeRing` only drops
  // a TRAILING duplicate of the head — an interior repeat would survive into
  // storage as a zero-length edge.
  const deduped = dedupeConsecutive(simplified);
  if (deduped.length * 2 < MIN_RING_NUMBERS) return { ok: false, reason: 'too-few-points' };
  // Belt and braces over the neck trim. Nothing downstream checks this — not
  // `buildOutlineRing`, not the resolver — and a crossing ring renders as a
  // shape with a hole punched where it crosses, under every even-odd fill it
  // meets. Refusing is better than storing one.
  if (!isSimpleRing(deduped)) return { ok: false, reason: 'self-intersecting' };

  return { ok: true, outlineBoardPx: flatten(deduped), droppedPieces: 0 };
}

/**
 * One brush stroke, end to end: current outline in, edited outline out.
 *
 * FOR TESTS AND ONE-SHOT CALLERS. An editor brushes the same hold many times in
 * a row and should keep the mask between strokes, driving
 * {@link stampBrushStroke} and {@link maskToRing} directly — not because a
 * single round trip is bad (it is not: one decimation cost, and then the ring
 * settles) but because re-rasterising the committed ring on every stroke stacks
 * that cost up. Measured over 20 no-op strokes on 60 holds: worst case -4.7% of
 * area re-rasterising each time, against -2.4% on one persistent mask, where the
 * result is by construction identical to a single round trip.
 */
export function brushEditOutline(params: {
  /** The hold's current outline, flat and in board px. */
  outlineBoardPx: number[];
  /** The stroke, flat `[x0, y0, …]` in board px. */
  strokeBoardPx: number[];
  brushRadiusBoardPx: number;
  mode: BrushMode;
  /** The placement centre in board px — decides which piece survives a split. */
  anchorX: number;
  anchorY: number;
  /** The placement radius in board px — bounds the working bitmap. */
  holdRadius: number;
  supersample?: number;
}): BrushResult {
  const { outlineBoardPx, strokeBoardPx, brushRadiusBoardPx, mode, anchorX, anchorY, holdRadius } = params;

  const mask = outlineToMask({ outlineBoardPx, anchorX, anchorY, holdRadius, supersample: params.supersample });
  const changed = stampBrushStroke(mask, strokeBoardPx, brushRadiusBoardPx, mode);
  if (changed === 0) return { ok: false, reason: 'no-change' };

  const anchored = keepAnchoredComponent(mask);
  if (!anchored.ok) return { ok: false, reason: anchored.reason };

  const traced = maskToRing(anchored.cells, mask);
  return traced.ok ? { ...traced, droppedPieces: anchored.droppedPieces } : traced;
}
