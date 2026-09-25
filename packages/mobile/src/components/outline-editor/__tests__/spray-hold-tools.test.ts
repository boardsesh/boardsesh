import { describe, expect, it } from 'vitest';
import { MAX_RING_COORDINATE, pointInRing, type RingPoint } from '@boardsesh/board-art-geometry/ring';
import {
  classifyStroke,
  convexHull,
  defaultHoldRadius,
  holdAtPoint,
  holdBoundaryPoints,
  holdFromStroke,
  holdFromTap,
  MIN_HOLD_RADIUS_BOARD_PX,
  mergeHoldGeometry,
  polygonCentroidAndArea,
  radiusForRing,
  toRingPoints,
  type HoldGeometry,
} from '../spray-hold-tools';
import { radiusRingToBoardPx } from '../stroke';

/** A closed-ish freehand circle, as a finger would draw it. */
function circleStroke(cx: number, cy: number, radius: number, samples = 40): RingPoint[] {
  return Array.from({ length: samples }, (_, index) => {
    const angle = (index / samples) * Math.PI * 2;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius] as RingPoint;
  });
}

describe('classifyStroke', () => {
  it('reads a stroke that stayed put as a tap, at the centre of where it wandered', () => {
    const gesture = classifyStroke(
      [
        [100, 100],
        [101, 102],
        [99, 101],
      ],
      20,
    );
    expect(gesture).toEqual({ kind: 'tap', x: 100, y: 101 });
  });

  it('reads a loop as a drag, not a tap, even though it ends where it started', () => {
    const gesture = classifyStroke(circleStroke(200, 200, 25), 20);
    expect(gesture?.kind).toBe('drag');
  });

  it('scales the tap window with the hold radius in play', () => {
    const wander: RingPoint[] = [
      [0, 0],
      [8, 0],
    ];
    // On a wall whose holds are 60 px across, an 8 px wobble is a tap...
    expect(classifyStroke(wander, 60)?.kind).toBe('tap');
    // ...and on one whose holds are 10 px across it is a deliberate drag.
    expect(classifyStroke(wander, 10)?.kind).toBe('drag');
  });

  it('answers null for an empty stroke rather than inventing a point', () => {
    expect(classifyStroke([], 20)).toBeNull();
  });
});

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
  ];

  it('finds the nearest centre when two holds overlap', () => {
    expect(holdAtPoint(holds, 110, 100)?.id).toBe(2);
    expect(holdAtPoint(holds, 95, 100)?.id).toBe(1);
  });

  it('answers null on bare wall', () => {
    expect(holdAtPoint(holds, 400, 400)).toBeNull();
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
