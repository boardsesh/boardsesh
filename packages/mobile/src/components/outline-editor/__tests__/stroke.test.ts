import { describe, expect, it } from 'vitest';
import { CENTRE_TOLERANCE_RADII, MAX_RING_NUMBERS, closeRing, roundRing } from '@boardsesh/board-art-geometry/ring';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';
import {
  OUTLINE_DECIMALS,
  boardRingToRadiusUnits,
  buildOutlineRing,
  closeStrokeLoop,
  dedupeStrokePoints,
  placementRingPathData,
  radiusRingToBoardPx,
  renderToBoardScale,
  ringCoversCentre,
  ringToPathData,
  screenToBoardPoint,
  screenToRenderPoint,
  type BoardZoomTransform,
} from '../stroke';

const HOLD: BoardHoldTarget = { id: 42, cx: 400, cy: 300, r: 20 };

const AT_REST: BoardZoomTransform = {
  scale: 1,
  translateX: 0,
  translateY: 0,
  containerWidth: 360,
  containerHeight: 480,
};

// A real zoomed-in-and-panned state: 2.5x with the board pushed left and up, the
// shape `useZoomPanGesture` produces after a pinch plus a drag.
const ZOOMED: BoardZoomTransform = {
  scale: 2.5,
  translateX: -140,
  translateY: 96,
  containerWidth: 360,
  containerHeight: 480,
};

/** The forward map the board's `animatedZoomStyle` applies (centre origin). */
function forwardTransform(localX: number, localY: number, transform: BoardZoomTransform): [number, number] {
  const centreX = transform.containerWidth / 2;
  const centreY = transform.containerHeight / 2;
  return [
    centreX + transform.scale * (localX - centreX) + transform.translateX,
    centreY + transform.scale * (localY - centreY) + transform.translateY,
  ];
}

/** A regular n-gon in board px around a centre — the shape a clean trace makes. */
function circleBoardPoints(centreX: number, centreY: number, radius: number, count: number): [number, number][] {
  const points: [number, number][] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    points.push([centreX + Math.cos(angle) * radius, centreY + Math.sin(angle) * radius]);
  }
  return points;
}

describe('screenToRenderPoint', () => {
  it('is the exact inverse of the board transform at rest', () => {
    const [screenX, screenY] = forwardTransform(120, 200, AT_REST);
    const [renderX, renderY] = screenToRenderPoint(screenX, screenY, AT_REST);
    expect(renderX).toBeCloseTo(120, 10);
    expect(renderY).toBeCloseTo(200, 10);
  });

  it('is the exact inverse of a zoomed, panned board transform', () => {
    for (const [localX, localY] of [
      [0, 0],
      [120, 200],
      [359, 479],
    ] as const) {
      const [screenX, screenY] = forwardTransform(localX, localY, ZOOMED);
      const [renderX, renderY] = screenToRenderPoint(screenX, screenY, ZOOMED);
      expect(renderX).toBeCloseTo(localX, 10);
      expect(renderY).toBeCloseTo(localY, 10);
    }
  });
});

describe('renderToBoardScale', () => {
  it('scales render px up to board px', () => {
    expect(renderToBoardScale(1080, 360)).toBe(3);
  });

  it('is zero rather than Infinity before the board is measured', () => {
    expect(renderToBoardScale(1080, 0)).toBe(0);
  });
});

describe('screenToBoardPoint', () => {
  it('round-trips a board point through the zoomed transform and back', () => {
    const boardWidth = 1080;
    const renderWidth = 360;
    const boardScale = renderToBoardScale(boardWidth, renderWidth);
    // Start from a known board point, project it to render px, forward-transform
    // it to a screen touch, then run the editor's chain over that touch.
    const boardPoint: [number, number] = [612, 441];
    const renderPoint: [number, number] = [boardPoint[0] / boardScale, boardPoint[1] / boardScale];
    const [screenX, screenY] = forwardTransform(renderPoint[0], renderPoint[1], ZOOMED);

    const [recoveredX, recoveredY] = screenToBoardPoint(screenX, screenY, ZOOMED, boardWidth, renderWidth);
    expect(recoveredX).toBeCloseTo(boardPoint[0], 8);
    expect(recoveredY).toBeCloseTo(boardPoint[1], 8);
  });
});

