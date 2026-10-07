import { describe, expect, it } from 'vitest';
import { isValidOutlineRing, type RingPoint } from '@boardsesh/board-art-geometry/ring';
import {
  clampPointToPhoto,
  holdFromStroke,
  holdFromTap,
  holdRadiusBounds,
  MIN_HOLD_RADIUS_BOARD_PX,
  RESIZE_GAIN_PT,
  RESIZE_STEP_RATIO,
  resizeFromDrag,
  snapRadiusToGrid,
  stepHoldRadius,
  stepHoldRadiusBy,
} from '../spray-hold-tools';
import {
  boardToScreen,
  fingertipScreenPt,
  holdReach,
  isOnPhoto,
  projectOnto,
  RESIZE_HANDLE_CLEARANCE_PT,
  RESIZE_HANDLE_HIT_PT,
  resizeHandleAnchor,
  resizeHandleDistance,
  screenToBoard,
} from '../spray-gesture-math';
import { initialSprayEditorState, sprayEditorReducer, type SprayEditorHold } from '../spray-hold-editor-reducer';

/** Screen points of handle travel for this many whole grid steps. */
function travelForSteps(steps: number): number {
  return RESIZE_GAIN_PT * Math.log(RESIZE_STEP_RATIO) * steps;
}

/** Where a radius sits on the grid, in steps from the median. */
function gridPosition(radius: number, median: number): number {
  return Math.log(radius / median) / Math.log(RESIZE_STEP_RATIO);
}

const MEDIAN = 20;
/** A big landscape photo, so the photo bound never bites unless a test wants it to. */
const WIDE_BOUNDS = holdRadiusBounds(MEDIAN, 4000, 3000);

describe('holdRadiusBounds', () => {
  it('runs from 0.3x to 4x the median on a roomy photo', () => {
    expect(WIDE_BOUNDS.min).toBeCloseTo(6);
    expect(WIDE_BOUNDS.max).toBeCloseTo(80);
  });

  it('never lets the minimum under the tap-target floor', () => {
    expect(holdRadiusBounds(4, 4000, 3000).min).toBe(MIN_HOLD_RADIUS_BOARD_PX);
  });

  it("caps the maximum at a fifth of the photo's shorter side", () => {
    expect(holdRadiusBounds(MEDIAN, 2048, 300).max).toBeCloseTo(60);
  });

  it('drops a term it has nothing for, and never ends with max under min', () => {
    expect(holdRadiusBounds(MEDIAN, 0, 0).max).toBeCloseTo(80);
    expect(holdRadiusBounds(0, 0, 0)).toEqual({ min: MIN_HOLD_RADIUS_BOARD_PX, max: MIN_HOLD_RADIUS_BOARD_PX });
    const tinyPhoto = holdRadiusBounds(MEDIAN, 10, 10);
    expect(tinyPhoto.max).toBeGreaterThanOrEqual(tinyPhoto.min);
  });
});

describe('snapRadiusToGrid', () => {
  it('lands on median x 1.05^n', () => {
    const snapped = snapRadiusToGrid(MEDIAN * 1.16, MEDIAN);
    expect(snapped).toBeCloseTo(MEDIAN * Math.pow(1.05, 3));
    expect(snapRadiusToGrid(MEDIAN, MEDIAN)).toBeCloseTo(MEDIAN);
  });

  it('leaves a radius alone with no median to measure against', () => {
    expect(snapRadiusToGrid(12, 0)).toBe(12);
  });
});

