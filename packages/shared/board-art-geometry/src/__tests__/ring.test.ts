import { describe, expect, it } from 'vitest';
import {
  MAX_RING_COORDINATE,
  MAX_RING_NUMBERS,
  SIMPLIFY_EPSILON,
  closeRing,
  isValidOutlineRing,
  pointInRing,
  roundRing,
  simplifyRing,
  type RingPoint,
} from '../ring';
import { loadBoardArtGeometry } from '../loader';

/**
 * The ring utilities are the contract between three writers of the same shape:
 * the tracer that generates a shard, the editor a human corrects it in, and the
 * backend that stores the correction. `simplifyRing` in particular is the
 * tracer's own Douglas-Peucker, moved here so all three decimate identically —
 * so its behaviour is pinned against an independent implementation rather than
 * only against itself.
 */

/**
 * A structurally different Douglas-Peucker: explicit stack and a keep-mask,
 * where `simplifyRing` recurses and concatenates. Same algorithm, so agreeing
 * output is evidence the extraction preserved behaviour; a transcription slip
 * (an off-by-one on the scan bounds, a `<` for `<=`) shows up as disagreement.
 */
function referenceSimplify(points: RingPoint[], epsilon: number): RingPoint[] {
  if (points.length < 3) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [first, last] = pending.pop()!;
    if (last - first < 2) continue;
    const [startX, startY] = points[first];
    const [endX, endY] = points[last];
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const length = Math.hypot(deltaX, deltaY);
    let worstIndex = first;
    let worstDistance = -1;
    for (let index = first + 1; index < last; index += 1) {
      const [x, y] = points[index];
      const distance =
        length === 0
          ? Math.hypot(x - startX, y - startY)
          : Math.abs(deltaY * x - deltaX * y + endX * startY - endY * startX) / length;
      if (distance > worstDistance) {
        worstDistance = distance;
        worstIndex = index;
      }
    }
    if (worstDistance <= epsilon) continue;
    keep[worstIndex] = true;
    pending.push([first, worstIndex], [worstIndex, last]);
  }
  return points.filter((_, index) => keep[index]);
}

/** A traced border's worth of points: a blocky staircase with one real corner. */
const STAIRCASE: RingPoint[] = [
  [0, 0],
  [1, 0],
  [2, 1],
  [3, 1],
  [4, 2],
  [5, 2],
  [6, 3],
  [7, 3],
  [8, 4],
  [9, 6],
  [10, 9],
  [11, 13],
  [12, 18],
  [13, 24],
];

function flatten(points: RingPoint[]): number[] {
  return points.flat();
}

