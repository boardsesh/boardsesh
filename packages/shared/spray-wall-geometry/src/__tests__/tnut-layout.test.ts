import { describe, expect, it } from 'vite-plus/test';
import { mapPoint } from '../homography';
import {
  DEFAULT_TNUT_CORNERS,
  generateTnutGrid,
  isValidTnutCorners,
  isValidTnutGrid,
  MAX_TNUT_HOLES,
  readTnutLayout,
  tnutGridPath,
  type TnutCorners,
  type TnutGridOptions,
  type TnutLayout,
} from '../tnut-layout';

const square: TnutCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomLeft: { x: 0, y: 1 },
  bottomRight: { x: 1, y: 1 },
};
const grid: TnutGridOptions = {
  pattern: 'grid',
  rows: 8,
  columns: 8,
  corners: DEFAULT_TNUT_CORNERS,
  firstRowOffset: false,
};

describe('T-nut grid projection', () => {
  it('starts with 64 positions inset from the rectified wall corners in row order', () => {
    const holes = generateTnutGrid(grid);
    expect(holes).toHaveLength(64);
    for (const [index, corner] of [
      [0, 'topLeft'],
      [7, 'topRight'],
      [56, 'bottomLeft'],
      [63, 'bottomRight'],
    ] as const) {
      expect(holes[index].x).toBeCloseTo(DEFAULT_TNUT_CORNERS[corner].x, 10);
      expect(holes[index].y).toBeCloseTo(DEFAULT_TNUT_CORNERS[corner].y, 10);
    }
    expect(holes[1].x - holes[0].x).toBeCloseTo(0.8 / 7, 10);
    expect(holes[8].y - holes[0].y).toBeCloseTo(0.8 / 7, 10);
  });

  it('uses projective rather than bilinear interpolation for skewed calibration corners', () => {
    const corners: TnutCorners = {
      topLeft: { x: 0.25, y: 0.2 },
      topRight: { x: 0.75, y: 0.2 },
      bottomLeft: { x: 0, y: 0.8 },
      bottomRight: { x: 1, y: 0.8 },
    };
    const holes = generateTnutGrid({ ...grid, corners, rows: 3, columns: 3 });
    // The calibrated grid midpoint follows its quadrilateral's projective mapping.
    expect(holes[4].x).toBeCloseTo(0.5, 10);
    expect(holes[4].y).toBeCloseTo(0.4, 10);
    expect(holes[3].x).toBeCloseTo(1 / 6, 10);
    expect(holes[5].x).toBeCloseTo(5 / 6, 10);
  });

  it.each([false, true])('insets alternate rows by half a column when firstRowOffset=%s', (firstRowOffset) => {
    expect(generateTnutGrid({ ...grid, pattern: 'offset', firstRowOffset })).toHaveLength(60);
    const holes = generateTnutGrid({
      ...grid,
      pattern: 'offset',
      corners: square,
      rows: 3,
      columns: 3,
      firstRowOffset,
    });
    const rows = [0, 0.5, 1].map((y) => holes.filter((hole) => Math.abs(hole.y - y) < 1e-9).map((hole) => hole.x));
    expect(rows).toEqual(
      firstRowOffset
        ? [
            [0.25, 0.75],
            [0, 0.5, 1],
            [0.25, 0.75],
          ]
        : [
            [0, 0.5, 1],
            [0.25, 0.75],
            [0, 0.5, 1],
          ],
    );
  });

  it('recovers a known projective transform with perspective in both directions', () => {
    const matrix = [0.65, 0.1, 0.1, 0.05, 0.8, 0.1, 0.3, 0.2, 1];
    const project = (x: number, y: number) => {
      const [photoX, photoY] = mapPoint(matrix, x, y);
      return { x: photoX, y: photoY };
    };
    const corners = {
      topLeft: project(0, 0),
      topRight: project(1, 0),
      bottomLeft: project(0, 1),
      bottomRight: project(1, 1),
    };
    const holes = generateTnutGrid({ ...grid, corners, rows: 5, columns: 4 });
    holes.forEach((hole, index) => {
      const expected = project((index % 4) / 3, Math.floor(index / 4) / 4);
      expect(hole.x).toBeCloseTo(expected.x, 10);
      expect(hole.y).toBeCloseTo(expected.y, 10);
    });
  });

  it('supports a single hole in an inset two-column row and the maximum grid size', () => {
    const minimum = generateTnutGrid({
      ...grid,
      pattern: 'offset',
      corners: square,
      rows: 2,
      columns: 2,
      firstRowOffset: true,
    });
    expect(minimum).toEqual([
      { x: 0.5, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    expect(generateTnutGrid({ ...grid, rows: 50, columns: 50 })).toHaveLength(2500);
  });

  it.each([0, -1, 2.5, 51, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid counts %s', (count) => {
    expect(() => generateTnutGrid({ ...grid, rows: count })).toThrow(RangeError);
    expect(() => generateTnutGrid({ ...grid, columns: count })).toThrow(RangeError);
  });
});

describe('single-axis T-nut grids', () => {
  const corners: TnutCorners = {
    topLeft: { x: 0.1, y: 0.2 },
    topRight: { x: 0.9, y: 0.4 },
    bottomLeft: { x: 0.3, y: 0.8 },
    // Invalid as a 2D quadrilateral, but irrelevant to either single-axis grid.
    bottomRight: { x: 0.4, y: 0.3 },
  };

  it('places one row linearly between the two top points, keeping hidden corners intact', () => {
    const options = { ...grid, rows: 1, columns: 3, corners };
    const before = structuredClone(options);
    const holes = generateTnutGrid(options);
    expect(isValidTnutGrid(options)).toBe(true);
    expect(holes).toHaveLength(3);
    expect(holes[0]).toEqual(corners.topLeft);
    expect(holes[1].x).toBeCloseTo(0.5, 10);
    expect(holes[1].y).toBeCloseTo(0.3, 10);
    expect(holes[2].x).toBeCloseTo(corners.topRight.x, 10);
    expect(holes[2].y).toBeCloseTo(corners.topRight.y, 10);
    expect(options).toEqual(before);
  });

  it.each([false, true])('keeps every row in a single offset column with phase %s', (firstRowOffset) => {
    const options = { ...grid, pattern: 'offset' as const, rows: 3, columns: 1, corners, firstRowOffset };
    const holes = generateTnutGrid(options);
    expect(holes).toHaveLength(3);
    expect(holes[0]).toEqual(corners.topLeft);
    expect(holes[1].x).toBeCloseTo(0.2, 10);
    expect(holes[1].y).toBeCloseTo(0.5, 10);
    expect(holes[2].x).toBeCloseTo(corners.bottomLeft.x, 10);
    expect(holes[2].y).toBeCloseTo(corners.bottomLeft.y, 10);
  });

  it('insets a single offset row by half a column only when its phase is inset', () => {
    const options = { ...grid, pattern: 'offset' as const, rows: 1, columns: 3, corners };
    expect(generateTnutGrid({ ...options, firstRowOffset: false })).toHaveLength(3);
    const holes = generateTnutGrid({ ...options, firstRowOffset: true });
    expect(holes).toHaveLength(2);
    expect(holes[0].x).toBeCloseTo(0.3, 10);
    expect(holes[0].y).toBeCloseTo(0.25, 10);
    expect(holes[1].x).toBeCloseTo(0.7, 10);
    expect(holes[1].y).toBeCloseTo(0.35, 10);
  });

  it.each(['grid', 'offset'] as const)(
    'uses just top-left for a 1×1 %s even with coincident inactive corners',
    (pattern) => {
      const coincident = {
        topLeft: corners.topLeft,
        topRight: corners.topLeft,
        bottomLeft: corners.topLeft,
        bottomRight: corners.topLeft,
      };
      for (const firstRowOffset of [false, true]) {
        const options = { ...grid, pattern, rows: 1, columns: 1, corners: coincident, firstRowOffset };
        expect(isValidTnutGrid(options)).toBe(true);
        expect(generateTnutGrid(options)).toEqual([corners.topLeft]);
      }
    },
  );

  it.each([
    [1, 1, false, 1],
    [1, 1, true, 1],
    [1, 2, true, 1],
    [1, 50, false, 50],
    [1, 50, true, 49],
    [50, 1, false, 50],
    [50, 1, true, 50],
  ])('keeps SVG and generated positions identical at %i×%i, inset=%s', (rows, columns, firstRowOffset, count) => {
    const options = { ...grid, pattern: 'offset' as const, rows, columns, firstRowOffset, corners };
    const holes = generateTnutGrid(options);
    const path = tnutGridPath(options, 320, 600, 3);
    const centers = [...path.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)];
    expect(holes).toHaveLength(count);
    expect(centers).toHaveLength(count);
    centers.forEach((center, index) => {
      expect(Number(center[1]) + 3).toBeCloseTo(holes[index].x * 320, 1);
      expect(Number(center[2])).toBeCloseTo(holes[index].y * 600, 1);
    });
    expect(path).not.toMatch(/NaN|Infinity/);
  });

  it('rejects coincident active endpoints without imposing a 2D frame on single-axis layouts', () => {
    for (const options of [
      { ...grid, rows: 1, corners: { ...corners, topRight: corners.topLeft } },
      { ...grid, columns: 1, corners: { ...corners, bottomLeft: corners.topLeft } },
    ]) {
      expect(isValidTnutGrid(options)).toBe(false);
      expect(() => generateTnutGrid(options)).toThrow(RangeError);
      expect(tnutGridPath(options, 320, 600, 3)).toBe('');
    }
  });

  it('persists inactive corners unchanged and validates them again when restoring two dimensions', () => {
    for (const dimensions of [
      { rows: 1, columns: 8 },
      { rows: 8, columns: 1 },
      { rows: 1, columns: 1 },
    ]) {
      const layout = { ...saved, ...dimensions, corners };
      const parsed = readTnutLayout(layout);
      expect(parsed).toEqual(layout);
      expect(parsed?.corners).not.toBe(corners);
      const restored = { ...layout, pattern: 'grid' as const, rows: 8, columns: 8 };
      expect(isValidTnutGrid(restored)).toBe(false);
      expect(readTnutLayout(restored)).toBeNull();
      expect(() => generateTnutGrid(restored)).toThrow(RangeError);
    }
    const unchanged = { ...saved, rows: 1 };
    const parsed = readTnutLayout(unchanged);
    expect(parsed?.corners).toEqual(DEFAULT_TNUT_CORNERS);
    expect(generateTnutGrid({ ...unchanged, pattern: 'grid', rows: 8 })).toHaveLength(64);
  });

  it.each([
    undefined,
    { x: -0.1, y: 0.2 },
    { x: 1.1, y: 0.2 },
    { x: Number.NaN, y: 0.2 },
    { x: 0.1, y: Number.POSITIVE_INFINITY },
  ])('still rejects malformed or out-of-bounds inactive corner %j', (bottomRight) => {
    const options = { ...grid, rows: 1, columns: 1, corners: { ...corners, bottomRight } };
    expect(isValidTnutGrid(options)).toBe(false);
    expect(readTnutLayout({ ...saved, ...options })).toBeNull();
  });
});

describe('T-nut calibration validation', () => {
  it.each([
    null,
    {},
    { ...square, topLeft: { x: -0.1, y: 0 } },
    { ...square, topLeft: { x: Number.NaN, y: 0 } },
    { ...square, bottomRight: { x: 1, y: 1.1 } },
    { ...square, topLeft: square.topRight },
    { ...square, bottomLeft: square.bottomRight, bottomRight: square.bottomLeft },
    {
      ...square,
      topLeft: square.topRight,
      topRight: square.topLeft,
      bottomLeft: square.bottomRight,
      bottomRight: square.bottomLeft,
    },
    { ...square, bottomRight: { x: 0.1, y: 0.1 } },
    { ...square, bottomRight: { x: 0.5, y: 0.5 } },
    { ...square, topRight: { x: 0.0000001, y: 0 } },
  ])('rejects an unusable frame: %j', (corners) => {
    expect(isValidTnutCorners(corners)).toBe(false);
    expect(() => generateTnutGrid({ ...grid, corners: corners as TnutCorners })).toThrow(RangeError);
  });

  it('accepts an off-axis convex frame without changing its corners', () => {
    const corners: TnutCorners = {
      topLeft: { x: 0.2, y: 0.1 },
      topRight: { x: 0.85, y: 0.2 },
      bottomLeft: { x: 0.1, y: 0.7 },
      bottomRight: { x: 0.9, y: 0.95 },
    };
    expect(isValidTnutCorners(corners)).toBe(true);
    const before = structuredClone(corners);
    const holes = generateTnutGrid({ ...grid, corners });
    expect(corners).toEqual(before);
    expect(holes.every(({ x, y }) => x >= 0 && x <= 1 && y >= 0 && y <= 1)).toBe(true);
  });
});

const saved: TnutLayout = {
  version: 1,
  ...grid,
  holes: [
    { x: 0.2, y: 0.3 },
    { x: 0.7, y: 0.8 },
  ],
  photoKey: 'photo-version-123',
};

describe('persisted T-nut layout', () => {
  it.each(['center', 'sides', 'below'] as const)(
    'round-trips optional LED placement %s without changing hole positions',
    (ledPlacement) => {
      const configured = { ...saved, ledPlacement };
      expect(readTnutLayout(JSON.parse(JSON.stringify(configured)))).toEqual(configured);
    },
  );

  it('keeps legacy layouts unselected', () => {
    expect(readTnutLayout(saved)).not.toHaveProperty('ledPlacement');
  });

  it.each([false, true])('round-trips complementary positions for either offset phase (%s)', (firstRowOffset) => {
    const configured = { ...saved, pattern: 'offset', firstRowOffset, ledPlacement: 'alternating' };
    expect(readTnutLayout(JSON.parse(JSON.stringify(configured)))).toEqual(configured);
  });

  it.each(['grid', 'custom'])('rejects complementary positions for %s', (pattern) => {
    expect(readTnutLayout({ ...saved, pattern, ledPlacement: 'alternating' })).toBeNull();
  });

  it.each([null, 'unknown', 'alternate', 1, {}])('rejects unsupported LED placement %j', (ledPlacement) => {
    expect(readTnutLayout({ ...saved, ledPlacement })).toBeNull();
  });

  it.each(['grid', 'offset', 'custom'] as const)('preserves manually edited holes for %s', (pattern) => {
    const parsed = readTnutLayout({ ...saved, pattern, ignoredFutureField: true });
    expect(parsed).toEqual({ ...saved, pattern });
    expect(parsed?.holes).not.toBe(saved.holes);
    expect(parsed?.corners.topLeft).not.toBe(saved.corners.topLeft);
  });

  it('allows an empty draft and the bounded number of manual positions', () => {
    expect(readTnutLayout({ ...saved, pattern: 'custom', holes: [] })?.holes).toEqual([]);
    expect(
      readTnutLayout({ ...saved, holes: Array.from({ length: MAX_TNUT_HOLES }, () => ({ x: 0.1, y: 0.2 })) })?.holes,
    ).toHaveLength(MAX_TNUT_HOLES);
  });

  it.each([
    null,
    { ...saved, version: 2 },
    { ...saved, pattern: 'unknown' },
    { ...saved, rows: '8' },
    { ...saved, columns: 100 },
    { ...saved, firstRowOffset: 'false' },
    { ...saved, corners: {} },
    { ...saved, holes: 'not an array' },
    { ...saved, holes: [{ x: 1, y: Number.POSITIVE_INFINITY }] },
    { ...saved, holes: [{ x: -0.1, y: 0.1 }] },
    { ...saved, holes: Array.from({ length: MAX_TNUT_HOLES + 1 }, () => ({ x: 0, y: 0 })) },
    { ...saved, photoKey: ' ' },
    { ...saved, photoKey: 'x'.repeat(4097) },
  ])('refuses malformed or unknown saved layouts', (candidate) => {
    expect(readTnutLayout(candidate)).toBeNull();
  });
});

describe('live T-nut overlay path', () => {
  it('draws the same projected holes at rendered wall-frame scale', () => {
    const options = {
      ...grid,
      pattern: 'offset' as const,
      firstRowOffset: true,
      corners: {
        topLeft: { x: 0.2, y: 0.1 },
        topRight: { x: 0.85, y: 0.2 },
        bottomLeft: { x: 0.1, y: 0.7 },
        bottomRight: { x: 0.9, y: 0.95 },
      },
    };
    const holes = generateTnutGrid(options);
    const path = tnutGridPath(options, 320, 600, 3);
    const centers = [...path.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)];
    expect(centers).toHaveLength(holes.length);
    centers.forEach((center, index) => {
      expect(Number(center[1]) + 3).toBeCloseTo(holes[index].x * 320, 1);
      expect(Number(center[2])).toBeCloseTo(holes[index].y * 600, 1);
    });
    expect(path).not.toMatch(/NaN|Infinity/);
  });

  it('hides an invalid frame while dragging and restores it after the crossing is corrected', () => {
    expect(tnutGridPath({ ...grid, corners: { ...square, topLeft: square.bottomRight } }, 320, 600, 3)).toBe('');
    expect(tnutGridPath(grid, 320, 600, 3)).not.toBe('');
  });

  it.each([
    [0, 600, 3],
    [320, -1, 3],
    [320, 600, 0],
    [Number.NaN, 600, 3],
  ])('refuses an invalid render size or radius', (width, height, radius) => {
    expect(tnutGridPath(grid, width, height, radius)).toBe('');
  });
});