describe('stepHoldRadius', () => {
  it('moves an on-grid hold exactly one 5% step', () => {
    expect(stepHoldRadius(MEDIAN, MEDIAN, 1, WIDE_BOUNDS)).toBeCloseTo(MEDIAN * 1.05);
    expect(stepHoldRadius(MEDIAN, MEDIAN, -1, WIDE_BOUNDS)).toBeCloseTo(MEDIAN / 1.05);
  });

  it('agrees with the handle: one press up then down comes back to the same grid size', () => {
    const up = stepHoldRadius(MEDIAN, MEDIAN, 1, WIDE_BOUNDS);
    expect(up).not.toBeNull();
    expect(stepHoldRadius(up ?? 0, MEDIAN, -1, WIDE_BOUNDS)).toBeCloseTo(MEDIAN);
  });

  it('never shrinks a hold with + or grows one with −, wherever it starts', () => {
    for (let radius = 6.2; radius < 79; radius *= 1.013) {
      const grown = stepHoldRadius(radius, MEDIAN, 1, WIDE_BOUNDS);
      const shrunk = stepHoldRadius(radius, MEDIAN, -1, WIDE_BOUNDS);
      if (grown != null) expect(grown).toBeGreaterThan(radius);
      if (shrunk != null) expect(shrunk).toBeLessThan(radius);
    }
  });

  it('counts a hold a hair off a grid size as on it, so a press is never a 1% nudge', () => {
    const justUnder = MEDIAN * Math.pow(1.05, 3) * 0.995;
    expect(stepHoldRadius(justUnder, MEDIAN, 1, WIDE_BOUNDS)).toBeCloseTo(MEDIAN * Math.pow(1.05, 4));
  });

  it('stops at the bounds', () => {
    const top = MEDIAN * Math.pow(1.05, Math.floor(gridPosition(WIDE_BOUNDS.max, MEDIAN)));
    const bottom = MEDIAN * Math.pow(1.05, Math.ceil(gridPosition(WIDE_BOUNDS.min, MEDIAN)));
    expect(stepHoldRadius(top, MEDIAN, 1, WIDE_BOUNDS)).toBeNull();
    expect(stepHoldRadius(bottom, MEDIAN, -1, WIDE_BOUNDS)).toBeNull();
    expect(stepHoldRadius(top, MEDIAN, -1, WIDE_BOUNDS)).not.toBeNull();
  });

  it('brings a hold already past a bound back inside on the first press towards them', () => {
    const huge = WIDE_BOUNDS.max * 2;
    expect(stepHoldRadius(huge, MEDIAN, 1, WIDE_BOUNDS)).toBeNull();
    const back = stepHoldRadius(huge, MEDIAN, -1, WIDE_BOUNDS);
    expect(back).not.toBeNull();
    expect(back ?? Infinity).toBeLessThanOrEqual(WIDE_BOUNDS.max);
  });

  it('refuses nonsense rather than inventing a size', () => {
    expect(stepHoldRadius(10, 0, 1, WIDE_BOUNDS)).toBeNull();
    expect(stepHoldRadius(0, 10, 1, WIDE_BOUNDS)).toBeNull();
  });
});

describe('stepHoldRadiusBy', () => {
  it('takes several grid steps in one go', () => {
    expect(stepHoldRadiusBy(MEDIAN, MEDIAN, 1, WIDE_BOUNDS, 4)).toBeCloseTo(MEDIAN * Math.pow(1.05, 4));
    expect(stepHoldRadiusBy(MEDIAN, MEDIAN, -1, WIDE_BOUNDS, 4)).toBeCloseTo(MEDIAN * Math.pow(1.05, -4));
  });

  it('stops at a bound part of the way, and is null with no room at all', () => {
    const top = MEDIAN * Math.pow(1.05, Math.floor(gridPosition(WIDE_BOUNDS.max, MEDIAN)));
    expect(stepHoldRadiusBy(top / 1.05, MEDIAN, 1, WIDE_BOUNDS, 4)).toBeCloseTo(top);
    expect(stepHoldRadiusBy(top, MEDIAN, 1, WIDE_BOUNDS, 4)).toBeNull();
  });
});

describe('clampPointToPhoto', () => {
  it('keeps a point on the photo', () => {
    expect(clampPointToPhoto(-30, 900, 1200, 800)).toEqual({ x: 0, y: 800 });
    expect(clampPointToPhoto(1500, -2, 1200, 800)).toEqual({ x: 1200, y: 0 });
    expect(clampPointToPhoto(600, 400, 1200, 800)).toEqual({ x: 600, y: 400 });
  });

  it('clamps nothing on a photo with no size yet', () => {
    expect(clampPointToPhoto(-30, 900, 0, 0)).toEqual({ x: -30, y: 900 });
  });
});

