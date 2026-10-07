import { describe, expect, it } from 'vitest';
import { MIN_BRUSH_RADIUS_BOARD_PX, brushEditOutline } from '@boardsesh/board-art-geometry/brush';
import { MAX_RING_COORDINATE, isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import {
  DEFAULT_REFINE_BRUSH_PT,
  REFINE_BRUSH_CAP_FRACTION,
  REFINE_BRUSH_MAX_PT,
  REFINE_BRUSH_MIN_PT,
  REFINE_BRUSH_TOP_RUNG,
  FULL_REFINE_BRUSH_RANGE,
  REFINE_CIRCLE_SAMPLES,
  REFINE_FRAME_RADIUS,
  REFINE_FRAME_SCALE_MAX,
  adjustRefineBrushPt,
  clampRefineBrushPt,
  fromBrushFrame,
  holdFromRefinedOutline,
  interiorPointOnRow,
  parseRefineBrushPt,
  refineBrushLimits,
  refineBrushPtAtRatio,
  refineBrushPtAtRung,
  refineBrushRadiusAtZoom,
  refineBrushRangeAtZoom,
  refineBrushRatioForPt,
  refineBrushRung,
  refineBrushScreenRadiusPt,
  refineFrameFor,
  refineStartOutline,
  roundRefineBrushPt,
  strokeKeepingLargestPiece,
  toBrushFrame,
} from '../spray-refine';
import { polygonCentroidAndArea, toRingPoints } from '../spray-hold-tools';

/** A square of half-side `half` round (cx, cy), flat board px. */
function square(cx: number, cy: number, half: number): number[] {
  return [cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half];
}

function area(flat: number[]): number {
  return polygonCentroidAndArea(toRingPoints(flat)).area;
}

describe('refineFrameFor', () => {
  it('scales every hold to the same radius in the brush frame', () => {
    for (const r of [12, 40, 200]) {
      const frame = refineFrameFor({ cx: 500, cy: 300, r });
      expect(r * frame.scale).toBeCloseTo(REFINE_FRAME_RADIUS);
      expect(frame.originX).toBe(500);
      expect(frame.originY).toBe(300);
    }
  });

  it('clamps the scale for a degenerate hold', () => {
    expect(refineFrameFor({ cx: 0, cy: 0, r: 1 }).scale).toBe(REFINE_FRAME_SCALE_MAX);
    expect(refineFrameFor({ cx: 0, cy: 0, r: 0 }).scale).toBe(1);
  });

  it('round-trips points through the frame', () => {
    const frame = refineFrameFor({ cx: 812.5, cy: 1204.25, r: 37 });
    const points = [800, 1200, 850.5, 1190.25, 812.5, 1204.25];
    const back = fromBrushFrame(toBrushFrame(points, frame), frame);
    back.forEach((value, index) => expect(value).toBeCloseTo(points[index], 9));
    // The hold's centre is the frame's origin.
    expect(toBrushFrame([812.5, 1204.25], frame)).toEqual([0, 0]);
  });
});

/** A 2048 px photo laid out 375 pt wide: a phone at 1×. */
const PHONE_BOARD_PX_PER_PT = 2048 / 375;

describe('refineBrushLimits', () => {
  it('floors at the engine minimum in frame units and caps at the old Large', () => {
    const frame = refineFrameFor({ cx: 0, cy: 0, r: 40 });
    const limits = refineBrushLimits(40, frame);
    // 32 frame units on a 40 px hold: the 3-unit floor is 3.75 board px, 9.4% of it.
    expect(limits.floorBoardPx).toBeCloseTo((MIN_BRUSH_RADIUS_BOARD_PX * 40) / REFINE_FRAME_RADIUS);
    expect(limits.floorBoardPx / 40).toBeCloseTo(0.094, 3);
    expect(limits.capBoardPx).toBeCloseTo(REFINE_BRUSH_CAP_FRACTION * 40);
  });

  it('never caps under the floor on a degenerate hold', () => {
    // Half a px: the frame scale clamps at 8, so the floor is 0.375 px and 60% of the hold is under it.
    const frame = refineFrameFor({ cx: 0, cy: 0, r: 0.5 });
    const limits = refineBrushLimits(0.5, frame);
    expect(limits.floorBoardPx).toBeCloseTo(MIN_BRUSH_RADIUS_BOARD_PX / REFINE_FRAME_SCALE_MAX);
    expect(limits.capBoardPx).toBe(limits.floorBoardPx);
  });
});

describe('refineBrushRadiusAtZoom', () => {
  const frame = refineFrameFor({ cx: 0, cy: 0, r: 40 });
  const { floorBoardPx, capBoardPx } = refineBrushLimits(40, frame);
  const radius = (screenPt: number, zoom: number) =>
    refineBrushRadiusAtZoom(screenPt, PHONE_BOARD_PX_PER_PT, zoom, floorBoardPx, capBoardPx);

  it('paints the hold-relative cap at 1× on a phone for any size above it', () => {
    // 8 pt is about 44 board px at 1×, wider than the hold: clamped to 0.6 r.
    expect(radius(8, 1)).toBeCloseTo(capBoardPx);
    expect(radius(REFINE_BRUSH_MAX_PT, 1)).toBeCloseTo(capBoardPx);
  });

  it('paints the screen size at 8×, finer than anything 1× offers', () => {
    // 7 pt at 8× is 7 × 5.46 / 8 ≈ 4.8 board px: between the floor and the cap.
    expect(radius(7, 8)).toBeCloseTo((7 * PHONE_BOARD_PX_PER_PT) / 8);
    expect(radius(7, 8)).toBeLessThan(radius(7, 1));
    expect(radius(7, 8)).toBeLessThan(0.15 * 40);
  });

  it('never drops below the floor, however far in', () => {
    expect(radius(REFINE_BRUSH_MIN_PT, 8)).toBe(floorBoardPx);
    expect(radius(REFINE_BRUSH_MIN_PT, 1)).toBeGreaterThanOrEqual(floorBoardPx);
  });

  it('gets finer as the zoom goes up, until the floor', () => {
    const sizes = [1, 2, 4, 8].map((zoom) => radius(3, zoom));
    for (let index = 1; index < sizes.length; index += 1) expect(sizes[index]).toBeLessThanOrEqual(sizes[index - 1]);
    expect(sizes[3]).toBe(floorBoardPx);
  });

  it('falls back to the cap without a layout', () => {
    expect(refineBrushRadiusAtZoom(4, 0, 1, floorBoardPx, capBoardPx)).toBe(capBoardPx);
  });
});

describe('refineBrushScreenRadiusPt', () => {
  const frame = refineFrameFor({ cx: 0, cy: 0, r: 40 });
  const { floorBoardPx, capBoardPx } = refineBrushLimits(40, frame);
  const onScreen = (screenPt: number, zoom: number) =>
    refineBrushScreenRadiusPt(screenPt, PHONE_BOARD_PX_PER_PT, zoom, floorBoardPx, capBoardPx);

  it('is the picked size when nothing clamps it', () => {
    expect(onScreen(7, 8)).toBeCloseTo(7);
  });

  it('is the clamped radius as it lands on screen, so the preview grows and shrinks with the zoom', () => {
    // At 1× the cap is 24 board px, about 4.4 pt.
    expect(onScreen(14, 1)).toBeCloseTo(capBoardPx / PHONE_BOARD_PX_PER_PT);
    // At 8× the floor (3.75 board px) is about 5.5 pt: a 1 pt pick shows that.
    expect(onScreen(1, 8)).toBeCloseTo((floorBoardPx * 8) / PHONE_BOARD_PX_PER_PT);
  });
});

describe('the brush-size slider range', () => {
  const frame = refineFrameFor({ cx: 0, cy: 0, r: 40 });
  const limits = refineBrushLimits(40, frame);

  it('at 1× on a phone runs from 1 pt to the size that paints the cap', () => {
    const range = refineBrushRangeAtZoom(PHONE_BOARD_PX_PER_PT, 1, limits);
    // The floor (3.75 board px) is under a point at 1×, so the track starts at 1 pt.
    expect(range.minPt).toBe(REFINE_BRUSH_MIN_PT);
    // The cap (24 board px) is about 4.4 pt: no dead upper half.
    expect(range.maxPt).toBeCloseTo(limits.capBoardPx / PHONE_BOARD_PX_PER_PT);
    expect(
      refineBrushRadiusAtZoom(range.maxPt, PHONE_BOARD_PX_PER_PT, 1, limits.floorBoardPx, limits.capBoardPx),
    ).toBeCloseTo(limits.capBoardPx);
  });

  it('at 8× runs from the size that paints the floor to the cap', () => {
    const range = refineBrushRangeAtZoom(PHONE_BOARD_PX_PER_PT, 8, limits);
    expect(range.minPt).toBeCloseTo((limits.floorBoardPx * 8) / PHONE_BOARD_PX_PER_PT);
    // The cap is about 35 pt at 8×: held to the track's 32 pt top.
    expect(range.maxPt).toBe(Math.min(REFINE_BRUSH_MAX_PT, (limits.capBoardPx * 8) / PHONE_BOARD_PX_PER_PT));
    // At 4× it fits: the top of the track paints exactly the cap.
    expect(refineBrushRangeAtZoom(PHONE_BOARD_PX_PER_PT, 4, limits).maxPt).toBeCloseTo(
      (limits.capBoardPx * 4) / PHONE_BOARD_PX_PER_PT,
    );
    const { floorBoardPx, capBoardPx } = limits;
    expect(refineBrushRadiusAtZoom(range.minPt, PHONE_BOARD_PX_PER_PT, 8, floorBoardPx, capBoardPx)).toBeCloseTo(
      floorBoardPx,
    );
  });

  it('stays inside 1-32 pt, and never collapses to nothing', () => {
    const deep = refineBrushRangeAtZoom(
      PHONE_BOARD_PX_PER_PT,
      20,
      refineBrushLimits(200, refineFrameFor({ cx: 0, cy: 0, r: 200 })),
    );
    expect(deep.maxPt).toBe(REFINE_BRUSH_MAX_PT);
    const tiny = refineBrushRangeAtZoom(
      PHONE_BOARD_PX_PER_PT,
      1,
      refineBrushLimits(4, refineFrameFor({ cx: 0, cy: 0, r: 4 })),
    );
    expect(tiny.minPt).toBeGreaterThanOrEqual(REFINE_BRUSH_MIN_PT * 0.8);
    expect(tiny.maxPt).toBeGreaterThan(tiny.minPt);
    expect(refineBrushRangeAtZoom(0, 1, limits)).toEqual(FULL_REFINE_BRUSH_RANGE);
  });

  it('shows a stored size clamped into the range without changing it', () => {
    const atOne = refineBrushRangeAtZoom(PHONE_BOARD_PX_PER_PT, 1, limits);
    const atEight = refineBrushRangeAtZoom(PHONE_BOARD_PX_PER_PT, 8, limits);
    const stored = 2;
    expect(clampRefineBrushPt(stored, atOne)).toBe(stored);
    // At 8× 2 pt is under the floor's size: shown at the bottom of the track...
    expect(clampRefineBrushPt(stored, atEight)).toBe(atEight.minPt);
    // ...and it paints the same brush either way.
    const { floorBoardPx, capBoardPx } = limits;
    expect(refineBrushRadiusAtZoom(stored, PHONE_BOARD_PX_PER_PT, 8, floorBoardPx, capBoardPx)).toBeCloseTo(
      refineBrushRadiusAtZoom(clampRefineBrushPt(stored, atEight), PHONE_BOARD_PX_PER_PT, 8, floorBoardPx, capBoardPx),
    );
    expect(stored).toBe(2);
  });
});

describe('the brush-size slider track', () => {
  const minPt = 1.5;
  const maxPt = 12;

  it('maps the range ends and its middle on a log track, and inverts exactly', () => {
    expect(refineBrushPtAtRatio(0, minPt, maxPt)).toBeCloseTo(minPt);
    expect(refineBrushPtAtRatio(1, minPt, maxPt)).toBeCloseTo(maxPt);
    expect(refineBrushPtAtRatio(0.5, minPt, maxPt)).toBeCloseTo(Math.sqrt(minPt * maxPt));
    for (const ratio of [0, 0.1, 0.37, 0.5, 0.92, 1]) {
      expect(refineBrushRatioForPt(refineBrushPtAtRatio(ratio, minPt, maxPt), minPt, maxPt)).toBeCloseTo(ratio, 9);
    }
    expect(refineBrushRatioForPt(0.5, minPt, maxPt)).toBe(0);
    expect(refineBrushRatioForPt(100, minPt, maxPt)).toBe(1);
    expect(refineBrushPtAtRatio(-1, minPt, maxPt)).toBeCloseTo(minPt);
    expect(refineBrushPtAtRatio(2, minPt, maxPt)).toBeCloseTo(maxPt);
  });

  it('has 21 steps across whatever the range is', () => {
    expect(REFINE_BRUSH_TOP_RUNG).toBe(20);
    expect(refineBrushPtAtRung(0, minPt, maxPt)).toBe(minPt);
    expect(refineBrushPtAtRung(REFINE_BRUSH_TOP_RUNG, minPt, maxPt)).toBe(maxPt);
    expect(refineBrushPtAtRung(-3, minPt, maxPt)).toBe(minPt);
    expect(refineBrushPtAtRung(99, minPt, maxPt)).toBe(maxPt);
    expect(refineBrushRung(refineBrushPtAtRung(7, minPt, maxPt), minPt, maxPt)).toBe(7);
  });

  it('snaps to a step', () => {
    const seventh = refineBrushPtAtRung(7, minPt, maxPt);
    expect(roundRefineBrushPt(seventh * 1.01, minPt, maxPt)).toBe(seventh);
    expect(roundRefineBrushPt(0.2, minPt, maxPt)).toBe(minPt);
    expect(roundRefineBrushPt(500, minPt, maxPt)).toBe(maxPt);
  });

  it('steps one rung per VoiceOver increment or decrement, clamped at the ends', () => {
    const fourth = refineBrushPtAtRung(4, minPt, maxPt);
    expect(adjustRefineBrushPt(fourth, 1, minPt, maxPt)).toBe(refineBrushPtAtRung(5, minPt, maxPt));
    expect(adjustRefineBrushPt(fourth, -1, minPt, maxPt)).toBe(refineBrushPtAtRung(3, minPt, maxPt));
    expect(adjustRefineBrushPt(minPt, -1, minPt, maxPt)).toBe(minPt);
    expect(adjustRefineBrushPt(maxPt, 1, minPt, maxPt)).toBe(maxPt);
    // Every step lands on a value the thumb can reach too.
    let size = minPt;
    for (let step = 0; step < REFINE_BRUSH_TOP_RUNG; step += 1) {
      const next = adjustRefineBrushPt(size, 1, minPt, maxPt);
      expect(roundRefineBrushPt(next, minPt, maxPt)).toBe(next);
      expect(next).toBeGreaterThan(size);
      size = next;
    }
    expect(size).toBe(maxPt);
  });

  it('starts near the old Medium at 1× on a phone', () => {
    expect(DEFAULT_REFINE_BRUSH_PT * PHONE_BOARD_PX_PER_PT).toBeCloseTo(0.3 * 40, -1);
  });

  it('reads a stored size back as stored, or the default', () => {
    expect(parseRefineBrushPt(4)).toBe(4);
    expect(parseRefineBrushPt(4.1)).toBe(4.1);
    expect(parseRefineBrushPt('8')).toBe(8);
    for (const stored of [null, undefined, 'big', 0, -2, 64, Number.NaN, {}]) {
      expect(parseRefineBrushPt(stored)).toBe(DEFAULT_REFINE_BRUSH_PT);
    }
  });
});

describe('the finest brush', () => {
  it('still changes the committed ring, above the engine noise floor', () => {
    // A 40 px hold's floor: 3.75 board px. A dab of it on the right edge must
    // bite a notch the stored ring keeps, not vanish into the decimation.
    const hold = { cx: 600, cy: 400, r: 40, outline: null };
    const frame = refineFrameFor(hold);
    const { floorBoardPx } = refineBrushLimits(hold.r, frame);
    const before = refineStartOutline(hold);
    const edited = brushEditOutline({
      outlineBoardPx: toBrushFrame(before, frame),
      strokeBoardPx: toBrushFrame([hold.cx + hold.r, hold.cy], frame),
      brushRadiusBoardPx: floorBoardPx * frame.scale,
      mode: 'erase',
      anchorX: 0,
      anchorY: 0,
      holdRadius: REFINE_FRAME_RADIUS,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const after = fromBrushFrame(edited.outlineBoardPx, frame);
    const committed = holdFromRefinedOutline(after, { x: hold.cx, y: hold.cy });
    expect(committed.ok).toBe(true);
    if (!committed.ok || !committed.hold.outline) return;
    // The notch's bottom is gone from the stored hold...
    const notchX = (hold.cx + hold.r - floorBoardPx * 0.6 - committed.hold.cx) / committed.hold.r;
    const notchY = (hold.cy - committed.hold.cy) / committed.hold.r;
    expect(pointInRing(committed.hold.outline, notchX, notchY)).toBe(false);
    // ...and the area lost is more than the raster's own noise (about 0.6 px of edge).
    expect(area(before) - area(after)).toBeGreaterThan(8);
  });
});

describe('refineStartOutline', () => {
  it('turns a plain circle into a sampled area', () => {
    const outline = refineStartOutline({ cx: 100, cy: 100, r: 20, outline: null });
    expect(outline).toHaveLength(REFINE_CIRCLE_SAMPLES * 2);
    expect(area(outline)).toBeCloseTo(Math.PI * 400, -1);
  });

  it('keeps a traced outline in board px', () => {
    const outline = refineStartOutline({ cx: 100, cy: 100, r: 10, outline: [-1, -1, 1, -1, 1, 1, -1, 1] });
    expect(outline).toEqual(square(100, 100, 10));
  });
});

describe('holdFromRefinedOutline', () => {
  it('recomputes the centre and the equivalent-area radius, and stores a valid ring', () => {
    const result = holdFromRefinedOutline(square(210, 95, 20), { x: 200, y: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hold.cx).toBeCloseTo(210);
    expect(result.hold.cy).toBeCloseTo(95);
    expect(result.hold.r).toBeCloseTo(Math.sqrt(1600 / Math.PI));
    expect(isValidOutlineRing(result.hold.outline)).toBe(true);
  });

  it('grows the radius until a long thin area fits the ring contract', () => {
    const sliver = [0, 0, 400, 0, 400, 8, 0, 8];
    const result = holdFromRefinedOutline(sliver, { x: 200, y: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) return;
    expect(Math.max(...result.hold.outline.map(Math.abs))).toBeLessThanOrEqual(MAX_RING_COORDINATE);
  });

  it('falls back to the anchor when a concave area does not cover its own centroid', () => {
    // A thick C: its centroid lands in the mouth, outside the shape.
    const thickC = [0, 0, 100, 0, 100, 20, 20, 20, 20, 80, 100, 80, 100, 100, 0, 100];
    const result = holdFromRefinedOutline(thickC, { x: 10, y: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) return;
    expect(result.hold.cx).toBe(10);
    expect(result.hold.cy).toBe(50);
    expect(pointInRing(result.hold.outline, 0, 0)).toBe(true);
  });

  it('falls back to a point inside the area when the centroid and the anchor both miss', () => {
    // A thick C whose anchor also sits in the mouth (the middle was erased away).
    const thickC = [0, 0, 100, 0, 100, 20, 20, 20, 20, 80, 100, 80, 100, 100, 0, 100];
    const result = holdFromRefinedOutline(thickC, { x: 60, y: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) return;
    expect(pointInRing(result.hold.outline, 0, 0)).toBe(true);
  });

  it('refuses an area with nothing in it', () => {
    expect(holdFromRefinedOutline([0, 0, 10, 0, 20, 0], { x: 5, y: 0 })).toEqual({
      ok: false,
      reason: 'too-few-points',
    });
  });
});

describe('interiorPointOnRow', () => {
  it('takes the middle of the widest span on the row', () => {
    const thickC = [0, 0, 100, 0, 100, 20, 20, 20, 20, 80, 100, 80, 100, 100, 0, 100];
    expect(interiorPointOnRow(thickC, 50)).toEqual({ x: 10, y: 50 });
    expect(interiorPointOnRow(thickC, 10)).toEqual({ x: 50, y: 10 });
  });

  it('is null for a row that misses the ring', () => {
    expect(interiorPointOnRow(square(0, 0, 10), 50)).toBeNull();
  });
});

describe('strokeKeepingLargestPiece', () => {
  // A 64-unit circle in the brush frame, like a session opens with.
  const outline = toBrushFrame(refineStartOutline({ cx: 0, cy: 0, r: 64, outline: null }), {
    originX: 0,
    originY: 0,
    scale: 1,
  });

  it('keeps the biggest piece and moves the anchor onto it when the middle is erased', () => {
    // A vertical band through the middle, offset left: the right piece is bigger.
    const stroke = [-20, -90, -20, 90];
    const result = strokeKeepingLargestPiece({
      outlineBrushPx: outline,
      anchorX: 0,
      anchorY: 0,
      holdRadius: 64,
      strokeBrushPx: stroke,
      brushRadius: 12,
      mode: 'erase',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedPieces).toBe(1);
    expect(result.anchorX).toBeGreaterThan(0);
    // Everything kept is right of the band.
    for (let index = 0; index < result.outlineBrushPx.length; index += 2) {
      expect(result.outlineBrushPx[index]).toBeGreaterThan(-12);
    }
    expect(pointInRing(result.outlineBrushPx, result.anchorX, result.anchorY)).toBe(true);
  });

  it('refuses an erase that leaves nothing', () => {
    const result = strokeKeepingLargestPiece({
      outlineBrushPx: outline,
      anchorX: 0,
      anchorY: 0,
      holdRadius: 64,
      strokeBrushPx: [0, 0, 1, 0],
      brushRadius: 200,
      mode: 'erase',
    });
    expect(result).toEqual({ ok: false, reason: 'nothing-left' });
  });

  it('says so when the stroke painted nothing', () => {
    const result = strokeKeepingLargestPiece({
      outlineBrushPx: outline,
      anchorX: 0,
      anchorY: 0,
      holdRadius: 64,
      strokeBrushPx: [0, 0, 5, 0],
      brushRadius: 6,
      mode: 'add',
    });
    expect(result).toEqual({ ok: false, reason: 'no-change' });
  });
});