describe('dedupeStrokePoints', () => {
  it('drops samples closer than the minimum distance', () => {
    const points: [number, number][] = [
      [0, 0],
      [0.1, 0],
      [5, 0],
      [5.1, 0.1],
      [10, 0],
    ];
    expect(dedupeStrokePoints(points, 1)).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
  });
});

describe('closeStrokeLoop', () => {
  it('drops a tail that has come back onto the head', () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [1, 1],
      [0.5, 0.5],
    ];
    expect(closeStrokeLoop(points, 3)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
  });

  it('never eats the whole stroke', () => {
    const points: [number, number][] = [
      [0, 0],
      [0.1, 0],
      [0.2, 0],
    ];
    expect(closeStrokeLoop(points, 10)).toHaveLength(2);
  });
});

describe('boardRingToRadiusUnits / radiusRingToBoardPx', () => {
  it('round-trips board px through radius units', () => {
    const boardRing = [420, 300, 400, 320, 380, 300, 400, 280];
    const radiusRing = boardRingToRadiusUnits(boardRing, HOLD);
    expect(radiusRing).toEqual([1, 0, 0, 1, -1, 0, 0, -1]);
    expect(radiusRingToBoardPx(radiusRing, HOLD)).toEqual(boardRing);
  });
});

describe('ringCoversCentre', () => {
  it('accepts a ring around the origin', () => {
    const ring = [1, 0, 0, 1, -1, 0, 0, -1];
    expect(ringCoversCentre(ring)).toBe(true);
  });

  it('accepts a ring that misses the centre by less than the tolerance', () => {
    const missBy = CENTRE_TOLERANCE_RADII / 2;
    const ring = [missBy, -1, 1, 0, missBy, 1];
    expect(ringCoversCentre(ring)).toBe(true);
  });

  it('rejects a ring drawn around the neighbouring hold', () => {
    const ring = [1, 0, 3, 0, 3, 2, 1, 2];
    expect(ringCoversCentre(ring)).toBe(false);
  });
});