describe('resizeFromDrag', () => {
  /** A grab size four grid steps above the median: far enough that the two magnets never overlap. */
  const start = MEDIAN * Math.pow(1.05, 4);

  it('changes nothing for a drag that has not moved', () => {
    expect(resizeFromDrag(0, start, MEDIAN, WIDE_BOUNDS)).toEqual({
      r: start,
      stepIndex: 4,
      magnet: 'original',
      atBound: false,
    });
  });

  it('takes about 6 pt of travel per 5% step, whatever the hold', () => {
    expect(travelForSteps(1)).toBeGreaterThan(5.5);
    expect(travelForSteps(1)).toBeLessThan(6.5);
    const grown = resizeFromDrag(travelForSteps(3), start, MEDIAN, WIDE_BOUNDS);
    expect(grown.r).toBeCloseTo(MEDIAN * Math.pow(1.05, 7));
    expect(grown.stepIndex).toBe(7);
    expect(grown.magnet).toBeNull();
  });

  it('holds the grab size within half a step either way', () => {
    expect(resizeFromDrag(travelForSteps(0.45), start, MEDIAN, WIDE_BOUNDS).magnet).toBe('original');
    expect(resizeFromDrag(travelForSteps(-0.45), start, MEDIAN, WIDE_BOUNDS).r).toBe(start);
    expect(resizeFromDrag(travelForSteps(0.6), start, MEDIAN, WIDE_BOUNDS).magnet).toBeNull();
  });

  it('keeps an off-grid grab size exactly, and leaves it for the grid past half a step', () => {
    const traced = MEDIAN * Math.pow(1.05, 4.3);
    expect(resizeFromDrag(travelForSteps(0.2), traced, MEDIAN, WIDE_BOUNDS).r).toBe(traced);
    const past = resizeFromDrag(travelForSteps(0.8), traced, MEDIAN, WIDE_BOUNDS);
    expect(past.r).toBeCloseTo(MEDIAN * Math.pow(1.05, 5));
  });

  it('snaps to the median, and calls it the median', () => {
    const typical = resizeFromDrag(travelForSteps(-4.3), start, MEDIAN, WIDE_BOUNDS);
    expect(typical.r).toBeCloseTo(MEDIAN);
    expect(typical.magnet).toBe('median');
    expect(typical.stepIndex).toBe(0);
  });

  it('prefers the grab size when both magnets are in reach and it is no farther', () => {
    const nearMedian = MEDIAN * Math.pow(1.05, 0.4);
    expect(resizeFromDrag(0, nearMedian, MEDIAN, WIDE_BOUNDS).magnet).toBe('original');
    // Closer to the median than to the grab size: the median wins.
    expect(resizeFromDrag(travelForSteps(-0.35), nearMedian, MEDIAN, WIDE_BOUNDS).magnet).toBe('median');
  });

  it('clamps at the bounds and says so', () => {
    const shrunk = resizeFromDrag(-1000, start, MEDIAN, WIDE_BOUNDS);
    expect(shrunk).toMatchObject({ r: WIDE_BOUNDS.min, atBound: true, magnet: null });
    const grown = resizeFromDrag(1000, start, MEDIAN, WIDE_BOUNDS);
    expect(grown).toMatchObject({ r: WIDE_BOUNDS.max, atBound: true, magnet: null });
  });

  it('lets a hold that was already out of bounds keep its own size', () => {
    const merged = WIDE_BOUNDS.max * 1.5;
    expect(resizeFromDrag(0, merged, MEDIAN, WIDE_BOUNDS).r).toBe(merged);
    expect(resizeFromDrag(travelForSteps(-1), merged, MEDIAN, WIDE_BOUNDS).r).toBe(WIDE_BOUNDS.max);
  });

  it('only ever answers a grid size, a magnet or a bound', () => {
    for (let travel = -200; travel <= 200; travel += 1.7) {
      const result = resizeFromDrag(travel, start, MEDIAN, WIDE_BOUNDS);
      const position = gridPosition(result.r, MEDIAN);
      const onGrid = Math.abs(position - Math.round(position)) < 1e-9;
      const isBound = result.r === WIDE_BOUNDS.min || result.r === WIDE_BOUNDS.max;
      expect(onGrid || isBound || result.magnet === 'original').toBe(true);
    }
  });

  it('grows monotonically with outward travel, from inside or outside the bounds', () => {
    // In bounds, a wide merge above the max, and a hold below the min.
    for (const grabSize of [start, WIDE_BOUNDS.max * 1.5, WIDE_BOUNDS.min * 0.5]) {
      let previous = 0;
      for (let travel = -200; travel <= 200; travel += 2) {
        const { r } = resizeFromDrag(travel, grabSize, MEDIAN, WIDE_BOUNDS);
        expect(r).toBeGreaterThanOrEqual(previous);
        previous = r;
      }
    }
  });

  it('never moves an out-of-bounds hold against the drag', () => {
    const merged = WIDE_BOUNDS.max * 1.5;
    expect(resizeFromDrag(travelForSteps(3), merged, MEDIAN, WIDE_BOUNDS)).toMatchObject({
      r: merged,
      magnet: 'original',
      atBound: true,
    });
    const undersized = WIDE_BOUNDS.min * 0.5;
    expect(resizeFromDrag(travelForSteps(-3), undersized, MEDIAN, WIDE_BOUNDS)).toMatchObject({
      r: undersized,
      atBound: true,
    });
    // Back towards the bounds, it steps inside them.
    expect(resizeFromDrag(travelForSteps(3), undersized, MEDIAN, WIDE_BOUNDS).r).toBeGreaterThanOrEqual(
      WIDE_BOUNDS.min,
    );
  });
});

