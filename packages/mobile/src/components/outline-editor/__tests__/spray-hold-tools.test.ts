import { describe, expect, it } from 'vitest';
import {
  MAX_RING_COORDINATE,
  MAX_RING_NUMBERS,
  isValidOutlineRing,
  pointInRing,
  type RingPoint,
} from '@boardsesh/board-art-geometry/ring';
import {
  convexHull,
  defaultHoldRadius,
  holdAtPoint,
  holdBoundaryPoints,
  holdFromPolygon,
  holdFromStroke,
  holdFromTap,
  MIN_HOLD_RADIUS_BOARD_PX,
  mergeHoldGeometry,
  POLYGON_MAX_VERTICES,
  polygonCentroidAndArea,
  polygonSelfOverlaps,
  radiusForRing,
  toRingPoints,
  type HoldGeometry,
  strokeExtent,
} from '../spray-hold-tools';
import {
  fallbackRadiusAt,
  flattenHitHolds,
  holdIdAtPoint,
  selectedDragIdAt,
  screenToBoard,
} from '../spray-gesture-math';
import { radiusRingToBoardPx, screenToBoardPoint } from '../stroke';

/** A closed-ish freehand circle, as a finger would draw it. */
function circleStroke(cx: number, cy: number, radius: number, samples = 40): RingPoint[] {
  return Array.from({ length: samples }, (_, index) => {
    const angle = (index / samples) * Math.PI * 2;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius] as RingPoint;
  });
}

