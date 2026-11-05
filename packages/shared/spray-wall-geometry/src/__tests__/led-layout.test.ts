import { describe, expect, it } from 'vitest';
import {
  assignLedIndices,
  connectWiring,
  createWiring,
  cutWiring,
  generateLedPositions,
  readLedPositions,
  readTnutWiring,
  setWiringSkip,
  traceLedPath,
  type CableDirection,
  type CableStartCorner,
  type LedPosition,
  type TnutWiring,
} from '../led-layout';
import {
  generateTnutGrid,
  migrateTnutLayoutColumns,
  readTnutLayout,
  tnutGridPath,
  type TnutLayout,
} from '../tnut-layout';
import { homographyFromAnchors, mapPoint } from '../homography';

function layout(overrides: Partial<TnutLayout> = {}): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: 3,
    columns: 3,
    firstRowOffset: false,
    corners: {
      topLeft: { x: 0.2, y: 0.2 },
      topRight: { x: 0.8, y: 0.2 },
      bottomLeft: { x: 0.2, y: 0.8 },
      bottomRight: { x: 0.8, y: 0.8 },
    },
    holes: [],
    photoKey: 'version-1:rectified-frame',
    ledPlacement: 'center',
    ...overrides,
  };
  if (!overrides.holes)
    configured.holes = generateTnutGrid({
      ...configured,
      pattern: configured.pattern === 'offset' ? 'offset' : 'grid',
    });
  return configured;
}

const leds: LedPosition[] = [
  { id: 'a', x: 0.1, y: 0.2 },
  { id: 'b', x: 0.5, y: 0.2 },
  { id: 'c', x: 0.9, y: 0.2 },
  { id: 'd', x: 0.1, y: 0.8 },
  { id: 'e', x: 0.5, y: 0.8 },
  { id: 'f', x: 0.9, y: 0.8 },
];

describe('LED positions in the calibrated wall frame', () => {
  it('uses the edited hole list for center and behind-hold placements', () => {
    const configured = layout({
      holes: [
        { x: 0.5, y: 0.5 },
        { x: 0.6, y: 0.65 },
      ],
    });
    expect(generateLedPositions(configured).map(({ x, y }) => ({ x, y }))).toEqual(configured.holes);
    const behind = generateLedPositions({ ...configured, ledPlacement: 'sides' });
    expect(behind).toHaveLength(4);
    expect(behind[0].x).toBeCloseTo(0.425);
    expect(behind[1].x).toBeCloseTo(0.575);
    expect(behind[0].y).toBeCloseTo(0.5);
    expect(new Set(behind.map(({ id }) => id)).size).toBe(4);
    expect(configured.holes[0]).toEqual({ x: 0.5, y: 0.5 });
  });

  it('offsets below in the perspective grid plane rather than the screen vertical axis', () => {
    const corners = {
      topLeft: { x: 0.2, y: 0.15 },
      topRight: { x: 0.75, y: 0.25 },
      bottomLeft: { x: 0.1, y: 0.75 },
      bottomRight: { x: 0.85, y: 0.9 },
    };
    const configured = layout({ corners, ledPlacement: 'below' });
    configured.holes = [configured.holes[4]];
    const [point] = generateLedPositions(configured);
    const transform = homographyFromAnchors(
      [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft].map(({ x, y }) => [x, y]),
      { width: 1, height: 1 },
    );
    const [column, row] = mapPoint(transform, point.x, point.y);
    expect(column).toBeCloseTo(0.5, 8);
    expect(row).toBeCloseTo(0.75, 8);
  });

  it('derives complementary positions from the opposite offset phase', () => {
    const configured = layout({ pattern: 'offset', columnConvention: 'all', columns: 5, ledPlacement: 'alternating' });
    const points = generateLedPositions(configured);
    const opposite = generateTnutGrid({ ...configured, pattern: 'offset', firstRowOffset: true });
    expect(points.map(({ x, y }) => ({ x, y }))).toEqual(opposite);
    const holes = new Set(configured.holes.map(({ x, y }) => `${x}:${y}`));
    expect(points.every(({ x, y }) => !holes.has(`${x}:${y}`))).toBe(true);
  });

  it('never emits duplicate or out-of-wall positions', () => {
    const configured = layout({
      holes: [
        { x: 0.01, y: 0.5 },
        { x: 0.01, y: 0.5 },
      ],
      ledPlacement: 'sides',
    });
    const points = generateLedPositions(configured);
    expect(points).toHaveLength(1);
    expect(points[0].x).toBeGreaterThanOrEqual(0);
    expect(readLedPositions(points)).toEqual(points);
  });

  it('uses measured custom-hole spacing instead of unused grid dimensions', () => {
    const configured = layout({
      pattern: 'custom',
      holes: [
        { x: 0.3, y: 0.4 },
        { x: 0.5, y: 0.4 },
      ],
      ledPlacement: 'below',
    });
    const points = generateLedPositions(configured);
    expect(points.map(({ x }) => x)).toEqual([0.3, 0.5]);
    expect(points[0].y).toBeCloseTo(0.5);
    expect(generateLedPositions({ ...configured, rows: 50, columns: 50 })).toEqual(points);
  });

  it('preserves generated LED identities when unrelated holes are removed or reordered', () => {
    const configured = layout();
    const original = generateLedPositions(configured);
    const retained = generateLedPositions({ ...configured, holes: configured.holes.slice(1).reverse() });
    expect(retained.map(({ id }) => id)).toEqual(
      original
        .slice(1)
        .reverse()
        .map(({ id }) => id),
    );
  });
});