describe('resizing keeps the ring contract', () => {
  const blob: RingPoint[] = Array.from({ length: 36 }, (_, index) => {
    const angle = (index / 36) * Math.PI * 2;
    const wobble = 1 + 0.3 * Math.sin(angle * 3);
    return [400 + Math.cos(angle) * 30 * wobble, 300 + Math.sin(angle) * 22 * wobble] as RingPoint;
  });

  it('changes r alone, so the stored ring is untouched and still valid at either bound', () => {
    const traced = holdFromStroke(blob);
    expect(traced.ok).toBe(true);
    if (!traced.ok) return;
    const hold: SprayEditorHold = {
      ...traced.hold,
      id: 7,
      source: 'MANUAL',
      confidence: null,
      review: 'accepted',
      dirty: false,
    };
    const loaded = sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds: [hold] });
    for (const radius of [WIDE_BOUNDS.min, WIDE_BOUNDS.max]) {
      const resized = sprayEditorReducer(loaded, { type: 'RESIZE_HOLD', id: 7, r: radius });
      const after = resized.holds[7];
      expect(after.r).toBe(radius);
      expect(after.outline).toEqual(hold.outline);
      expect(isValidOutlineRing(after.outline ?? [])).toBe(true);
      expect(after.cx).toBe(hold.cx);
      expect(after.cy).toBe(hold.cy);
    }
  });

  it('is one undo step', () => {
    const hold: SprayEditorHold = {
      ...holdFromTap(100, 100, MEDIAN),
      id: 3,
      source: 'AUTO',
      confidence: 0.9,
      review: 'accepted',
      dirty: false,
    };
    const loaded = sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds: [hold] });
    const resized = sprayEditorReducer(loaded, { type: 'RESIZE_HOLD', id: 3, r: MEDIAN * 1.05 });
    expect(resized.past).toHaveLength(1);
    expect(sprayEditorReducer(resized, { type: 'UNDO' }).holds[3].r).toBe(MEDIAN);
  });
});

describe('press-and-hold placement', () => {
  it('adds a hold and selects it as one undo step', () => {
    const loaded = sprayEditorReducer(initialSprayEditorState(), { type: 'LOAD', holds: [] });
    const newId = loaded.nextLocalId;
    const added = sprayEditorReducer(loaded, { type: 'ADD_HOLD', geometry: holdFromTap(50, 60, MEDIAN) });
    const selected = sprayEditorReducer(added, { type: 'SELECT', id: newId });
    expect(selected.selectedId).toBe(newId);
    expect(selected.holds[newId]).toMatchObject({ cx: 50, cy: 60, r: MEDIAN, outline: null });
    expect(selected.past).toHaveLength(1);
    const undone = sprayEditorReducer(selected, { type: 'UNDO' });
    expect(undone.holds[newId]).toBeUndefined();
  });
});

describe('boardToScreen', () => {
  it('is the exact inverse of screenToBoard', () => {
    const transforms = [
      { scale: 1, translateX: 0, translateY: 0 },
      { scale: 2.5, translateX: 40, translateY: -30 },
      { scale: 8, translateX: -900, translateY: 1200 },
    ];
    for (const { scale, translateX, translateY } of transforms) {
      for (const [boardX, boardY] of [
        [0, 0],
        [612, 1340],
        [2048, 1536],
      ]) {
        const screen = boardToScreen(boardX, boardY, scale, translateX, translateY, 390, 520, 5.25);
        const back = screenToBoard(screen.x, screen.y, scale, translateX, translateY, 390, 520, 5.25);
        expect(back.x).toBeCloseTo(boardX);
        expect(back.y).toBeCloseTo(boardY);
      }
    }
  });
});

