/**
 * Refine: the spray editor's add / erase brush for one hold, as pure functions.
 *
 * The brush ENGINE is not here. It is `@boardsesh/board-art-geometry/brush`
 * (rasterise the ring, paint the stroke, walk the border back out), shared with
 * the catalogue outline editor, and its per-hold session is `use-brush-session.ts`.
 * This module is the spray ADAPTER around them: the coordinate frame the engine
 * works in, the screen-point brush size, the rule for a stroke that erases the
 * hold's middle, and the step that turns the brushed area back into a storable
 * hold (`cx`, `cy`, `r` and a radius-unit ring).
 *
 * WHY A FRAME OF ITS OWN. The engine's numbers are absolute: two bitmap cells
 * per unit and a 1.6-unit decimation tolerance, tuned for catalogue board art.
 * Spray board px are the wall photo's own pixels, and a hold there runs from
 * about 20 px on a small upload to several hundred for a wide merge. Fed raw,
 * a small hold would decimate to a handful of corners and a big one would size a
 * bitmap of millions of cells and stall the JS thread on every stroke. So every
 * hold is mapped into a frame centred on it and scaled so its radius is
 * {@link REFINE_FRAME_RADIUS} units: the edit is then accurate to the same
 * fraction of the hold (5% of its radius) whatever the photo's resolution or the
 * zoom, and the bitmap stays at most 512 cells a side. This is also why the
 * 4096 px full photo the editor loads past 3× changes nothing here: the frame
 * follows the hold, not the photo.
 */

import {
  MIN_BRUSH_RADIUS_BOARD_PX,
  maskToRing,
  outlineToMask,
  stampBrushStroke,
  strokeReachFromAnchor,
  type BrushMode,
  type BrushRejection,
} from '@boardsesh/board-art-geometry/brush';
import { components, fillHoles } from '@boardsesh/board-art-geometry/raster';
import {
  MIN_RING_NUMBERS,
  closeRing,
  isValidOutlineRing,
  pointInRing,
  roundRing,
} from '@boardsesh/board-art-geometry/ring';
import { OUTLINE_DECIMALS, boardRingToRadiusUnits, flattenRing, ringCoversCentre } from './stroke';
import {
  POLYGON_MIN_AREA_BOARD_PX2,
  holdBoundaryPoints,
  polygonCentroidAndArea,
  radiusForRing,
  toRingPoints,
  type HoldFromStrokeResult,
  type HoldGeometry,
} from './spray-hold-tools';

/**
 * The hold's radius in the brush frame, in engine units.
 *
 * Precision: the engine decimates at 1.6 units, 5% of the hold's radius — what
 * Trace keeps on a typical spray hold (its 1.6 board px on a 40 px radius).
 *
 * Cost: the bitmap reaches the outline plus one radius (4 radii at most) at 2
 * cells a unit, about 310-350 cells a side with the hold-relative brushes and
 * 512 at the cap. Every stroke walks it several times on the JS thread (fill,
 * components, neck trim, border follow). Measured on the dev box in Node, a
 * one-shot stroke costs 17 ms at 32 units, 27 ms at 40 and 70 ms at 64; through
 * the session at 32 units, 19 ms median per lift, 48 ms once the bitmap is at
 * its cap. Hermes runs these loops several times slower, so 64 would visibly
 * stall where 32 stays at tens of milliseconds.
 */
export const REFINE_FRAME_RADIUS = 32;

/**
 * Bounds on the frame scale. Only a hold under 4 px or over 256 px in radius
 * reaches them; past them the precision or the cost above stops holding, not
 * the edit.
 */
export const REFINE_FRAME_SCALE_MIN = 1 / 8;
export const REFINE_FRAME_SCALE_MAX = 8;

/** Corners a plain circle gets when Refine turns it into an area to brush. */
export const REFINE_CIRCLE_SAMPLES = 48;

/**
 * Brush radii as a fraction of the hold's radius (its `r` when Refine opened).
 *
 * Relative to the hold, not to the screen: the job is fine-tuning one hold, so
 * the brush is sized to that hold whatever the zoom. Screen-point brushes were
 * bigger than a typical hold at 1x on a phone (12 pt is about 66 board px on a
 * 2048 px photo, against a 40 px hold), so the default dab re-shaped the whole
 * hold and every first stroke pushed the bitmap to its cap. The live preview
 * draws the true size, so zooming in shows exactly what a dab covers.
 */
export const REFINE_BRUSH_RADIUS_FRACTION = {
  small: 0.15,
  medium: 0.3,
  large: 0.6,
} as const;

export type RefineBrushSize = keyof typeof REFINE_BRUSH_RADIUS_FRACTION;

export const DEFAULT_REFINE_BRUSH_SIZE: RefineBrushSize = 'medium';

export type { BrushMode as RefineMode };

/** Board px → brush frame: `(p − origin) × scale`. */
export type RefineFrame = { originX: number; originY: number; scale: number };