describe('column-count migration', () => {
  it.each([1, 2, 8, 50])('preserves legacy %i-column offset positions for both phases', (columns) => {
    for (const firstRowOffset of [false, true]) {
      const old = layout({ pattern: 'offset', columns, firstRowOffset });
      const before = structuredClone(old);
      const migrated = migrateTnutLayoutColumns(old);
      expect(migrated.columns).toBe(columns * 2 - 1);
      expect(migrated.holes).toEqual(old.holes);
      expect(generateTnutGrid({ ...migrated, pattern: 'offset' })).toEqual(
        generateTnutGrid({ ...old, pattern: 'offset' }),
      );
      expect(readTnutLayout(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
      expect(migrateTnutLayoutColumns(migrated)).toBe(migrated);
      expect(old).toEqual(before);
    }
  });

  it.each([4, 5])('counts all %i vertical positions while keeping the overlay aligned', (columns) => {
    for (const firstRowOffset of [false, true]) {
      const configured = layout({ pattern: 'offset', columnConvention: 'all', rows: 2, columns, firstRowOffset });
      const points = generateTnutGrid({ ...configured, pattern: 'offset' });
      expect(points).toHaveLength(columns);
      expect(new Set(points.map(({ x }) => x.toFixed(8))).size).toBe(columns);
      const path = tnutGridPath({ ...configured, pattern: 'offset' }, 300, 600, 2);
      const markers = [...path.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)];
      expect(markers).toHaveLength(points.length);
      markers.forEach((marker, index) => {
        expect(Number(marker[1]) + 2).toBeCloseTo(points[index].x * 300, 1);
        expect(Number(marker[2])).toBeCloseTo(points[index].y * 600, 1);
      });
    }
  });

  it('allows migrated 99-column offset grids without expanding square-grid limits', () => {
    expect(() => layout({ pattern: 'offset', columnConvention: 'all', columns: 99, rows: 50 })).not.toThrow();
    expect(() => layout({ pattern: 'grid', columnConvention: 'all', columns: 99, rows: 50 })).toThrow();
  });
});

describe('cable order and edits', () => {
  it.each([
    ['horizontal', 'tl', ['a', 'b', 'c', 'f', 'e', 'd']],
    ['horizontal', 'tr', ['c', 'b', 'a', 'd', 'e', 'f']],
    ['horizontal', 'bl', ['d', 'e', 'f', 'c', 'b', 'a']],
    ['horizontal', 'br', ['f', 'e', 'd', 'a', 'b', 'c']],
    ['vertical', 'tl', ['a', 'd', 'e', 'b', 'c', 'f']],
    ['vertical', 'tr', ['c', 'f', 'e', 'b', 'a', 'd']],
    ['vertical', 'bl', ['d', 'a', 'b', 'e', 'f', 'c']],
    ['vertical', 'br', ['f', 'c', 'b', 'e', 'd', 'a']],
  ] as [CableDirection, CableStartCorner, string[]][])(
    'starts a %s cable at %s and snakes through each LED once',
    (direction, corner, expected) => {
      expect(createWiring(leds, direction, corner).paths).toEqual([expected]);
    },
  );

  it('starts custom wiring empty and joins endpoints without creating branches or cycles', () => {
    const initial = createWiring(leds, 'custom', 'tl');
    expect(initial.paths).toEqual([]);
    const first = connectWiring(connectWiring(initial, 'a', 'b'), 'b', 'c');
    expect(first.paths).toEqual([['a', 'b', 'c']]);
    expect(connectWiring(first, 'b', 'd')).toBe(first);
    expect(connectWiring(first, 'c', 'a')).toBe(first);
    expect(initial.paths).toEqual([]);
  });

  it('retains physical skips when reversing a run and removes only a cut edge gap', () => {
    const initial: TnutWiring = {
      direction: 'custom',
      startCorner: 'tl',
      paths: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      skips: [],
    };
    const withGap = setWiringSkip(initial, 'a', 'b', 2);
    const joined = connectWiring(withGap, 'a', 'c');
    expect(joined.paths).toEqual([['b', 'a', 'c', 'd']]);
    expect(assignLedIndices(joined)).toEqual([
      { id: 'b', index: 0 },
      { id: 'a', index: 3 },
      { id: 'c', index: 4 },
      { id: 'd', index: 5 },
    ]);
    const withSecondGap = setWiringSkip(joined, 'a', 'c', 3);
    const cut = cutWiring(withSecondGap, 'c', 'a');
    expect(cut.paths).toEqual([
      ['b', 'a'],
      ['c', 'd'],
    ]);
    expect(cut.skips).toEqual(withGap.skips);
    expect(setWiringSkip(cut, 'a', 'b', 0).skips).toEqual([]);
    expect(setWiringSkip(cut, 'a', 'c', 1)).toBe(cut);
    expect(initial.skips).toEqual([]);
  });

  it('hits LEDs in stroke order only once, even when a stroke doubles back', () => {
    expect(
      traceLedPath(
        leds,
        [
          { x: 0.95, y: 0.2 },
          { x: 0.05, y: 0.2 },
          { x: 0.95, y: 0.2 },
        ],
        0.06,
      ),
    ).toEqual(['c', 'b', 'a']);
  });

  it('refuses a gap edit that would exceed the persisted total instead of producing an unsavable draft', () => {
    const manyLeds = Array.from({ length: 102 }, (_, index) => ({ id: `point-${index}`, x: index / 101, y: 0.5 }));
    let wiring = createWiring(manyLeds, 'horizontal', 'tl');
    for (let index = 0; index < 100; index++)
      wiring = setWiringSkip(wiring, `point-${index}`, `point-${index + 1}`, 10000);
    expect(readTnutWiring(wiring, manyLeds)).not.toBeNull();
    expect(setWiringSkip(wiring, 'point-100', 'point-101', 1)).toBe(wiring);
  });

  it('keeps skip identities distinct when LED names contain delimiter characters', () => {
    const unusualLeds = ['a', 'b\u0000c', 'a\u0000b', 'c'].map((id, index) => ({ id, x: index / 3, y: 0.5 }));
    const wiring: TnutWiring = {
      direction: 'custom',
      startCorner: 'tl',
      paths: [
        ['a', 'b\u0000c'],
        ['a\u0000b', 'c'],
      ],
      skips: [],
    };
    const first = setWiringSkip(wiring, 'a', 'b\u0000c', 2);
    const second = setWiringSkip(first, 'a\u0000b', 'c', 3);
    expect(second.skips).toHaveLength(2);
    expect(readTnutWiring(second, unusualLeds)).toEqual(second);
    expect(assignLedIndices(second).map(({ index }) => index)).toEqual([0, 3, 4, 8]);
  });
});

describe('persisted LED setup validation', () => {
  it('round-trips LEDs, wiring and detached skip counts without losing hole edits', () => {
    const configured = layout({
      ledPositions: leds,
      wiring: setWiringSkip(createWiring(leds, 'horizontal', 'tl'), 'a', 'b', 4),
    });
    const parsed = readTnutLayout(JSON.parse(JSON.stringify(configured)));
    expect(parsed).toEqual(configured);
    expect(parsed?.ledPositions).not.toBe(configured.ledPositions);
    expect(parsed?.wiring?.paths).not.toBe(configured.wiring?.paths);
  });

  it.each([
    {
      paths: [
        ['a', 'b'],
        ['b', 'c'],
      ],
    },
    { paths: [['a', 'unknown']] },
    { skips: [{ from: 'a', to: 'f', count: 1 }] },
    { skips: [{ from: 'a', to: 'b', count: -1 }] },
    { skips: [{ from: 'a', to: 'b', count: 0.5 }] },
    { direction: ['horizontal'] },
    { startCorner: ['tl'] },
  ])('rejects malformed wiring %j', (invalid) => {
    expect(readTnutWiring({ ...createWiring(leds, 'horizontal', 'tl'), ...invalid }, leds)).toBeNull();
  });

  it('rejects duplicate LED identities and non-finite positions', () => {
    expect(readLedPositions([leds[0], leds[0]])).toBeNull();
    expect(readLedPositions([{ ...leds[0], x: Number.NaN }])).toBeNull();
    expect(readLedPositions([{ ...leds[0], y: 1.01 }])).toBeNull();
  });
});