describe('boardToScreen over a viewport', () => {
  // The zoomed spray editor: a 390 × 520 photo drawn at (0, 162) inside the
  // editor's viewport. The board context hands overlays the translate with
  // that offset folded in, so the same functions map viewport points.
  const offsetX = 0;
  const offsetY = 162;
  const renderWidth = 390;
  const renderHeight = 520;
  const boardScale = 5.25;

  it('puts the photo where the fitted box is at 1x', () => {
    const corner = boardToScreen(0, 0, 1, offsetX, offsetY, renderWidth, renderHeight, boardScale);
    expect(corner).toEqual({ x: 0, y: 162 });
    const far = boardToScreen(
      renderWidth * boardScale,
      renderHeight * boardScale,
      1,
      offsetX,
      offsetY,
      renderWidth,
      renderHeight,
      boardScale,
    );
    expect(far.x).toBeCloseTo(390);
    expect(far.y).toBeCloseTo(682);
  });

  it('matches a render-box view placed at the offset and transformed about its own centre', () => {
    const scale = 6;
    const panX = -310;
    const panY = 420;
    const boardX = 1200;
    const boardY = 900;
    const screen = boardToScreen(boardX, boardY, scale, panX + offsetX, panY + offsetY, 390, 520, boardScale);
    // The view's own maths: offset + centre + scale · (local − centre) + translate.
    expect(screen.x).toBeCloseTo(offsetX + 195 + scale * (boardX / boardScale - 195) + panX);
    expect(screen.y).toBeCloseTo(offsetY + 260 + scale * (boardY / boardScale - 260) + panY);
    const back = screenToBoard(screen.x, screen.y, scale, panX + offsetX, panY + offsetY, 390, 520, boardScale);
    expect(back.x).toBeCloseTo(boardX);
    expect(back.y).toBeCloseTo(boardY);
  });

  it('maps the dark band above the photo to a point off it', () => {
    const point = screenToBoard(100, 40, 1, offsetX, offsetY, renderWidth, renderHeight, boardScale);
    expect(point.y).toBeLessThan(0);
    expect(isOnPhoto(point.x, point.y, renderWidth * boardScale, renderHeight * boardScale)).toBe(false);
  });
});

describe('isOnPhoto', () => {
  it('takes the photo and its edges', () => {
    expect(isOnPhoto(0, 0, 4000, 3000)).toBe(true);
    expect(isOnPhoto(4000, 3000, 4000, 3000)).toBe(true);
    expect(isOnPhoto(2000, 1500, 4000, 3000)).toBe(true);
  });

  it('refuses anything past an edge', () => {
    expect(isOnPhoto(-0.5, 10, 4000, 3000)).toBe(false);
    expect(isOnPhoto(10, -0.5, 4000, 3000)).toBe(false);
    expect(isOnPhoto(4000.5, 10, 4000, 3000)).toBe(false);
    expect(isOnPhoto(10, 3000.5, 4000, 3000)).toBe(false);
  });
});

describe('holdReach', () => {
  it('is the radius for a plain circle', () => {
    expect(holdReach(holdFromTap(0, 0, 12))).toBe(12);
  });

  it('is the farthest outline point for a traced hold', () => {
    expect(holdReach({ cx: 0, cy: 0, r: 10, outline: [1, 0, 0, 1.5, -1, 0, 0, -1] })).toBeCloseTo(15);
  });
});

describe('projectOnto', () => {
  it('measures travel along the handle direction, outward positive', () => {
    const diagonal = Math.SQRT1_2;
    expect(projectOnto(10, 10, diagonal, diagonal)).toBeCloseTo(Math.hypot(10, 10));
    expect(projectOnto(-10, -10, diagonal, diagonal)).toBeCloseTo(-Math.hypot(10, 10));
    expect(projectOnto(10, -10, diagonal, diagonal)).toBeCloseTo(0);
  });
});

/**
 * The shortest distance from a point to the handle's touch box: a
 * `RESIZE_HANDLE_HIT_PT` square centred on the dot and turned 45°, as drawn.
 */
function distanceToTurnedBox(pointX: number, pointY: number, boxX: number, boxY: number): number {
  const dx = pointX - boxX;
  const dy = pointY - boxY;
  // Into the box's own frame (rotate by -45°), where it is axis-aligned.
  const localX = (dx + dy) * Math.SQRT1_2;
  const localY = (dy - dx) * Math.SQRT1_2;
  const half = RESIZE_HANDLE_HIT_PT / 2;
  return Math.hypot(Math.max(Math.abs(localX) - half, 0), Math.max(Math.abs(localY) - half, 0));
}

