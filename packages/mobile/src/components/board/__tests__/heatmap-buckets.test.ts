import { describe, expect, it } from 'vitest';
import type { HoldStat } from '@boardsesh/shared-schema';
import { difficultyIdToVNumber } from '@boardsesh/board-constants/grade-conversion';
import { V_GRADE_COLORS } from '@boardsesh/board-constants/grade-colors';
import {
  buildHeatLayer,
  gradeSwatches,
  GRADE_CODE_BASE,
  HEAT_BUCKET_CODES,
  heatBucketIndex,
  heatLayerFrames,
  heatMetricCount,
  midRankPercentiles,
  shrunkDifficulty,
  type HeatCell,
} from '../heatmap-buckets';

const RAMP = ['#000001', '#000002', '#000003', '#000004', '#000005'];

function holdStat(holdId: number, overrides: Partial<HoldStat> = {}): HoldStat {
  return {
    holdId,
    totalUses: 1,
    startingUses: 0,
    handUses: 1,
    footUses: 0,
    finishUses: 0,
    totalAscents: 0,
    averageDifficulty: null,
    ...overrides,
  };
}

function statsMap(stats: HoldStat[]): Map<number, HoldStat> {
  return new Map(stats.map((entry) => [entry.holdId, entry]));
}

describe('midRankPercentiles', () => {
  it('gives distinct values evenly spaced mid-ranks', () => {
    expect(midRankPercentiles([30, 10, 20, 40])).toEqual([0.625, 0.125, 0.375, 0.875]);
  });

  it('gives tied values one shared percentile', () => {
    const percentiles = midRankPercentiles([5, 5, 5, 9]);
    expect(percentiles[0]).toBe(percentiles[1]);
    expect(percentiles[1]).toBe(percentiles[2]);
    expect(percentiles[0]).toBeCloseTo(0.375);
    expect(percentiles[3]).toBeCloseTo(0.875);
  });

  it('returns nothing for nothing', () => {
    expect(midRankPercentiles([])).toEqual([]);
  });
});

describe('heatBucketIndex', () => {
  it('draws nothing below 0.2 and uses the five edges', () => {
    expect(heatBucketIndex(0.19)).toBeNull();
    expect(heatBucketIndex(0.2)).toBe(0);
    expect(heatBucketIndex(0.39)).toBe(0);
    expect(heatBucketIndex(0.4)).toBe(1);
    expect(heatBucketIndex(0.6)).toBe(2);
    expect(heatBucketIndex(0.8)).toBe(3);
    expect(heatBucketIndex(0.949)).toBe(3);
    expect(heatBucketIndex(0.95)).toBe(4);
    expect(heatBucketIndex(Number.NaN)).toBeNull();
  });
});

describe('heatMetricCount', () => {
  const stat = holdStat(1, { totalUses: 20, startingUses: 3, handUses: 8, footUses: 5, finishUses: 4 });

  it('maps each metric to its roles', () => {
    expect(heatMetricCount(stat, 'climbs')).toBe(20);
    expect(heatMetricCount(stat, 'startsFinishes')).toBe(7);
    expect(heatMetricCount(stat, 'starts')).toBe(3);
    expect(heatMetricCount(stat, 'hands')).toBe(15);
    expect(heatMetricCount(stat, 'feet')).toBe(5);
    expect(heatMetricCount(stat, 'finishes')).toBe(4);
  });
});

