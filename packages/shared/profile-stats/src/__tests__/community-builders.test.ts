import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { buildSetterSummary, buildBenchmarkGradeBars } from '../chart-builders';
import type { LogbookEntry } from '../types';

const NOW = dayjs('2026-06-15T12:00:00').toISOString();
function entry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return { climbed_at: NOW, difficulty: 22, tries: 1, angle: 40, status: 'send', ...overrides };
}

describe('buildSetterSummary', () => {
  it('counts distinct sent climbs per setter and finds the top setter', () => {
    const logbook = [
      entry({ setterUsername: 'kilterjackie', climbUuid: 'a' }),
      entry({ setterUsername: 'kilterjackie', climbUuid: 'b' }),
      entry({ setterUsername: 'kilterjackie', climbUuid: 'a' }), // dup climb → not recounted
      entry({ setterUsername: 'kilterjackie', climbUuid: 'c' }),
      entry({ setterUsername: 'tensionbot', climbUuid: 'd' }),
      entry({ setterUsername: 'attemptsetter', climbUuid: 'e', status: 'attempt' }), // not sent
    ];
    const summary = buildSetterSummary(logbook);
    expect(summary.topSetter).toEqual({ username: 'kilterjackie', count: 3 });
    expect(summary.distinctSetters).toBe(2);
  });

  it('is empty when no sent climb has a setter', () => {
    expect(buildSetterSummary([entry({ setterUsername: null })])).toEqual({ topSetter: null, distinctSetters: 0 });
  });
});

describe('buildBenchmarkGradeBars', () => {
  it('counts distinct benchmark sends per grade, grade-ascending', () => {
    const logbook = [
      entry({ isBenchmark: true, climbUuid: 'b1', difficulty: 22 }), // V6
      entry({ isBenchmark: true, climbUuid: 'b2', difficulty: 22 }), // V6
      entry({ isBenchmark: true, climbUuid: 'b1', difficulty: 22 }), // dup → not recounted
      entry({ isBenchmark: true, climbUuid: 'b3', difficulty: 28 }), // V11
      entry({ isBenchmark: false, climbUuid: 'n1', difficulty: 22 }), // not a benchmark
      entry({ isBenchmark: true, climbUuid: 'b4', difficulty: 28, status: 'attempt' }), // not sent
    ];
    const bars = buildBenchmarkGradeBars(logbook, 'v-grade');
    expect(bars).not.toBeNull();
    expect(bars!.map((b) => [b.label, b.segments[0].value])).toEqual([
      ['V6', 2],
      ['V11', 1],
    ]);
  });

  it('returns null when nothing is benchmarked', () => {
    expect(buildBenchmarkGradeBars([entry({ isBenchmark: false })], 'v-grade')).toBeNull();
  });
});