describe('simplifyRing', () => {
  it('matches the committed fixture the tracer would produce', () => {
    // Golden values: what the tracer's own Douglas-Peucker returns for this
    // border at its shipped epsilon. A change here is a change to every shard.
    expect(simplifyRing(STAIRCASE, SIMPLIFY_EPSILON)).toEqual([
      [0, 0],
      [8, 4],
      [13, 24],
    ]);
  });

  it('agrees with an independently written Douglas-Peucker', () => {
    const fixtures: RingPoint[][] = [
      STAIRCASE,
      // A circle sampled at 64 points: nothing is more than epsilon off its
      // neighbours' chord until the radius is large, so this exercises the
      // recursive split rather than the early return.
      Array.from({ length: 64 }, (_, index): RingPoint => {
        const angle = (index / 64) * Math.PI * 2;
        return [Math.cos(angle) * 30, Math.sin(angle) * 30];
      }),
      // Collinear run: every interior point is exactly on the chord.
      Array.from({ length: 12 }, (_, index): RingPoint => [index * 3, index * 3]),
      // Degenerate chord — first and last point coincide, so the distance
      // falls back to the radial branch.
      [
        [0, 0],
        [5, 5],
        [9, 1],
        [0, 0],
      ],
    ];
    for (const epsilon of [0.1, SIMPLIFY_EPSILON, 5]) {
      for (const fixture of fixtures) {
        expect(simplifyRing(fixture, epsilon)).toEqual(referenceSimplify(fixture, epsilon));
      }
    }
  });

  it('leaves rings too short to decimate alone', () => {
    expect(simplifyRing([], SIMPLIFY_EPSILON)).toEqual([]);
    expect(
      simplifyRing(
        [
          [1, 1],
          [2, 2],
        ],
        SIMPLIFY_EPSILON,
      ),
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('is idempotent — simplifying an already simplified ring changes nothing', () => {
    const once = simplifyRing(STAIRCASE, SIMPLIFY_EPSILON);
    expect(simplifyRing(once, SIMPLIFY_EPSILON)).toEqual(once);
  });
});

describe('closeRing', () => {
  it('drops a trailing point that repeats the first', () => {
    expect(closeRing([0, 0, 1, 0, 1, 1, 0, 0])).toEqual([0, 0, 1, 0, 1, 1]);
  });

  it('leaves an already implicitly closed ring alone', () => {
    expect(closeRing([0, 0, 1, 0, 1, 1])).toEqual([0, 0, 1, 0, 1, 1]);
  });

  it('leaves a ring too short to have a duplicate end alone', () => {
    expect(closeRing([0, 0])).toEqual([0, 0]);
  });
});

describe('roundRing', () => {
  it('rounds to the shard contract of 4 decimals', () => {
    expect(roundRing([0.123456, -1.987654, 2.00005], 4)).toEqual([0.1235, -1.9877, 2.0001]);
  });

  it('collapses negative zero, which would otherwise serialise as -0', () => {
    expect(Object.is(roundRing([-0.00001], 4)[0], 0)).toBe(true);
  });
});

describe('pointInRing', () => {
  const square = [-1, -1, 1, -1, 1, 1, -1, 1];

  it('puts the centre of a square inside it', () => {
    expect(pointInRing(square, 0, 0)).toBe(true);
    expect(pointInRing(square, 0.9, -0.9)).toBe(true);
  });

  it('puts a point outside the square outside it', () => {
    expect(pointInRing(square, 2, 0)).toBe(false);
    expect(pointInRing(square, 0, -3)).toBe(false);
  });

  it('reads an implicitly closed ring — the last edge back to the first point counts', () => {
    // A triangle whose only edge crossing the ray from (0.2, 0.2) is the
    // implicit closing one. Without it the point reads as outside.
    const triangle = [0, 0, 1, 0, 0, 1];
    expect(pointInRing(triangle, 0.2, 0.2)).toBe(true);
    expect(pointInRing(triangle, 0.9, 0.9)).toBe(false);
  });

  it('rejects anything short of a triangle', () => {
    expect(pointInRing([0, 0, 1, 1], 0.5, 0.5)).toBe(false);
    expect(pointInRing([], 0, 0)).toBe(false);
  });
});

describe('isValidOutlineRing', () => {
  it('accepts every outline in a committed shard', () => {
    // Kilter Original 12x12 — the largest shipped shard, 476 traced holds. If
    // the validator's bounds were tighter than the tracer's own output, a
    // correction to a real hold could not be stored in the shape it has.
    const geometry = loadBoardArtGeometry({ boardName: 'kilter', layoutId: 1, sizeId: 10 });
    expect(geometry).not.toBeNull();
    const outlines = Object.values(geometry!.outlines);
    expect(outlines.length).toBeGreaterThan(400);
    for (const outline of outlines) {
      expect(isValidOutlineRing(outline)).toBe(true);
    }
  });

  it('rejects an odd-length ring', () => {
    expect(isValidOutlineRing([0, 0, 1, 0, 1])).toBe(false);
  });

  it('rejects NaN and Infinity coordinates', () => {
    expect(isValidOutlineRing([0, 0, 1, 0, Number.NaN, 1])).toBe(false);
    expect(isValidOutlineRing([0, 0, 1, 0, Number.POSITIVE_INFINITY, 1])).toBe(false);
  });

  it('rejects a coordinate outside the radius bound', () => {
    expect(isValidOutlineRing([0, 0, 1, 0, MAX_RING_COORDINATE + 0.001, 1])).toBe(false);
    expect(isValidOutlineRing([0, 0, 1, 0, -MAX_RING_COORDINATE - 0.001, 1])).toBe(false);
    expect(isValidOutlineRing([0, 0, 1, 0, MAX_RING_COORDINATE, 1])).toBe(true);
  });

  it('rejects rings that are too short or too long', () => {
    expect(isValidOutlineRing([0, 0, 1, 1])).toBe(false);
    expect(isValidOutlineRing(new Array<number>(MAX_RING_NUMBERS + 2).fill(1))).toBe(false);
    expect(isValidOutlineRing(new Array<number>(MAX_RING_NUMBERS).fill(1))).toBe(true);
  });

  it('rejects non-arrays and non-numeric members', () => {
    expect(isValidOutlineRing(null)).toBe(false);
    expect(isValidOutlineRing('0,0,1,0,1,1')).toBe(false);
    expect(isValidOutlineRing([0, 0, '1', 0, 1, 1])).toBe(false);
  });

  it('accepts a ring built from points, matching what an editor hands back', () => {
    const ring = flatten(
      simplifyRing(
        Array.from({ length: 40 }, (_, index): RingPoint => {
          const angle = (index / 40) * Math.PI * 2;
          return [Math.cos(angle), Math.sin(angle)];
        }),
        0.02,
      ),
    );
    expect(isValidOutlineRing(roundRing(closeRing(ring), 4))).toBe(true);
  });
});