/** The frame a hold is brushed in: centred on it, its radius {@link REFINE_FRAME_RADIUS} units. */
export function refineFrameFor(hold: Pick<HoldGeometry, 'cx' | 'cy' | 'r'>): RefineFrame {
  const wanted = hold.r > 0 ? REFINE_FRAME_RADIUS / hold.r : 1;
  const scale = Math.min(REFINE_FRAME_SCALE_MAX, Math.max(REFINE_FRAME_SCALE_MIN, wanted));
  return { originX: hold.cx, originY: hold.cy, scale };
}

/** A flat board-px point list in the brush frame. */
export function toBrushFrame(flatBoardPx: readonly number[], frame: RefineFrame): number[] {
  const converted: number[] = [];
  for (let index = 0; index + 1 < flatBoardPx.length; index += 2) {
    converted.push(
      (flatBoardPx[index] - frame.originX) * frame.scale,
      (flatBoardPx[index + 1] - frame.originY) * frame.scale,
    );
  }
  return converted;
}

/** The inverse of {@link toBrushFrame}. */
export function fromBrushFrame(flatBrushPx: readonly number[], frame: RefineFrame): number[] {
  const converted: number[] = [];
  for (let index = 0; index + 1 < flatBrushPx.length; index += 2) {
    converted.push(
      frame.originX + flatBrushPx[index] / frame.scale,
      frame.originY + flatBrushPx[index + 1] / frame.scale,
    );
  }
  return converted;
}

/**
 * The brush radius a stroke paints with, in BOARD px: the size's fraction of
 * the hold's radius, floored at the engine's smallest brush that moves a ring
 * at all (`MIN_BRUSH_RADIUS_BOARD_PX`, in frame units). A dab smaller than that
 * vanishes into the decimation, and a brush that silently does nothing is worse
 * than a slightly bigger one. The preview draws exactly this radius.
 */
export function refineBrushRadiusBoardPx(size: RefineBrushSize, holdRadiusBoardPx: number, frame: RefineFrame): number {
  return Math.max(REFINE_BRUSH_RADIUS_FRACTION[size] * holdRadiusBoardPx, MIN_BRUSH_RADIUS_BOARD_PX / frame.scale);
}

/** The hold's starting area as a flat board-px ring: its outline, or its circle sampled. */
export function refineStartOutline(hold: HoldGeometry): number[] {
  return flattenRing(holdBoundaryPoints(hold, REFINE_CIRCLE_SAMPLES));
}

/**
 * A brushed area → a whole hold, or why it cannot be one.
 *
 * The centre is the area's centroid and the radius its equivalent-area radius,
 * grown when needed so the ring fits `MAX_RING_COORDINATE` (`radiusForRing`, the
 * rule a drawn or joined hold already follows). The ring then takes the stored
 * path: radius units, rounded, then closed (the backend's order), the shared
 * contract, and the centre-cover gate.
 *
 * A concave area — a C after an erase bit into one side — can have its centroid
 * outside itself, and the backend would refuse that ring. So the hold's anchor
 * (the centre the brush session kept the area attached to, which by
 * construction is inside it or within the shared tolerance) is the first
 * fallback. The engine measures that tolerance against the hold's ORIGINAL
 * radius and the backend against the new one, so after a big erase both can
 * miss; the last candidate is a point certainly inside the area (the middle of
 * its widest span on the centroid's row), which always clears the gate. So a
 * refusal here means a ring the contract cannot store, not a centre problem.
 */
export function holdFromRefinedOutline(
  outlineBoardPx: readonly number[],
  fallbackCentre: { x: number; y: number },
): HoldFromStrokeResult {
  const points = toRingPoints(outlineBoardPx);
  if (points.length < 3) return { ok: false, reason: 'too-few-points' };
  const { cx, cy, area } = polygonCentroidAndArea(points);
  if (!(area >= POLYGON_MIN_AREA_BOARD_PX2)) return { ok: false, reason: 'too-few-points' };

  let reason: 'out-of-bounds' | 'centre-outside' = 'centre-outside';
  const candidates = [
    { x: cx, y: cy },
    { x: fallbackCentre.x, y: fallbackCentre.y },
  ];
  const inside = interiorPointOnRow(outlineBoardPx, cy);
  if (inside) candidates.push(inside);
  for (const centre of candidates) {
    const r = radiusForRing(points, centre.x, centre.y, area);
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y) || !Number.isFinite(r)) {
      reason = 'out-of-bounds';
      continue;
    }
    // Round, THEN close — the backend's order; see `buildOutlineRing`.
    const radiusRing = closeRing(
      roundRing(
        boardRingToRadiusUnits([...outlineBoardPx], { id: 0, cx: centre.x, cy: centre.y, r }),
        OUTLINE_DECIMALS,
      ),
    );
    if (radiusRing.length < MIN_RING_NUMBERS) return { ok: false, reason: 'too-few-points' };
    if (!isValidOutlineRing(radiusRing)) {
      reason = 'out-of-bounds';
      continue;
    }
    if (!ringCoversCentre(radiusRing)) continue;
    return { ok: true, hold: { cx: centre.x, cy: centre.y, r, outline: radiusRing } };
  }
  return { ok: false, reason };
}

