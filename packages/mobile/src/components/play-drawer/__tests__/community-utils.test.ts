import { describe, it, expect } from 'vitest';
import type { ClimbStatsForAnglesEntry } from '@boardsesh/graphql/operations';
import {
  buildAngleGradeBars,
  buildAscentChartScale,
  buildAscentScale,
  niceStep,
  totalSendsForSource,
} from '../community-utils';

function makeEntry(overrides: Partial<ClimbStatsForAnglesEntry> = {}): ClimbStatsForAnglesEntry {
  return {
    angle: 40,
    ascensionistCount: 10,
    kilterAscensionistCount: 6,
    auroraAscensionistCount: 4,
    boardseshAscensionistCount: 3,
    qualityAverage: 2.5,
    difficultyAverage: 20,
    displayDifficulty: 20,
    difficulty: '20',
    faUsername: null,
    faAt: null,
    ...overrides,
  };
}

describe('buildAngleGradeBars', () => {
  it('returns an empty array for undefined entries', () => {
    expect(buildAngleGradeBars(undefined, 'v-grade', 'all')).toEqual([]);
  });

  it('maps difficulty id to a V-grade label and sorts by angle', () => {
    const bars = buildAngleGradeBars(
      [makeEntry({ angle: 50, displayDifficulty: 22 }), makeEntry({ angle: 40, displayDifficulty: 20 })],
      'v-grade',
      'all',
    );
    expect(bars.map((bar) => bar.angle)).toEqual([40, 50]);
    expect(bars.map((bar) => bar.gradeName)).toEqual(['V5', 'V6']);
  });

  it('uses font labels when requested', () => {
    const bars = buildAngleGradeBars([makeEntry({ displayDifficulty: 20 })], 'font', 'all');
    expect(bars[0].gradeName).toBe('6C');
  });

  it('uses combined labels when requested', () => {
    const bars = buildAngleGradeBars([makeEntry({ displayDifficulty: 21 })], 'both', 'all');
    expect(bars[0].gradeName).toBe('V5+ / 6C+');
  });

  it('uses the combined total for the "all" source', () => {
    const bars = buildAngleGradeBars([makeEntry({ ascensionistCount: 42 })], 'v-grade', 'all');
    expect(bars[0].sends).toBe(42);
  });

  it('uses max(kilter, aurora) for the "boardApp" source', () => {
    const bars = buildAngleGradeBars(
      [makeEntry({ kilterAscensionistCount: 6, auroraAscensionistCount: 9 })],
      'v-grade',
      'boardApp',
    );
    expect(bars[0].sends).toBe(9);
  });

  it('uses the Boardsesh count for the "boardsesh" source', () => {
    const bars = buildAngleGradeBars([makeEntry({ boardseshAscensionistCount: 3 })], 'v-grade', 'boardsesh');
    expect(bars[0].sends).toBe(3);
  });

  it('keeps the grade label/colour derived from difficulty regardless of source', () => {
    const all = buildAngleGradeBars([makeEntry({ displayDifficulty: 20 })], 'v-grade', 'all');
    const boardsesh = buildAngleGradeBars([makeEntry({ displayDifficulty: 20 })], 'v-grade', 'boardsesh');
    expect(all[0].gradeName).toBe('V5');
    expect(boardsesh[0].gradeName).toBe('V5');
  });

  it('defaults sends to 0 when the source has no count and no total', () => {
    const bars = buildAngleGradeBars(
      [makeEntry({ ascensionistCount: null, kilterAscensionistCount: null, auroraAscensionistCount: null })],
      'v-grade',
      'boardApp',
    );
    expect(bars[0].sends).toBe(0);
  });

  it('falls back to displayDifficulty over difficultyAverage, then skips null difficulties', () => {
    const bars = buildAngleGradeBars(
      [
        makeEntry({ angle: 40, displayDifficulty: null, difficultyAverage: 20 }),
        makeEntry({ angle: 45, displayDifficulty: null, difficultyAverage: null }),
      ],
      'v-grade',
      'all',
    );
    expect(bars.map((bar) => bar.angle)).toEqual([40]);
    expect(bars[0].difficulty).toBe(20);
  });

  it('labels out-of-range difficulties with the rounded numeric value', () => {
    const bars = buildAngleGradeBars([makeEntry({ displayDifficulty: 99.4 })], 'v-grade', 'all');
    expect(bars[0].gradeName).toBe('99');
  });
});

