/**
 * Refine: the spray editor's add / erase brush for one hold, as pure functions.
 *
 * The brush ENGINE is not here. It is `@boardsesh/board-art-geometry/brush`
 * (rasterise the ring, paint the stroke, walk the border back out), shared with
 * the catalogue outline editor, and its per-hold session is `use-brush-session.ts`.
 * This module is the spray ADAPTER around them: the coordinate frame the engine
 * works in, the screen-point brush size and its clamp to the hold, the rule for
 * a stroke that erases the hold's middle, and the step that turns the brushed
 * area back into a storable hold (`cx`, `cy`, `r` and a radius-unit ring).
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
 * Trace keeps on a typical spray hold (its 1.6 board px on a 40 px radius) —
 * and its smallest brush that still moves a ring (`MIN_BRUSH_RADIUS_BOARD_PX`,
 * 3 units) is 9.4% of it: 3.75 board px on a 40 px hold. The fine work comes
 * from the screen-point brush instead (zoom in and the brush shrinks to that
 * floor), not from a finer frame.
 *
 * Cost: the bitmap reaches the outline plus one radius (4 radii at most) at 2
 * cells a unit, about 360-370 cells a side in a normal session and 512 at the
 * cap. Every stroke walks it several times on the JS thread (fill, components,
 * neck trim, border follow). Measured through the session in Node on the dev
 * box (60 strokes round a 40 px hold, five seeds): median per lift 17 ms at 32
 * units, 28 ms at 40 and 40 ms at 48; once the bitmap is at its cap, 48, 75 and
 * 112 ms. Hermes runs these loops several times slower and none of the bigger
 * frames has been timed on a phone, so 32 stays until a device says otherwise
 * (the editor logs each lift's cost in development builds, `[refine] lift`).
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
 * The brush size the climber picks, as a RADIUS IN SCREEN POINTS.
 *
 * Screen points, so zooming in makes the brush finer on the hold: at 1× on a
 * phone a point is about 5 board px of a 2048 px photo, at 8× well under one.
 * The radius actually painted is clamped to the hold
 * ({@link refineBrushRadiusAtZoom}), so the slider's range follows the zoom
 * ({@link refineBrushRangeAtZoom}): it runs from the size that paints the floor
 * to the size that paints the cap at the zoom the board last settled at, inside
 * these absolute bounds, so no stretch of the track paints the same brush.
 */
export const REFINE_BRUSH_MIN_PT = 1;
export const REFINE_BRUSH_MAX_PT = 32;
/** The slider's top step: 21 steps (0-20), whatever the range at this zoom. */
export const REFINE_BRUSH_TOP_RUNG = 20;

/**
 * The size Refine starts on: 2 pt is about 11 board px at 1× on a phone, the
 * old Medium brush (30% of a 40 px hold) on the hold most walls have.
 */
export const DEFAULT_REFINE_BRUSH_PT = 2;

/**
 * The biggest brush, as a fraction of the hold's radius when Refine opened: the
 * old Large. A screen-point brush at 1× on a phone is bigger than a typical
 * hold (12 pt is about 66 board px against a 40 px hold), and a dab that size
 * re-shapes the whole hold and pushes the bitmap to its cap on the first stroke.
 */
export const REFINE_BRUSH_CAP_FRACTION = 0.6;

/** The slider's range at one zoom, in screen points. */
export type RefineBrushRange = { minPt: number; maxPt: number };

/** The whole track: the range before a hold is open. */
export const FULL_REFINE_BRUSH_RANGE: RefineBrushRange = { minPt: REFINE_BRUSH_MIN_PT, maxPt: REFINE_BRUSH_MAX_PT };

/** A range never narrower than this ratio (one old quarter-doubling), so the slider always has somewhere to go. */
const MIN_RANGE_RATIO = 2 ** 0.25;

/**
 * The slider's range at a settled zoom: from the size that paints the floor to
 * the size that paints the cap, in screen points, inside
 * [{@link REFINE_BRUSH_MIN_PT}, {@link REFINE_BRUSH_MAX_PT}]. Recomputed only
 * when the zoom settles (the screen's `onZoomSettle`), never per frame.
 */
export function refineBrushRangeAtZoom(
  boardPxPerPt: number,
  zoom: number,
  limits: RefineBrushLimits,
): RefineBrushRange {
  if (!(boardPxPerPt > 0) || !(zoom > 0)) return FULL_REFINE_BRUSH_RANGE;
  const ptPerBoardPx = zoom / boardPxPerPt;
  const clampPt = (value: number) => Math.min(REFINE_BRUSH_MAX_PT, Math.max(REFINE_BRUSH_MIN_PT, value));
  let minPt = clampPt(limits.floorBoardPx * ptPerBoardPx);
  let maxPt = clampPt(limits.capBoardPx * ptPerBoardPx);
  if (maxPt < minPt * MIN_RANGE_RATIO) {
    // A hold so small (or a zoom so far out) that the floor and the cap are the
    // same few points: every size paints the same brush, so any short range does.
    maxPt = Math.min(REFINE_BRUSH_MAX_PT, minPt * MIN_RANGE_RATIO);
    minPt = maxPt / MIN_RANGE_RATIO;
  }
  return { minPt, maxPt };
}