describe('polygonCentroidAndArea', () => {
  it('finds the centre and area of a square', () => {
    const square: RingPoint[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonCentroidAndArea(square)).toEqual({ cx: 5, cy: 5, area: 100 });
  });

  it('is orientation-independent — a clockwise square has the same positive area', () => {
    const clockwise: RingPoint[] = [
      [0, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ];
    expect(polygonCentroidAndArea(clockwise)).toEqual({ cx: 5, cy: 5, area: 100 });
  });

  it('falls back to the vertex mean for a degenerate polygon with no area', () => {
    const line: RingPoint[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    expect(polygonCentroidAndArea(line)).toEqual({ cx: 10, cy: 0, area: 0 });
  });
});

describe('radiusForRing', () => {
  it('uses the equivalent-area radius for a roughly round shape', () => {
    const points = circleStroke(0, 0, 30);
    const { cx, cy, area } = polygonCentroidAndArea(points);
    expect(radiusForRing(points, cx, cy, area)).toBeCloseTo(30, 0);
  });

  it('grows the radius so a long thin shape still fits inside the coordinate bound', () => {
    // A 400x4 sliver: its equivalent-area radius is ~22, but its far end is 200
    // away — nine radii, and the stored ring may not pass four.
    const sliver: RingPoint[] = [
      [-200, -2],
      [200, -2],
      [200, 2],
      [-200, 2],
    ];
    const { cx, cy, area } = polygonCentroidAndArea(sliver);
    const radius = radiusForRing(sliver, cx, cy, area);
    const farthest = Math.max(...sliver.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    expect(farthest / radius).toBeLessThan(MAX_RING_COORDINATE);
  });

  it('never returns a radius smaller than a tap target', () => {
    expect(radiusForRing([[0, 0]], 0, 0, 0)).toBe(MIN_HOLD_RADIUS_BOARD_PX);
  });
});

describe('holdFromStroke', () => {
  it('turns a drawn loop into a hold whose centre and radius match the loop', () => {
    const result = holdFromStroke(circleStroke(300, 400, 24));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hold.cx).toBeCloseTo(300, 0);
    expect(result.hold.cy).toBeCloseTo(400, 0);
    expect(result.hold.r).toBeCloseTo(24, 0);
    expect(result.hold.outline).not.toBeNull();
  });

  it('produces an outline whose coordinates are in radius units of its own radius', () => {
    const result = holdFromStroke(circleStroke(300, 400, 24));
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) return;
    for (const coordinate of result.hold.outline) {
      expect(Math.abs(coordinate)).toBeLessThanOrEqual(MAX_RING_COORDINATE);
    }
    // A traced circle sits about one radius out in every direction.
    const first = Math.hypot(result.hold.outline[0], result.hold.outline[1]);
    expect(first).toBeGreaterThan(0.8);
    expect(first).toBeLessThan(1.3);
  });

  it('refuses a stroke with nothing to make a polygon out of', () => {
    const result = holdFromStroke([
      [0, 0],
      [1, 1],
    ]);
    expect(result).toEqual({ ok: false, reason: 'too-few-points' });
  });
});

describe('holdFromPolygon', () => {
  const square: RingPoint[] = [
    [100, 100],
    [140, 100],
    [140, 140],
    [100, 140],
  ];

  it('turns four corners into a hold centred in the square with a storable ring', () => {
    const result = holdFromPolygon(square);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) throw new Error('expected a traced hold');
    expect(result.hold.cx).toBeCloseTo(120);
    expect(result.hold.cy).toBeCloseTo(120);
    expect(result.hold.outline).toHaveLength(8);
    expect(isValidOutlineRing(result.hold.outline)).toBe(true);
    // The ring walks back to the exact corners the climber tapped.
    const boardRing = radiusRingToBoardPx(result.hold.outline, { id: 0, ...result.hold });
    expect(boardRing[0]).toBeCloseTo(100, 2);
    expect(boardRing[1]).toBeCloseTo(100, 2);
    expect(boardRing[4]).toBeCloseTo(140, 2);
    expect(boardRing[5]).toBeCloseTo(140, 2);
  });

  it('refuses two corners', () => {
    expect(
      holdFromPolygon([
        [0, 0],
        [10, 10],
      ]),
    ).toEqual({ ok: false, reason: 'too-few-points' });
  });

  it('refuses three corners on one line, which enclose nothing', () => {
    expect(
      holdFromPolygon([
        [0, 0],
        [10, 10],
        [20, 20],
      ]),
    ).toEqual({ ok: false, reason: 'too-few-points' });
  });

  it('refuses a bow-tie whose edges cross', () => {
    expect(
      holdFromPolygon([
        [0, 0],
        [40, 40],
        [40, 0],
        [0, 40],
      ]),
    ).toEqual({ ok: false, reason: 'self-overlap' });
  });

  it('refuses one corner more than a stored ring can hold', () => {
    expect(POLYGON_MAX_VERTICES * 2).toBe(MAX_RING_NUMBERS);
    const tooMany = circleStroke(500, 500, 200, POLYGON_MAX_VERTICES + 1);
    expect(holdFromPolygon(tooMany)).toEqual({ ok: false, reason: 'too-complex' });
  });

  it('accepts exactly the cap', () => {
    const result = holdFromPolygon(circleStroke(500, 500, 200, POLYGON_MAX_VERTICES));
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) throw new Error('expected a traced hold');
    expect(result.hold.outline).toHaveLength(MAX_RING_NUMBERS);
  });

  it('refuses a deep C whose centre falls in the open mouth', () => {
    // Outer 100x100, a 80x60 bite out of the right side. The centroid lands at
    // x ~41, about 21 board px (0.5 radii) into the mouth.
    const letterC: RingPoint[] = [
      [0, 0],
      [100, 0],
      [100, 20],
      [20, 20],
      [20, 80],
      [100, 80],
      [100, 100],
      [0, 100],
    ];
    expect(holdFromPolygon(letterC)).toEqual({ ok: false, reason: 'centre-outside' });
  });

  it('drops a closing corner that repeats the first', () => {
    const result = holdFromPolygon([...square, [100.2, 100.1]]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) throw new Error('expected a traced hold');
    expect(result.hold.outline).toHaveLength(8);
  });

  it('drops a corner tapped twice in a row', () => {
    const result = holdFromPolygon([square[0], square[1], [140.1, 100.2], square[2], square[3]]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) throw new Error('expected a traced hold');
    expect(result.hold.outline).toHaveLength(8);
  });

  it('keeps every corner, even one a stroke simplifier would have dropped', () => {
    // 0.3 px off the bottom edge: far inside the 1.6 px Douglas-Peucker tolerance.
    const result = holdFromPolygon([
      [0, 0],
      [50, 0.3],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.hold.outline) throw new Error('expected a traced hold');
    expect(result.hold.outline).toHaveLength(10);
  });
});

describe('polygonSelfOverlaps', () => {
  it('passes a simple concave polygon', () => {
    expect(
      polygonSelfOverlaps([
        [0, 0],
        [20, 0],
        [10, 5],
        [20, 20],
        [0, 20],
      ]),
    ).toBe(false);
  });

  it('catches a corner that lands on a non-adjacent edge', () => {
    expect(
      polygonSelfOverlaps([
        [0, 0],
        [20, 0],
        [20, 20],
        [10, 0],
        [0, 20],
      ]),
    ).toBe(true);
  });

  it('catches an edge that folds straight back over the one before it', () => {
    expect(
      polygonSelfOverlaps([
        [0, 0],
        [20, 0],
        [10, 0],
        [10, 20],
      ]),
    ).toBe(true);
  });
});