/**
 * A point inside a flat ring: the middle of the widest span the horizontal line
 * at `rowY` cuts through it (even-odd, half-open edges, so a vertex on the row
 * is counted once). Null when the row misses the ring.
 */
export function interiorPointOnRow(flatRing: readonly number[], rowY: number): { x: number; y: number } | null {
  const crossings: number[] = [];
  const count = Math.floor(flatRing.length / 2);
  for (let index = 0; index < count; index += 1) {
    const fromX = flatRing[index * 2];
    const fromY = flatRing[index * 2 + 1];
    const toX = flatRing[((index + 1) % count) * 2];
    const toY = flatRing[((index + 1) % count) * 2 + 1];
    if (fromY > rowY === toY > rowY) continue;
    crossings.push(fromX + ((rowY - fromY) / (toY - fromY)) * (toX - fromX));
  }
  crossings.sort((left, right) => left - right);
  let best: { x: number; y: number } | null = null;
  let widest = 0;
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const width = crossings[index + 1] - crossings[index];
    if (width > widest) {
      widest = width;
      best = { x: (crossings[index] + crossings[index + 1]) / 2, y: rowY };
    }
  }
  return best && pointInRing([...flatRing], best.x, best.y) ? best : null;
}

export type LargestPieceResult =
  | {
      ok: true;
      /** The kept piece, in the brush frame. */
      outlineBrushPx: number[];
      droppedPieces: number;
      /** The kept piece's cell nearest its centroid, in the brush frame: the session's new anchor. */
      anchorX: number;
      anchorY: number;
    }
  | { ok: false; reason: BrushRejection };

/**
 * One stroke, keeping the LARGEST piece — for the stroke the engine refused
 * because it erased the hold's middle (`anchor-erased`).
 *
 * The engine keeps the piece that still holds the hold's centre, and for every
 * other stroke that is the right answer: an erase that cuts a stray lobe off a
 * hold must keep the hold, even when the lobe is bigger. But a climber who
 * erases straight through the middle is saying the centre was wrong — the scan's
 * circle sat half off the hold, say — and refusing that would leave Refine unable
 * to move a hold at all. So the biggest surviving piece wins, and its centroid
 * becomes the anchor every later stroke in the session keeps the area attached
 * to.
 *
 * Built from the engine's own primitives (rasterise, stamp, fill holes,
 * components, trace), so the ring comes out of exactly the same decimation and
 * contract as every other brushed ring.
 */
export function strokeKeepingLargestPiece(params: {
  outlineBrushPx: number[];
  anchorX: number;
  anchorY: number;
  holdRadius: number;
  strokeBrushPx: number[];
  brushRadius: number;
  mode: BrushMode;
}): LargestPieceResult {
  const { outlineBrushPx, anchorX, anchorY, holdRadius, strokeBrushPx, brushRadius, mode } = params;
  const mask = outlineToMask({
    outlineBoardPx: outlineBrushPx,
    anchorX,
    anchorY,
    holdRadius,
    reachBoardPx: strokeReachFromAnchor(strokeBrushPx, anchorX, anchorY, brushRadius),
  });
  if (stampBrushStroke(mask, strokeBrushPx, brushRadius, mode) === 0) return { ok: false, reason: 'no-change' };

  const filled = fillHoles(mask.cells, mask.width, mask.height);
  const pieces = components(filled, mask.width, mask.height);
  if (pieces.length === 0) return { ok: false, reason: 'nothing-left' };
  let largest = pieces[0];
  for (const piece of pieces) if (piece.length > largest.length) largest = piece;

  const cells = new Uint8Array(filled.length);
  let sumX = 0;
  let sumY = 0;
  for (const index of largest) {
    cells[index] = 1;
    const cellX = index % mask.width;
    sumX += cellX;
    sumY += (index - cellX) / mask.width;
  }
  // The new anchor is the piece's own cell nearest its centroid: on a C-shaped
  // piece the centroid itself can sit in the mouth, outside the piece, and an
  // anchor there would skip the neck trim and fail the centre gate.
  const meanX = sumX / largest.length;
  const meanY = sumY / largest.length;
  let anchorCell = largest[0];
  let anchorDistanceSquared = Infinity;
  for (const index of largest) {
    const cellX = index % mask.width;
    const deltaX = cellX - meanX;
    const deltaY = (index - cellX) / mask.width - meanY;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (distanceSquared < anchorDistanceSquared) {
      anchorDistanceSquared = distanceSquared;
      anchorCell = index;
    }
  }
  // A cell's integer coordinate is the point the engine samples it at.
  const anchorCellX = anchorCell % mask.width;
  const centroidX = mask.originX + anchorCellX / mask.supersample;
  const centroidY = mask.originY + (anchorCell - anchorCellX) / mask.width / mask.supersample;
  const traced = maskToRing(cells, { ...mask, cells, anchorX: centroidX, anchorY: centroidY });
  if (!traced.ok) return traced;
  return {
    ok: true,
    outlineBrushPx: traced.outlineBoardPx,
    droppedPieces: pieces.length - 1,
    anchorX: centroidX,
    anchorY: centroidY,
  };
}