/** A stored size shown inside the range at this zoom. The stored size itself is not changed. */
export function clampRefineBrushPt(screenPt: number, range: RefineBrushRange): number {
  return Math.min(range.maxPt, Math.max(range.minPt, screenPt));
}

/** The size at a 0-1 position along the range's log track. */
export function refineBrushPtAtRatio(ratio: number, minPt: number, maxPt: number): number {
  'worklet';
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return minPt * (maxPt / minPt) ** clamped;
}

/** Where a size sits along the range's log track, 0-1. The inverse of {@link refineBrushPtAtRatio}. */
export function refineBrushRatioForPt(screenPt: number, minPt: number, maxPt: number): number {
  'worklet';
  if (!(screenPt > minPt) || !(maxPt > minPt)) return 0;
  const ratio = Math.log(screenPt / minPt) / Math.log(maxPt / minPt);
  return ratio > 1 ? 1 : ratio;
}

/** The step a size sits on in the range, 0 to {@link REFINE_BRUSH_TOP_RUNG}. */
export function refineBrushRung(screenPt: number, minPt: number, maxPt: number): number {
  'worklet';
  return Math.round(refineBrushRatioForPt(screenPt, minPt, maxPt) * REFINE_BRUSH_TOP_RUNG);
}

/** The size on a step of the range, clamped to it. */
export function refineBrushPtAtRung(rung: number, minPt: number, maxPt: number): number {
  'worklet';
  const clamped = Math.min(REFINE_BRUSH_TOP_RUNG, Math.max(0, Math.round(rung)));
  if (clamped === 0) return minPt;
  if (clamped === REFINE_BRUSH_TOP_RUNG) return maxPt;
  return refineBrushPtAtRatio(clamped / REFINE_BRUSH_TOP_RUNG, minPt, maxPt);
}

/** A size snapped to its nearest step of the range: the slider's quantiser. */
export function roundRefineBrushPt(screenPt: number, minPt: number, maxPt: number): number {
  'worklet';
  return refineBrushPtAtRung(refineBrushRung(screenPt, minPt, maxPt), minPt, maxPt);
}

/** One VoiceOver / TalkBack step: the next step of the range up or down, clamped. */
export function adjustRefineBrushPt(screenPt: number, direction: 1 | -1, minPt: number, maxPt: number): number {
  'worklet';
  return refineBrushPtAtRung(refineBrushRung(screenPt, minPt, maxPt) + direction, minPt, maxPt);
}

/** A stored size read back, or the default for anything that is not a size on the track. */
export function parseRefineBrushPt(stored: unknown): number {
  const value = typeof stored === 'string' ? Number(stored) : stored;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REFINE_BRUSH_PT;
  if (value < REFINE_BRUSH_MIN_PT || value > REFINE_BRUSH_MAX_PT) return DEFAULT_REFINE_BRUSH_PT;
  return value;
}

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

/** The board-px bounds a brush is clamped to, for one hold. */
export type RefineBrushLimits = {
  /**
   * The engine's smallest brush that moves a ring at all
   * (`MIN_BRUSH_RADIUS_BOARD_PX`, in frame units). A dab smaller than that
   * vanishes into the decimation, and a brush that silently does nothing is
   * worse than a slightly bigger one.
   */
  floorBoardPx: number;
  /** {@link REFINE_BRUSH_CAP_FRACTION} of the hold's radius, never under the floor. */
  capBoardPx: number;
};

export function refineBrushLimits(holdRadiusBoardPx: number, frame: RefineFrame): RefineBrushLimits {
  const floorBoardPx = MIN_BRUSH_RADIUS_BOARD_PX / frame.scale;
  return { floorBoardPx, capBoardPx: Math.max(floorBoardPx, REFINE_BRUSH_CAP_FRACTION * holdRadiusBoardPx) };
}

/**
 * The radius a stroke paints with, in BOARD px: the picked size in screen
 * points at this zoom (`screenPt × boardPxPerPt / zoom`), clamped to the hold's
 * limits. `boardPxPerPt` is the board's render scale (`renderToBoardScale`),
 * `zoom` the board's zoom when the stroke started. The stroke preview, the
 * size preview by the slider and the ring over the hold all draw this radius.
 */
export function refineBrushRadiusAtZoom(
  screenPt: number,
  boardPxPerPt: number,
  zoom: number,
  floorBoardPx: number,
  capBoardPx: number,
): number {
  'worklet';
  const wanted = zoom > 0 && boardPxPerPt > 0 ? (screenPt * boardPxPerPt) / zoom : capBoardPx;
  return Math.max(floorBoardPx, Math.min(capBoardPx, wanted));
}

/** {@link refineBrushRadiusAtZoom} as it lands on screen, in points: what the size preview draws. */
export function refineBrushScreenRadiusPt(
  screenPt: number,
  boardPxPerPt: number,
  zoom: number,
  floorBoardPx: number,
  capBoardPx: number,
): number {
  'worklet';
  if (!(boardPxPerPt > 0)) return screenPt;
  return (refineBrushRadiusAtZoom(screenPt, boardPxPerPt, zoom, floorBoardPx, capBoardPx) * zoom) / boardPxPerPt;
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