describe('holdFromTap', () => {
  it('places a plain circle, which is what a null outline renders as', () => {
    expect(holdFromTap(10, 20, 30)).toEqual({ cx: 10, cy: 20, r: 30, outline: null });
  });

  it('floors the radius so a tap can never place an unhittable hold', () => {
    expect(holdFromTap(10, 20, 0).r).toBe(MIN_HOLD_RADIUS_BOARD_PX);
  });
});

describe('defaultHoldRadius', () => {
  it('is the median of the wall', () => {
    const holds: HoldGeometry[] = [10, 20, 90].map((r) => ({ cx: 0, cy: 0, r, outline: null }));
    expect(defaultHoldRadius(holds, 1000)).toBe(20);
  });

  it('averages the middle pair on an even count', () => {
    const holds: HoldGeometry[] = [10, 20, 30, 100].map((r) => ({ cx: 0, cy: 0, r, outline: null }));
    expect(defaultHoldRadius(holds, 1000)).toBe(25);
  });

  it('falls back to a fraction of the photo on an empty wall', () => {
    expect(defaultHoldRadius([], 2000)).toBe(40);
  });
});

describe('convexHull', () => {
  it('drops a point inside the hull', () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual([5, 5]);
  });

  it('hands back what it was given when there is no hull to build', () => {
    expect(convexHull([[1, 2]])).toEqual([[1, 2]]);
  });
});

describe('mergeHoldGeometry', () => {
  const left: HoldGeometry = { cx: 100, cy: 100, r: 20, outline: null };
  const right: HoldGeometry = { cx: 140, cy: 100, r: 20, outline: null };

  it('produces one hold covering both', () => {
    const merged = mergeHoldGeometry(left, right);
    expect(merged).not.toBeNull();
    if (!merged) return;
    expect(merged.cx).toBeCloseTo(120, 0);
    expect(merged.cy).toBeCloseTo(100, 0);
    // The SILHOUETTE is what covers both — the hull is taken over every boundary
    // point of each original, so neither hold's centre ends up outside it.
    expect(merged.outline).not.toBeNull();
    const boardRing = radiusRingToBoardPx(merged.outline ?? [], { id: 0, ...merged });
    expect(pointInRing(boardRing, left.cx, left.cy)).toBe(true);
    expect(pointInRing(boardRing, right.cx, right.cy)).toBe(true);
  });

  it('keeps the union inside the storable coordinate bound', () => {
    const merged = mergeHoldGeometry(left, { cx: 900, cy: 100, r: 20, outline: null });
    expect(merged).not.toBeNull();
    if (!merged?.outline) return;
    for (const coordinate of merged.outline) {
      expect(Math.abs(coordinate)).toBeLessThanOrEqual(MAX_RING_COORDINATE);
    }
  });

  it('merges a traced silhouette with a plain circle', () => {
    const traced = holdFromStroke(circleStroke(100, 100, 20));
    expect(traced.ok).toBe(true);
    if (!traced.ok) return;
    const merged = mergeHoldGeometry(traced.hold, right);
    expect(merged?.outline).not.toBeNull();
  });
});

describe('holdBoundaryPoints', () => {
  it('samples a circle for a hold with no outline', () => {
    const points = holdBoundaryPoints({ cx: 0, cy: 0, r: 10, outline: null }, 8);
    expect(points).toHaveLength(8);
    for (const [x, y] of points) expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
  });

  it('walks the stored ring back into board px for a traced hold', () => {
    const points = holdBoundaryPoints({ cx: 50, cy: 60, r: 10, outline: [1, 0, 0, 1, -1, 0] });
    expect(points).toEqual([
      [60, 60],
      [50, 70],
      [40, 60],
    ]);
  });
});

describe('holdAtPoint', () => {
  const holds = [
    { id: 1, cx: 100, cy: 100, r: 20, outline: null },
    { id: 2, cx: 110, cy: 100, r: 5, outline: null },
    { id: 3, cx: 300, cy: 100, r: 4, outline: null },
  ];

  it('gives an overlapping tap to the SMALLEST hold that contains it', () => {
    // Inside both circles: the crimp wins, wherever the centres are.
    expect(holdAtPoint(holds, 108, 100)?.id).toBe(2);
    expect(holdAtPoint(holds, 106, 100)?.id).toBe(2);
    // Inside the jug only.
    expect(holdAtPoint(holds, 90, 100)?.id).toBe(1);
  });

  it('falls back to the nearest centre within 1.4r when nothing contains the tap', () => {
    expect(holdAtPoint(holds, 305, 100)?.id).toBe(3);
    expect(holdAtPoint(holds, 306, 100)).toBeNull();
  });

  it('widens the grab area to a fingertip on screen, which shrinks as you zoom in', () => {
    // A 1000 px photo drawn 250 px wide: 4 board px per render px.
    const atRest = fallbackRadiusAt(4, 1);
    const zoomed = fallbackRadiusAt(4, 4);
    expect(atRest).toBe(88);
    expect(zoomed).toBe(22);
    expect(holdAtPoint(holds, 360, 100, atRest)?.id).toBe(3);
    expect(holdAtPoint(holds, 360, 100, zoomed)).toBeNull();
    expect(holdAtPoint(holds, 320, 100, zoomed)?.id).toBe(3);
  });

  it('answers null on bare wall', () => {
    expect(holdAtPoint(holds, 800, 800)).toBeNull();
  });
});

