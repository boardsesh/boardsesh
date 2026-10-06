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
import { MIN_RING_NUMBERS, closeRing, isValidOutlineRing, roundRing } from '@boardsesh/board-art-geometry/ring';
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
 * cells a unit, about 270 cells a side for a typical hold and 512 at most. Every
 * stroke walks it several times on the JS thread (fill, components, neck trim,
 * border follow). Measured on the dev box in Node, one stroke costs 17 ms at
 * 32 units, 27 ms at 40 and 70 ms at 64; Hermes runs these loops several times
 * slower, so 32 keeps a stroke's lift well under a tenth of a second where 64
 * would visibly stall.
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
 * Brush radii in SCREEN points, converted to board px at the zoom the stroke
 * starts at, so a brush feels the same size under the finger at 1× and at 8×.
 * Medium is a fingertip's contact patch; small is for a crimp's edge zoomed in.
 */
export const REFINE_BRUSH_RADIUS_PT = {
  small: 6,
  medium: 12,
  large: 24,
} as const;

export type RefineBrushSize = keyof typeof REFINE_BRUSH_RADIUS_PT;

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
 * The brush radius a stroke paints with, in BOARD px.
 *
 * Screen points at the stroke's zoom, floored at the engine's smallest brush
 * that moves a ring at all (`MIN_BRUSH_RADIUS_BOARD_PX`, in frame units): a dab
 * smaller than that vanishes into the decimation, and offering a brush that
 * silently does nothing is worse than a slightly bigger one. The live preview
 * draws exactly this radius, so what is painted is what the finger saw.
 */
export function refineBrushRadiusBoardPx(
  brushPt: number,
  boardScale: number,
  zoom: number,
  frame: RefineFrame,
): number {
  const fromScreen = (brushPt * boardScale) / Math.max(zoom, 1e-6);
  return Math.max(fromScreen, MIN_BRUSH_RADIUS_BOARD_PX / frame.scale);
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
 * construction is inside it or within the shared tolerance) is the fallback
 * centre. Only when neither covers does the edit fail.
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
  for (const centre of [
    { x: cx, y: cy },
    { x: fallbackCentre.x, y: fallbackCentre.y },
  ]) {
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

export type LargestPieceResult =
  | {
      ok: true;
      /** The kept piece, in the brush frame. */
      outlineBrushPx: number[];
      droppedPieces: number;
      /** The kept piece's centroid in the brush frame: the session's new anchor. */
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
  // A cell's integer coordinate is the point the engine samples it at.
  const centroidX = mask.originX + sumX / largest.length / mask.supersample;
  const centroidY = mask.originY + sumY / largest.length / mask.supersample;
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
