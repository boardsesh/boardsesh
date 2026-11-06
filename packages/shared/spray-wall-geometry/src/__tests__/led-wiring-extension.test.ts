import { describe, expect, it } from 'vite-plus/test';
import {
  assignLedIndices,
  createWiring,
  cutWiring,
  extendWiring,
  generateLedPositions,
  MAX_LED_POSITIONS,
  MAX_WIRING_SKIP,
  MAX_WIRING_TOTAL_SKIPS,
  readTnutWiring,
  rowMajorLedIndices,
  setWiringInitialSkip,
  setWiringSkip,
  type LedPosition,
  type TnutWiring,
} from '../led-layout';
import { DEFAULT_TNUT_CORNERS, generateTnutGrid, readTnutLayout, type TnutLayout } from '../tnut-layout';

const leds: LedPosition[] = [
  { id: 'a', x: 0.2, y: 0.2 },
  { id: 'b', x: 0.8, y: 0.2 },
  { id: 'c', x: 0.2, y: 0.8 },
  { id: 'd', x: 0.8, y: 0.8 },
];
const empty: TnutWiring = { direction: 'custom', startCorner: 'tl', paths: [], skips: [] };
const layout: TnutLayout = {
  version: 1,
  photoKey: 'wall-1',
  pattern: 'grid',
  rows: 2,
  columns: 2,
  corners: DEFAULT_TNUT_CORNERS,
  firstRowOffset: false,
  holes: [],
  ledPlacement: 'center',
};

describe('unused LEDs before the cable start', () => {
  it('keeps legacy zero-based indexing and includes the initial skip plus edge gaps', () => {
    const wiring = createWiring(leds, 'horizontal', 'tl');
    expect(readTnutWiring(wiring, leds)).toEqual(wiring);
    expect(assignLedIndices(wiring).map(({ index }) => index)).toEqual([0, 1, 2, 3]);
    const skipped = setWiringSkip(setWiringInitialSkip(wiring, 3), 'a', 'b', 2);
    expect(assignLedIndices(skipped).map(({ index }) => index)).toEqual([3, 6, 7, 8]);
    expect(assignLedIndices(cutWiring(skipped, 'b', 'd')).map(({ index }) => index)).toEqual([3, 6, 7, 8]);
    expect(readTnutLayout({ ...layout, ledPositions: leds, wiring: skipped })?.wiring).toEqual(skipped);
    expect(setWiringInitialSkip(skipped, 0).initialSkip).toBe(0);
    expect(wiring.initialSkip).toBeUndefined();
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_WIRING_SKIP + 1, '2', null])(
    'rejects invalid initial skip %s',
    (initialSkip) => {
      expect(readTnutWiring({ ...empty, initialSkip }, [])).toBeNull();
      if (typeof initialSkip === 'number') expect(setWiringInitialSkip(empty, initialSkip)).toBe(empty);
    },
  );

  it('uses the same aggregate cap for persisted, initial and between-LED gaps', () => {
    const manyLeds = Array.from({ length: 101 }, (_, index) => ({ id: String(index), x: index / 100, y: 0.5 }));
    const full: TnutWiring = {
      ...empty,
      paths: [manyLeds.map(({ id }) => id)],
      skips: manyLeds.slice(1).map(({ id }, index) => ({ from: String(index), to: id, count: MAX_WIRING_SKIP })),
    };
    expect(full.skips.reduce((total, skip) => total + skip.count, 0)).toBe(MAX_WIRING_TOTAL_SKIPS);
    expect(readTnutWiring(full, manyLeds)).toEqual(full);
    expect(setWiringInitialSkip(full, 1)).toBe(full);
    expect(readTnutWiring({ ...full, initialSkip: 1 }, manyLeds)).toBeNull();
    const freed = setWiringSkip(full, '0', '1', MAX_WIRING_SKIP - 1);
    const balanced = setWiringInitialSkip(freed, 1);
    expect(readTnutWiring(balanced, manyLeds)).toEqual(balanced);
    expect(setWiringSkip(balanced, '0', '1', MAX_WIRING_SKIP)).toBe(balanced);
  });
});