describe('holdIdAtPoint (the UI-thread twin)', () => {
  const holds = [
    { id: 1, cx: 100, cy: 100, r: 20, outline: null },
    { id: -2, cx: 110, cy: 100, r: 5, outline: null },
    { id: 3, cx: 300, cy: 100, r: 4, outline: null },
  ];
  const flat = flattenHitHolds(holds);

  it.each([
    [108, 100, 0],
    [90, 100, 0],
    [305, 100, 0],
    [360, 100, 88],
    [360, 100, 22],
    [800, 800, 0],
  ])('agrees with holdAtPoint at (%d, %d) with fallback %d', (x, y, fallback) => {
    expect(holdIdAtPoint(flat, x, y, fallback)).toBe(holdAtPoint(holds, x, y, fallback)?.id ?? 0);
  });

  it('lets a live hold stand in for its stale entry in the list', () => {
    // Hold 3 has been dragged to (500, 100) and the list has not caught up.
    expect(holdIdAtPoint(flat, 500, 100, 12, [3, 500, 100, 4])).toBe(3);
    expect(holdIdAtPoint(flat, 300, 100, 12, [3, 500, 100, 4])).toBe(0);
    // A live hold missing from the list entirely still counts.
    expect(holdIdAtPoint([], 10, 10, 12, [7, 10, 10, 4])).toBe(7);
  });

  describe('selectedDragIdAt', () => {
    it('claims a touch on the selection, a fingertip wide at least', () => {
      expect(selectedDragIdAt(flattenHitHolds([holds[2]]), [3, 300, 100, 4], 310, 100, 12)).toBe(3);
      expect(selectedDragIdAt(flattenHitHolds([holds[2]]), [3, 300, 100, 4], 320, 100, 12)).toBe(0);
      expect(selectedDragIdAt(flat, [], 100, 100, 12)).toBe(0);
    });

    it('never claims a drag of the selection for a touch on a neighbour inside its grab radius', () => {
      // Hold 1 (r 20) is selected; the finger lands on hold -2, which sits
      // inside 1's radius. The touch is -2's, so no drag of 1 is claimed.
      expect(selectedDragIdAt(flat, [1, 100, 100, 20], 110, 100, 12)).toBe(0);
      // Off the neighbour, the same big selection still claims.
      expect(selectedDragIdAt(flat, [1, 100, 100, 20], 90, 100, 12)).toBe(1);
    });

    it('claims the small selection even when a big neighbour contains the touch', () => {
      expect(selectedDragIdAt(flat, [-2, 110, 100, 5], 111, 100, 12)).toBe(-2);
    });

    it('uses the live position of a selection that has just been moved', () => {
      expect(selectedDragIdAt(flat, [3, 500, 100, 4], 501, 100, 12)).toBe(3);
    });
  });

  it('inverts the board transform exactly as the stroke chain does', () => {
    const transform = { scale: 2.5, translateX: 40, translateY: -30, containerWidth: 300, containerHeight: 400 };
    const expected = screenToBoardPoint(210, 90, transform, 900, 300);
    const actual = screenToBoard(210, 90, 2.5, 40, -30, 300, 400, 3);
    expect(actual.x).toBeCloseTo(expected[0]);
    expect(actual.y).toBeCloseTo(expected[1]);
  });
});

describe('toRingPoints', () => {
  it('pairs a flat list and drops an odd trailing number', () => {
    expect(toRingPoints([1, 2, 3, 4, 5])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe('strokeExtent', () => {
  it('is zero with no points and for a single point', () => {
    expect(strokeExtent([])).toBe(0);
    expect(strokeExtent([12, 30])).toBe(0);
  });

  it('is the wider side of the bounding box', () => {
    expect(strokeExtent([0, 0, 4, 1, 2, 9])).toBe(9);
    expect(strokeExtent([10, 5, -6, 7])).toBe(16);
  });
});
