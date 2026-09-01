import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE } from '@boardsesh/play-view';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';
import {
  ROW_TOLERANCE_RADII,
  spatialPlacementOrder,
  stepPlacement,
  zoomTargetForHold,
  type BoardZoomTarget,
} from '../hold-navigation';

function hold(id: number, cx: number, cy: number, r = 10): BoardHoldTarget {
  return { id, cx, cy, r };
}

/**
 * The board's forward transform, copied from `use-zoom-pan-gesture`'s
 * `animatedZoomStyle` ([translate, scale] about a centre origin) — the same
 * helper `stroke.test.ts` uses. `zoomTargetForHold` is only correct if pushing
 * the hold through this lands it in the middle of the viewport.
 */
function forwardTransform(
  localX: number,
  localY: number,
  target: BoardZoomTarget,
  renderWidth: number,
  renderHeight: number,
): [number, number] {
  const centreX = renderWidth / 2;
  const centreY = renderHeight / 2;
  return [
    centreX + target.scale * (localX - centreX) + target.translateX,
    centreY + target.scale * (localY - centreY) + target.translateY,
  ];
}

describe('spatialPlacementOrder', () => {
  it('returns nothing for a board with no placements', () => {
    expect(spatialPlacementOrder([])).toEqual([]);
  });

  it('reads a single row left to right', () => {
    const order = spatialPlacementOrder([hold(3, 300, 100), hold(1, 100, 100), hold(2, 200, 100)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('reads rows top to bottom, each left to right', () => {
    const order = spatialPlacementOrder([hold(4, 200, 500), hold(1, 100, 100), hold(3, 100, 500), hold(2, 200, 100)]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('buckets a row that is not perfectly level', () => {
    // Within 0.8r of the anchor's cy: same row, so cx decides.
    const jitter = 10 * ROW_TOLERANCE_RADII - 0.001;
    const order = spatialPlacementOrder([hold(2, 200, 100 + jitter), hold(1, 100, 100)]);
    expect(order).toEqual([1, 2]);
  });

  it('starts a new row just past the tolerance', () => {
    const beyond = 10 * ROW_TOLERANCE_RADII + 0.001;
    // The lower hold is to the LEFT, so a plain cx sort would put it first —
    // only correct row bucketing yields [1, 2].
    const order = spatialPlacementOrder([hold(2, 10, 100 + beyond), hold(1, 500, 100)]);
    expect(order).toEqual([1, 2]);
  });

  it('measures the tolerance against the row anchor, not the previous hold', () => {
    // 0, 0.7r, 1.4r. Chaining off each previous hold would call all three one
    // row; against the anchor the third is 1.4r away and starts its own.
    const order = spatialPlacementOrder([hold(1, 500, 0), hold(2, 400, 7), hold(3, 300, 14)]);
    expect(order).toEqual([2, 1, 3]);
  });

  it('keeps every placement exactly once', () => {
    const holds = Array.from({ length: 60 }, (_, index) =>
      hold(index + 1, (index % 10) * 100, Math.floor(index / 10) * 100),
    );
    const order = spatialPlacementOrder(holds);
    expect(order).toHaveLength(60);
    expect(new Set(order).size).toBe(60);
  });
});

describe('stepPlacement', () => {
  // Placement ids 10/20/30 at indices 0/1/2 — the argument is the INDEX.
  const order = [10, 20, 30];
  const indexOf = (placementId: number) => order.indexOf(placementId);

  it('has nowhere to go on an empty board', () => {
    expect(stepPlacement([], null, 1)).toBeNull();
    expect(stepPlacement([], 0, -1)).toBeNull();
  });

  it('enters at the first hold going forward and the last going back', () => {
    expect(stepPlacement(order, null, 1)).toBe(10);
    expect(stepPlacement(order, null, -1)).toBe(30);
  });

  it('advances and retreats one step', () => {
    expect(stepPlacement(order, indexOf(20), 1)).toBe(30);
    expect(stepPlacement(order, indexOf(20), -1)).toBe(10);
  });

  it('wraps at both ends', () => {
    expect(stepPlacement(order, indexOf(30), 1)).toBe(10);
    expect(stepPlacement(order, indexOf(10), -1)).toBe(30);
  });

  it('treats an index off the end of the board as no selection', () => {
    // What the caller's position Map yields for a stale selection: a miss it
    // turns into null, or — defensively — an index the order no longer has.
    for (const staleIndex of [-1, order.length, 999]) {
      expect(stepPlacement(order, staleIndex, 1)).toBe(10);
      expect(stepPlacement(order, staleIndex, -1)).toBe(30);
    }
  });

  it('walks the whole board and returns to the start', () => {
    let current = stepPlacement(order, null, 1);
    for (let step = 0; step < order.length; step += 1) {
      current = stepPlacement(order, current == null ? null : indexOf(current), 1);
    }
    expect(current).toBe(10);
  });
});

describe('zoomTargetForHold', () => {
  const boardWidth = 1080;
  const renderWidth = 360;
  const renderHeight = 640;

  it('centres a mid-board hold under the board’s own forward transform', () => {
    const target = zoomTargetForHold({
      hold: hold(1, boardWidth / 2, 960, 30),
      boardWidth,
      renderWidth,
      renderHeight,
    });
    const renderScale = renderWidth / boardWidth;
    const [screenX, screenY] = forwardTransform(
      (boardWidth / 2) * renderScale,
      960 * renderScale,
      target,
      renderWidth,
      renderHeight,
    );
    expect(screenX).toBeCloseTo(renderWidth / 2, 6);
    expect(screenY).toBeCloseTo(renderHeight / 2, 6);
  });

  it('frames a corner hold as far as the board allows, never past its edge', () => {
    const target = zoomTargetForHold({ hold: hold(1, 0, 0, 30), boardWidth, renderWidth, renderHeight });
    // The pan clamp is the ceiling; a corner hold pins the board against it
    // rather than dragging empty space into frame.
    expect(target.translateX).toBeCloseTo((renderWidth * (target.scale - 1)) / 2, 6);
    expect(target.translateY).toBeCloseTo((renderHeight * (target.scale - 1)) / 2, 6);
  });

  it('stays inside the gesture system’s zoom range', () => {
    for (const radius of [1, 30, 400, 5000]) {
      const target = zoomTargetForHold({ hold: hold(1, 540, 960, radius), boardWidth, renderWidth, renderHeight });
      expect(target.scale).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(target.scale).toBeLessThanOrEqual(MAX_SCALE);
    }
  });

  it('saturates at MAX_SCALE for a real Aurora placement radius', () => {
    // Documents the note on zoomTargetForHold: a catalogue hold (r = xSpacing*4,
    // ~30 board px on a 1080-wide board) wants far more magnification than the
    // shared ceiling allows, so the ceiling is what decides how close we get.
    const target = zoomTargetForHold({ hold: hold(1, 540, 960, 30), boardWidth, renderWidth, renderHeight });
    expect(target.scale).toBe(MAX_SCALE);
  });

  it('uses the computed scale when the hold is big enough to need less than the ceiling', () => {
    // Half the viewport's short side, so hold + 1.5r context exactly fills it.
    const radiusBoardPx = ((renderWidth / 2 / (1 + 1.5)) * boardWidth) / renderWidth;
    const target = zoomTargetForHold({
      hold: hold(1, 540, 960, radiusBoardPx),
      boardWidth,
      renderWidth,
      renderHeight,
    });
    expect(target.scale).toBeLessThan(MAX_SCALE);
    expect(target.scale).toBeCloseTo(Math.min(renderWidth, renderHeight) / 2 / (renderWidth / 2), 6);
  });

  it('degrades to an identity transform before the board is measured', () => {
    const identity = { scale: MIN_SCALE, translateX: 0, translateY: 0 };
    // Every way the geometry can be missing: the view not yet laid out, and a
    // board config that resolved no dimensions at all.
    expect(zoomTargetForHold({ hold: hold(1, 540, 960, 30), boardWidth, renderWidth: 0, renderHeight: 0 })).toEqual(
      identity,
    );
    expect(zoomTargetForHold({ hold: hold(1, 540, 960, 30), boardWidth, renderWidth, renderHeight: 0 })).toEqual(
      identity,
    );
    expect(zoomTargetForHold({ hold: hold(1, 540, 960, 30), boardWidth: 0, renderWidth, renderHeight })).toEqual(
      identity,
    );
  });
});