describe('buildHeatLayer (counts)', () => {
  // 100 holds with uses 1², 2², … 100²: no ties, a heavy tail like a real board.
  const holdIds = Array.from({ length: 100 }, (_, index) => index + 1);
  const stats = statsMap(holdIds.map((holdId) => holdStat(holdId, { totalUses: holdId ** 2 })));

  it('puts about n/5 holds in each of the first four buckets and the top 5% in the last', () => {
    const layer = buildHeatLayer({ statsByHoldId: stats, holdIds, metric: 'climbs', ramp: RAMP });
    const perBucket = [0, 0, 0, 0, 0];
    for (const cell of layer.cells) perBucket[cell.bucket]++;
    expect(perBucket).toEqual([20, 20, 20, 15, 5]);
    // The coldest fifth is not drawn at all.
    expect(layer.cells).toHaveLength(80);
  });

  it('maps buckets to the 900–904 codes and the ramp', () => {
    const layer = buildHeatLayer({ statsByHoldId: stats, holdIds, metric: 'climbs', ramp: RAMP });
    for (const cell of layer.cells) {
      expect(cell.code).toBe(HEAT_BUCKET_CODES[cell.bucket]);
      expect(cell.color).toBe(RAMP[cell.bucket]);
      expect(layer.codeColors[cell.code]).toEqual({ color: RAMP[cell.bucket] });
    }
  });

  it('reports non-decreasing real values at the bucket edges', () => {
    const layer = buildHeatLayer({ statsByHoldId: stats, holdIds, metric: 'climbs', ramp: RAMP });
    if (layer.legend.kind !== 'count') throw new Error('expected a count legend');
    const edges = layer.legend.edgeValues;
    expect(edges.every((value) => value !== null)).toBe(true);
    for (let index = 1; index < edges.length; index++) {
      expect(edges[index] ?? 0).toBeGreaterThanOrEqual(edges[index - 1] ?? 0);
    }
    // The bottom of the first bucket is the 21st hold (percentile 0.205).
    expect(edges[0]).toBe(21 ** 2);
    expect(layer.legend.total).toBe(100 ** 2);
  });

  it('ranks painted holds but does not draw them', () => {
    const painted = new Set([100, 99]);
    const layer = buildHeatLayer({ statsByHoldId: stats, holdIds, metric: 'climbs', ramp: RAMP, skipHoldIds: painted });
    const unpainted = buildHeatLayer({ statsByHoldId: stats, holdIds, metric: 'climbs', ramp: RAMP });
    expect(layer.cells.some((cell) => painted.has(cell.holdId))).toBe(false);
    // Neighbours keep their colour: the ranking did not move.
    const codeOf = (cells: HeatCell[], holdId: number) => cells.find((cell) => cell.holdId === holdId)?.code;
    expect(codeOf(layer.cells, 98)).toBe(codeOf(unpainted.cells, 98));
    expect(layer.legend).toEqual(unpainted.legend);
  });

  it('always gives the busiest hold the hottest colour, even on a tight filter', () => {
    // Four used holds: the top mid-rank is 0.875, below the last edge.
    const small = statsMap([1, 2, 3, 4].map((holdId) => holdStat(holdId, { totalUses: holdId })));
    const layer = buildHeatLayer({ statsByHoldId: small, holdIds: [1, 2, 3, 4], metric: 'climbs', ramp: RAMP });
    expect(layer.cells.find((cell) => cell.holdId === 4)?.bucket).toBe(4);
  });

  it('paints every hold the middle colour when all counts tie, and flags it for the legend', () => {
    const tied = statsMap([1, 2, 3].map((holdId) => holdStat(holdId, { totalUses: 7 })));
    const layer = buildHeatLayer({ statsByHoldId: tied, holdIds: [1, 2, 3], metric: 'climbs', ramp: RAMP });
    expect(layer.cells.map((cell) => cell.bucket)).toEqual([2, 2, 2]);
    expect(layer.cells.every((cell) => cell.color === RAMP[2])).toBe(true);
    expect(layer.legend).toMatchObject({ kind: 'count', allEqual: true, total: 7 });
  });

  it('ignores stats for holds the board cannot draw, and holds with a zero count', () => {
    const layer = buildHeatLayer({
      statsByHoldId: statsMap([holdStat(1, { totalUses: 5, footUses: 0 }), holdStat(999, { footUses: 9 })]),
      holdIds: [1, 2],
      metric: 'feet',
      ramp: RAMP,
    });
    expect(layer.cells).toEqual([]);
  });
});

describe('buildHeatLayer (grade)', () => {
  it('shrinks toward the board mean, hides n < 5 and colours with the grade colours', () => {
    const stats = statsMap([
      holdStat(1, { totalUses: 200, averageDifficulty: 18 }),
      holdStat(2, { totalUses: 200, averageDifficulty: 22 }),
      holdStat(3, { totalUses: 4, averageDifficulty: 30 }),
    ]);
    const layer = buildHeatLayer({ statsByHoldId: stats, holdIds: [1, 2, 3], metric: 'grade', ramp: RAMP });
    expect(layer.cells.map((cell) => cell.holdId)).toEqual([1, 2]);
    for (const cell of layer.cells) {
      const vNumber = cell.code - GRADE_CODE_BASE;
      expect(cell.color).toBe(V_GRADE_COLORS[`V${vNumber}`]);
    }
    expect(layer.legend.kind).toBe('grade');
  });

  it('pulls a hold three climbs use to within one grade of the mean', () => {
    const boardMean = 18;
    const shrunk = shrunkDifficulty(30, 3, boardMean);
    const meanV = difficultyIdToVNumber(boardMean) ?? 0;
    const shrunkV = difficultyIdToVNumber(shrunk) ?? 99;
    expect(Math.abs(shrunkV - meanV)).toBeLessThanOrEqual(1);
    // ...while a well-used hold keeps most of its own average.
    expect(shrunkDifficulty(30, 400, boardMean)).toBeGreaterThan(29);
  });
});

describe('heatLayerFrames', () => {
  it('writes one p{id}r{code} per cell, sorted by hold id', () => {
    expect(
      heatLayerFrames([
        { holdId: 20, bucket: 4, code: 904, color: '#fff' },
        { holdId: 3, bucket: 0, code: 900, color: '#000' },
      ]),
    ).toBe('p3r900p20r904');
  });
});

describe('gradeSwatches', () => {
  it('repeats one colour when every drawn hold is the same grade', () => {
    const swatches = gradeSwatches(4, 4);
    expect(swatches).toHaveLength(5);
    expect(new Set(swatches).size).toBe(1);
    expect(swatches[0]).toBe(V_GRADE_COLORS.V4);
  });

  it('spans easiest to hardest, and is empty with nothing drawn', () => {
    expect(gradeSwatches(0, 8)[0]).toBe(V_GRADE_COLORS.V0);
    expect(gradeSwatches(0, 8)[4]).toBe(V_GRADE_COLORS.V8);
    expect(gradeSwatches(null, null)).toEqual([]);
  });
});
