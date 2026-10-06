import { describe, expect, it } from 'vitest';
import { MIN_BRUSH_RADIUS_BOARD_PX } from '@boardsesh/board-art-geometry/brush';
import { MAX_RING_COORDINATE, isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import {
  REFINE_CIRCLE_SAMPLES,
  REFINE_FRAME_RADIUS,
  REFINE_FRAME_SCALE_MAX,
  fromBrushFrame,
  holdFromRefinedOutline,
  interiorPointOnRow,
  refineBrushRadiusBoardPx,
  refineFrameFor,
  refineStartOutline,
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

describe('refineBrushRadiusBoardPx', () => {
  it('is a fraction of the hold, whatever the zoom', () => {
    const frame = refineFrameFor({ cx: 0, cy: 0, r: 40 });
    expect(refineBrushRadiusBoardPx('small', 40, frame)).toBeCloseTo(6);
    expect(refineBrushRadiusBoardPx('medium', 40, frame)).toBeCloseTo(12);
    expect(refineBrushRadiusBoardPx('large', 40, frame)).toBeCloseTo(24);
    // A hold four times the size gets a brush four times the size.
    const big = refineFrameFor({ cx: 0, cy: 0, r: 160 });
    expect(refineBrushRadiusBoardPx('medium', 160, big)).toBeCloseTo(48);
  });

  it('keeps every preset in the same place in the brush frame', () => {
    for (const r of [12, 40, 200]) {
      const frame = refineFrameFor({ cx: 0, cy: 0, r });
      expect(refineBrushRadiusBoardPx('medium', r, frame) * frame.scale).toBeCloseTo(0.3 * REFINE_FRAME_RADIUS);
    }
  });

  it('never drops below the smallest brush the engine can apply', () => {
    // A 2 px hold clamps the frame scale, so 15% of it is under the engine floor.
    const frame = refineFrameFor({ cx: 0, cy: 0, r: 2 });
    expect(refineBrushRadiusBoardPx('small', 2, frame)).toBeCloseTo(MIN_BRUSH_RADIUS_BOARD_PX / frame.scale);
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