describe('drawing extends only the current cable tail', () => {
  it('starts once and appends only new LEDs regardless of the stroke starting point', () => {
    const started = extendWiring(empty, ['a', 'b', 'a']);
    expect(started.paths).toEqual([['a', 'b']]);
    const extended = extendWiring(started, ['d', 'a', 'c', 'd']);
    expect(extended.paths).toEqual([['a', 'b', 'd', 'c']]);
    expect(extendWiring(extended, ['b', 'a', 'c'])).toBe(extended);
    expect(empty.paths).toEqual([]);
    expect(started.paths).toEqual([['a', 'b']]);
  });

  it('preserves cut sections, their direction and skips while extending only the last', () => {
    const wiring: TnutWiring = {
      ...empty,
      paths: [['b', 'a'], ['c']],
      initialSkip: 2,
      skips: [{ from: 'a', to: 'b', count: 3 }],
    };
    const extended = extendWiring(wiring, ['b', 'd', 'a']);
    expect(extended.paths).toEqual([
      ['b', 'a'],
      ['c', 'd'],
    ]);
    expect(extended.skips).toEqual(wiring.skips);
    expect(extended.initialSkip).toBe(2);
    expect(assignLedIndices(extended).map(({ index }) => index)).toEqual([2, 6, 7, 8]);
    expect(readTnutWiring(extended, leds)).toEqual(extended);
  });

  it('batches a long repeated trace up to the supported LED limit', () => {
    const ids = Array.from({ length: MAX_LED_POSITIONS + 1 }, (_, index) => `led-${index}`);
    const wiring = extendWiring(empty, ['', ...ids, ...ids]);
    expect(wiring.paths).toHaveLength(1);
    expect(wiring.paths[0]).toEqual(ids.slice(0, MAX_LED_POSITIONS));
    expect(extendWiring(wiring, ['another'])).toBe(wiring);
  });
});

describe('row-major physical LED preview', () => {
  it('shows every row left to right regardless of cable direction, skipping unwired positions', () => {
    const wiring: TnutWiring = {
      ...empty,
      paths: [['d', 'b'], ['a']],
      initialSkip: 4,
      skips: [{ from: 'd', to: 'b', count: 2 }],
    };
    expect(rowMajorLedIndices([...leds].reverse(), wiring)).toEqual([8, 7, 4]);
    expect(rowMajorLedIndices(leds, empty)).toEqual([]);
  });

  it('groups slanted perspective rows in their calibrated plane', () => {
    const skewed: TnutLayout = {
      ...layout,
      rows: 3,
      columns: 3,
      corners: {
        topLeft: { x: 0.3, y: 0.05 },
        topRight: { x: 0.8, y: 0.4 },
        bottomLeft: { x: 0.1, y: 0.6 },
        bottomRight: { x: 0.7, y: 0.95 },
      },
    };
    const points = generateTnutGrid({ ...skewed, pattern: 'grid' }).map((point, index) => ({
      ...point,
      id: String(index),
    }));
    const wiring = setWiringInitialSkip(createWiring(points, 'vertical', 'br', skewed), 2);
    const assigned = new Map(assignLedIndices(wiring).map(({ id, index }) => [id, index]));
    expect(rowMajorLedIndices([...points].reverse(), wiring, skewed)).toEqual(points.map(({ id }) => assigned.get(id)));
  });
});

describe('close behind-hold LED pairs', () => {
  it('places custom pairs one tenth of measured hole spacing on either side', () => {
    const custom: TnutLayout = {
      ...layout,
      pattern: 'custom',
      ledPlacement: 'sides',
      holes: [
        { x: 0.3, y: 0.5 },
        { x: 0.7, y: 0.5 },
      ],
    };
    const points = generateLedPositions(custom);
    expect(points).toHaveLength(4);
    [0.26, 0.34, 0.66, 0.74].forEach((expected, index) => expect(points[index].x).toBeCloseTo(expected));
    expect(points.every(({ y }) => y === 0.5)).toBe(true);
  });
});