describe('buildOutlineRing', () => {
  it('turns a traced circle into a stored ring in radius units', () => {
    const stroke = circleBoardPoints(HOLD.cx, HOLD.cy, HOLD.r, 48);
    const result = buildOutlineRing(stroke, HOLD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every coordinate lands near the unit circle, because the stroke was drawn
    // at exactly the placement radius.
    for (let index = 0; index < result.outline.length; index += 2) {
      const distance = Math.hypot(result.outline[index], result.outline[index + 1]);
      expect(distance).toBeGreaterThan(0.9);
      expect(distance).toBeLessThan(1.1);
    }
    expect(result.outline.length).toBeGreaterThanOrEqual(6);
    expect(result.outline.length).toBeLessThanOrEqual(MAX_RING_NUMBERS);
  });

  it('rounds stored coordinates to 4 decimals', () => {
    const stroke = circleBoardPoints(HOLD.cx, HOLD.cy, HOLD.r * 1.13137, 40);
    const result = buildOutlineRing(stroke, HOLD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const value of result.outline) {
      expect(value).toBe(Math.round(value * 10000) / 10000);
    }
  });

  it('survives the full screen → stored-ring chain on a zoomed board', () => {
    const boardWidth = 1080;
    const renderWidth = 360;
    const boardScale = renderToBoardScale(boardWidth, renderWidth);
    const hold: BoardHoldTarget = { id: 7, cx: 540, cy: 720, r: 24 };

    // Synthesize the touches a pencil would produce tracing this hold while the
    // board is zoomed 2.5x and panned.
    const screenStroke = circleBoardPoints(hold.cx, hold.cy, hold.r, 60).map(([boardX, boardY]) =>
      forwardTransform(boardX / boardScale, boardY / boardScale, ZOOMED),
    );
    const boardStroke = screenStroke.map(([screenX, screenY]) =>
      screenToBoardPoint(screenX, screenY, ZOOMED, boardWidth, renderWidth),
    );

    const result = buildOutlineRing(boardStroke, hold);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ringCoversCentre(result.outline)).toBe(true);
    for (let index = 0; index < result.outline.length; index += 2) {
      expect(Math.hypot(result.outline[index], result.outline[index + 1])).toBeCloseTo(1, 1);
    }
  });

  it('rejects a stroke too short to be an outline', () => {
    const result = buildOutlineRing(
      [
        [400, 300],
        [401, 300],
      ],
      HOLD,
    );
    expect(result).toEqual({ ok: false, reason: 'too-few-points' });
  });

  it('rejects a ring drawn around the neighbouring hold', () => {
    const stroke = circleBoardPoints(HOLD.cx + HOLD.r * 2.2, HOLD.cy, HOLD.r, 40);
    const result = buildOutlineRing(stroke, HOLD);
    expect(result).toEqual({ ok: false, reason: 'centre-outside' });
  });

  it('rejects a ring far larger than any hold', () => {
    const stroke = circleBoardPoints(HOLD.cx, HOLD.cy, HOLD.r * 6, 40);
    const result = buildOutlineRing(stroke, HOLD);
    expect(result).toEqual({ ok: false, reason: 'out-of-bounds' });
  });

  it('decimates a dense scribble down to a storable ring', () => {
    const stroke = circleBoardPoints(HOLD.cx, HOLD.cy, HOLD.r, 2000);
    const result = buildOutlineRing(stroke, HOLD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.length).toBeLessThanOrEqual(MAX_RING_NUMBERS);
  });
});

describe('ringToPathData', () => {
  it('emits a closed subpath', () => {
    expect(ringToPathData([0, 0, 10, 0, 10, 10])).toBe('M0 0L10 0L10 10Z');
  });

  it('emits nothing for a ring too short to draw', () => {
    expect(ringToPathData([0, 0, 10, 0])).toBe('');
  });
});

describe('placementRingPathData', () => {
  it('draws a circle at the placement radius', () => {
    expect(placementRingPathData(HOLD)).toBe('M380 300a20 20 0 1 0 40 0a20 20 0 1 0 -40 0Z');
  });
});

describe('buildOutlineRing normalisation order', () => {
  it('matches the server: rounding can equate a head and tail that closing alone would keep', () => {
    // Property of the two primitives, asserted directly. `roundRing` collapses a
    // 5th-decimal difference; `closeRing` only drops an EXACT duplicate. So the
    // two orders genuinely disagree, and the backend's upsert resolver commits to
    // closeRing(roundRing(...)) — which is why buildOutlineRing does the same.
    const ring = [0, 0, 1, 0, 1, 1, 0.00001, 0.00001];
    const roundThenClose = closeRing(roundRing(ring, OUTLINE_DECIMALS));
    const closeThenRound = roundRing(closeRing(ring), OUTLINE_DECIMALS);
    expect(roundThenClose).toHaveLength(6);
    expect(closeThenRound).toHaveLength(8);
    expect(closeThenRound.slice(0, 6)).toEqual(roundThenClose);
  });

  it('emits a ring the server normalisation leaves untouched', () => {
    // The guarantee that actually matters: whatever the editor previews is
    // byte-for-byte what the resolver stores, so re-running its
    // closeRing(roundRing(...)) is a no-op. A close-before-round client would
    // fail this whenever the two orders diverged.
    for (const pointCount of [12, 48, 200]) {
      const result = buildOutlineRing(circleBoardPoints(HOLD.cx, HOLD.cy, HOLD.r, pointCount), HOLD);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(closeRing(roundRing(result.outline, OUTLINE_DECIMALS))).toEqual(result.outline);
    }
  });
});