describe('resizeHandleDistance', () => {
  it('keeps the touch box off the hold and its fingertip disc, at any size and zoom', () => {
    const viewport = { width: 390, height: 844 };
    for (const scale of [0.8, 1, 2, 3, 6]) {
      const fingertip = fingertipScreenPt(scale);
      for (let reach = 2; reach <= 60; reach += 0.5) {
        const ownDisc = Math.max(reach, fingertip);
        // Every diagonal the flip can pick, from the middle and each corner of the screen.
        for (const centre of [
          { x: 195, y: 400 },
          { x: 380, y: 400 },
          { x: 195, y: 830 },
          { x: 380, y: 830 },
          { x: 10, y: 10 },
        ]) {
          const anchor = resizeHandleAnchor(centre, reach, fingertip, viewport, []);
          const gap = distanceToTurnedBox(centre.x, centre.y, anchor.x, anchor.y);
          expect(gap).toBeGreaterThanOrEqual(ownDisc + RESIZE_HANDLE_CLEARANCE_PT - 1e-9);
        }
      }
    }
  });

  it('puts the dot of a median hold at 1x clear of the 22 pt fingertip grab', () => {
    // ~8 pt reach on a 390 pt phone: the review's case.
    const distance = resizeHandleDistance(8, fingertipScreenPt(1));
    expect(distance - RESIZE_HANDLE_HIT_PT / 2).toBeGreaterThanOrEqual(22);
  });

  it('tracks the hold once it is bigger than a fingertip', () => {
    expect(resizeHandleDistance(80, 22) - resizeHandleDistance(40, 22)).toBeCloseTo(40);
  });
});

describe('resizeHandleAnchor', () => {
  const viewport = { width: 390, height: 600 };
  const fingertip = 22;
  const distance = resizeHandleDistance(20, fingertip);
  const offset = distance * Math.SQRT1_2;

  it('sits on the bottom-right diagonal by default', () => {
    const anchor = resizeHandleAnchor({ x: 150, y: 200 }, 20, fingertip, viewport, []);
    expect(anchor.x).toBeCloseTo(150 + offset);
    expect(anchor.y).toBeCloseTo(200 + offset);
    expect(anchor.ux).toBeGreaterThan(0);
    expect(anchor.uy).toBeGreaterThan(0);
  });

  it('flips left at the right edge', () => {
    const anchor = resizeHandleAnchor({ x: 340, y: 200 }, 20, fingertip, viewport, []);
    expect(anchor.ux).toBeLessThan(0);
    expect(anchor.uy).toBeGreaterThan(0);
  });

  it('flips up when the bars are below it', () => {
    const bars = [{ x: 0, y: 240, width: 390, height: 360 }];
    const anchor = resizeHandleAnchor({ x: 150, y: 200 }, 20, fingertip, viewport, bars);
    expect(anchor.uy).toBeLessThan(0);
    expect(anchor.ux).toBeGreaterThan(0);
  });

  it('goes to the top-left in the bottom-right corner', () => {
    const anchor = resizeHandleAnchor({ x: 340, y: 550 }, 20, fingertip, viewport, []);
    expect(anchor.ux).toBeLessThan(0);
    expect(anchor.uy).toBeLessThan(0);
  });

  it('keeps its whole touch box on screen when a diagonal is clear', () => {
    // The turned box's corners reach this far along each axis.
    const half = RESIZE_HANDLE_HIT_PT * Math.SQRT1_2;
    for (const centre of [
      { x: 20, y: 20 },
      { x: 370, y: 20 },
      { x: 20, y: 580 },
      { x: 195, y: 300 },
    ]) {
      const anchor = resizeHandleAnchor(centre, 10, fingertip, viewport, []);
      expect(anchor.x - half).toBeGreaterThanOrEqual(0);
      expect(anchor.y - half).toBeGreaterThanOrEqual(0);
      expect(anchor.x + half).toBeLessThanOrEqual(viewport.width);
      expect(anchor.y + half).toBeLessThanOrEqual(viewport.height);
    }
  });

  it('falls back to a dot that is at least visible when no box fits, and to bottom-right failing that', () => {
    // A strip too short for any turned box, with the bottom-right dot past its right edge.
    const strip = resizeHandleAnchor({ x: 388, y: 5 }, 0, fingertip, { width: 390, height: 60 }, []);
    expect(strip.ux).toBeLessThan(0);
    expect(strip.uy).toBeGreaterThan(0);
    // A hold so big every dot is off screen.
    const offScreen = resizeHandleAnchor({ x: 195, y: 300 }, 1000, fingertip, viewport, []);
    expect(offScreen.ux).toBeGreaterThan(0);
    expect(offScreen.uy).toBeGreaterThan(0);
  });
});
