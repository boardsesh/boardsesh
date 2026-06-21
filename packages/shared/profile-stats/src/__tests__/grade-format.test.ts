import { describe, it, expect } from 'vitest';
import {
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildFlashRedpointBars,
  buildStatisticsSummary,
} from '../chart-builders';
import { getDifficultyMapping, sortGrades } from '../grade-mapping';
import type { LogbookEntry } from '../types';

// Real taxonomy: difficulty 16 → V3 / 6a, 17 → V3 / 6a+, 22 → V6 / 7a.

const entries: LogbookEntry[] = [
  { climbed_at: '2025-01-15T10:00:00Z', difficulty: 16, tries: 1, angle: 40, status: 'flash', climbUuid: 'a' },
  { climbed_at: '2025-01-15T11:00:00Z', difficulty: 22, tries: 3, angle: 40, status: 'send', climbUuid: 'b' },
  { climbed_at: '2025-01-15T12:00:00Z', difficulty: 17, tries: 1, angle: 40, status: 'flash', climbUuid: 'c' },
];

describe('font vs v-grade mapping', () => {
  it('getDifficultyMapping switches label set', () => {
    expect(getDifficultyMapping('v-grade')[22]).toBe('V6');
    expect(getDifficultyMapping('font')[22]).toBe('7A');
    expect(getDifficultyMapping('both')[22]).toBe('V6 / 7A');
  });

  it('sortGrades orders by numeric difficulty in both formats', () => {
    expect(sortGrades(['V6', 'V3', 'V11'], 'v-grade')).toEqual(['V3', 'V6', 'V11']);
    expect(sortGrades(['7A', '6A', '6A+'], 'font')).toEqual(['6A', '6A+', '7A']);
    expect(sortGrades(['V6 / 7A', 'V3 / 6A', 'V3+ / 6A+'], 'both')).toEqual(['V3 / 6A', 'V3+ / 6A+', 'V6 / 7A']);
  });
});

describe('builders honor font format', () => {
  const ticks: Record<string, LogbookEntry[]> = {
    kilter: entries.map((e) => ({ ...e, layoutId: 1, boardType: 'kilter' })),
  };

  it('buildAggregatedStackedBars uses Font labels sorted by Font order', () => {
    const result = buildAggregatedStackedBars(ticks, 'all', 'font')!;
    expect(result.bars.map((b) => b.label)).toEqual(['6A', '6A+', '7A']);
  });

  it('buildWeeklyBars uses Font labels', () => {
    const result = buildWeeklyBars(entries, undefined, undefined, 'font')!;
    const labels = new Set(result.flatMap((b) => b.segments.map((s) => s.label)));
    expect(labels.has('6A')).toBe(true);
    expect(labels.has('7A')).toBe(true);
    expect(labels.has('V3')).toBe(false);
  });

  it('buildFlashRedpointBars uses Font labels sorted by Font order', () => {
    const result = buildFlashRedpointBars(entries, 'font')!;
    expect(result.map((b) => b.key)).toEqual(['6A', '6A+', '7A']);
  });

  it('buildStatisticsSummary maps grade ids to Font labels', () => {
    const { layoutPercentages } = buildStatisticsSummary(
      {
        totalDistinctClimbs: 10,
        layoutStats: [
          {
            layoutKey: 'kilter-1',
            boardType: 'kilter',
            layoutId: 1,
            distinctClimbCount: 10,
            gradeCounts: [
              { grade: '16', count: 3 },
              { grade: '17', count: 2 },
              { grade: '22', count: 5 },
            ],
          },
        ],
      },
      'font',
    );
    expect(layoutPercentages[0].grades).toEqual({ '6A': 3, '6A+': 2, '7A': 5 });
  });

  it('buildAggregatedStackedBars uses combined labels when requested', () => {
    const result = buildAggregatedStackedBars(ticks, 'all', 'both')!;
    expect(result.bars.map((b) => b.label)).toEqual(['V3 / 6A', 'V3+ / 6A+', 'V6 / 7A']);
  });

  it('v-grade format still produces V labels', () => {
    const result = buildAggregatedStackedBars(ticks, 'all', 'v-grade')!;
    const labels = result.bars.map((b) => b.label);
    expect(labels).toContain('V3');
    expect(labels).toContain('V6');
    expect(labels).not.toContain('6A');
  });
});