describe('totalSendsForSource', () => {
  it('sums the per-source count across all angles', () => {
    const entries = [
      makeEntry({ angle: 40, ascensionistCount: 10, boardseshAscensionistCount: 3 }),
      makeEntry({ angle: 50, ascensionistCount: 20, boardseshAscensionistCount: 7 }),
    ];
    expect(totalSendsForSource(entries, 'all')).toBe(30);
    expect(totalSendsForSource(entries, 'boardsesh')).toBe(10);
  });

  it('is 0 for undefined entries', () => {
    expect(totalSendsForSource(undefined, 'all')).toBe(0);
  });

  it('reports 0 for a source with no data across angles', () => {
    const entries = [
      makeEntry({ boardseshAscensionistCount: 0 }),
      makeEntry({ angle: 50, boardseshAscensionistCount: 0 }),
    ];
    expect(totalSendsForSource(entries, 'boardsesh')).toBe(0);
  });
});

describe('niceStep', () => {
  it('rounds raw steps up to the next 1/2/5 × 10ⁿ value', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(13)).toBe(20);
    expect(niceStep(25)).toBe(50);
    expect(niceStep(120)).toBe(200);
  });
});

describe('buildAscentScale', () => {
  it('keeps the top tick strictly above the tallest bar so its top-label has headroom', () => {
    for (const peak of [0, 1, 2, 3, 4, 5, 10, 20, 37, 40, 100, 123, 1000, 1234]) {
      const scale = buildAscentScale(peak);
      expect(scale.maxValue).toBeGreaterThan(peak);
      // The tick texts derived in the chart use noOfSections + 1 labels; the top
      // tick must equal step × sections.
      expect(scale.maxValue).toBe(scale.step * scale.noOfSections);
    }
  });

  it('uses whole-number, evenly-spaced steps', () => {
    expect(buildAscentScale(10)).toEqual({ maxValue: 15, noOfSections: 3, step: 5 });
    expect(buildAscentScale(37)).toEqual({ maxValue: 40, noOfSections: 4, step: 10 });
    expect(buildAscentScale(100)).toEqual({ maxValue: 150, noOfSections: 3, step: 50 });
  });

  it('stays sane for an empty / single-ascent chart', () => {
    expect(buildAscentScale(0)).toEqual({ maxValue: 2, noOfSections: 2, step: 1 });
    expect(buildAscentScale(1)).toEqual({ maxValue: 2, noOfSections: 2, step: 1 });
  });
});

describe('buildAscentChartScale', () => {
  it('keeps a linear axis for tight spreads', () => {
    const scale = buildAscentChartScale([10, 8, 6]);
    expect(scale.isLog).toBe(false);
    expect(scale.plot(8)).toBe(8);
    expect(scale).toMatchObject({ maxValue: 15, noOfSections: 3, yAxisLabelTexts: ['0', '5', '10', '15'] });
  });

  it('keeps a linear axis when one angle leads but the peak is still small', () => {
    // peak 10 (< the log peak threshold) → linear even though 10× the floor.
    expect(buildAscentChartScale([10, 1]).isLog).toBe(false);
  });

  it('keeps a linear axis for a big-but-even chart', () => {
    // peak 100 clears the threshold, but a 1.1× spread would only flatten on log.
    expect(buildAscentChartScale([100, 90]).isLog).toBe(false);
  });

  it('switches to a log axis when one angle dominates', () => {
    const scale = buildAscentChartScale([2000, 50, 2]);
    expect(scale.isLog).toBe(true);
    expect(scale).toMatchObject({
      maxValue: 5,
      noOfSections: 5,
      yAxisLabelTexts: ['0', '1', '10', '100', '1k', '10k'],
    });
    // log10(v) + 1: a single ascent still clears a whole section off the baseline.
    expect(scale.plot(1)).toBeCloseTo(1);
    expect(scale.plot(10)).toBeCloseTo(2);
    expect(scale.plot(2000)).toBeCloseTo(Math.log10(2000) + 1);
    expect(scale.plot(0)).toBe(0);
  });

  it('keeps the top tick above the tallest bar on the log axis', () => {
    // peak 100 sits exactly on a decade, so it must gain a section for headroom.
    const scale = buildAscentChartScale([100, 1]);
    expect(scale.isLog).toBe(true);
    expect(scale.noOfSections).toBe(4);
    expect(scale.maxValue).toBeGreaterThan(scale.plot(100));
  });

  it('stays linear for a single angle (no spread to measure)', () => {
    // One bar means floor === peak, so the ratio is 1 and the linear axis wins.
    expect(buildAscentChartScale([500]).isLog).toBe(false);
  });

  it('stays sane for an all-zero chart', () => {
    const scale = buildAscentChartScale([0, 0]);
    expect(scale.isLog).toBe(false);
    expect(scale).toMatchObject({ maxValue: 2, noOfSections: 2, yAxisLabelTexts: ['0', '1', '2'] });
  });
});
