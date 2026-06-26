import { describe, it, expect } from 'vitest';
import type { ClimbStatsHistoryEntry } from '@boardsesh/graphql/operations';
import { buildAngleGradeBars, buildAscentChartScale, buildAscentScale, niceStep } from '../community-utils';

function makeEntry(overrides: Partial<ClimbStatsHistoryEntry> = {}): ClimbStatsHistoryEntry {
  return {
    angle: 40,
    ascensionistCount: 10,
    qualityAverage: 2.5,
    difficultyAverage: 20,
    displayDifficulty: 20,
    createdAt: '2026-01-01',
    ...overrides,
  };
}

describe('buildAngleGradeBars', () => {
  it('returns an empty array for undefined history', () => {
    expect(buildAngleGradeBars(undefined, 'v-grade')).toEqual([]);
  });

  it('maps difficulty id to a V-grade label and sorts by angle', () => {
    const bars = buildAngleGradeBars(
      [makeEntry({ angle: 50, displayDifficulty: 22 }), makeEntry({ angle: 40, displayDifficulty: 20 })],
      'v-grade',
    );
    expect(bars.map((bar) => bar.angle)).toEqual([40, 50]);
    expect(bars.map((bar) => bar.gradeName)).toEqual(['V5', 'V6']);
  });

  it('uses font labels when requested', () => {
    const bars = buildAngleGradeBars([makeEntry({ displayDifficulty: 20 })], 'font');
    expect(bars[0].gradeName).toBe('6C');
  });

  it('uses combined labels when requested', () => {
    const bars = buildAngleGradeBars([makeEntry({ displayDifficulty: 21 })], 'both');
    expect(bars[0].gradeName).toBe('V5+ / 6C+');
  });

  it('keeps only the latest snapshot per angle, including its ascent count', () => {
    const bars = buildAngleGradeBars(
      [
        makeEntry({ angle: 40, displayDifficulty: 18, ascensionistCount: 5, createdAt: '2026-01-01' }),
        makeEntry({ angle: 40, displayDifficulty: 22, ascensionistCount: 37, createdAt: '2026-03-01' }),
      ],
      'v-grade',
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].difficulty).toBe(22);
    expect(bars[0].gradeName).toBe('V6');
    expect(bars[0].sends).toBe(37);
  });

  it('carries the ascensionist count into sends', () => {
    const bars = buildAngleGradeBars([makeEntry({ ascensionistCount: 42 })], 'v-grade');
    expect(bars[0].sends).toBe(42);
  });

  it('defaults sends to 0 when ascensionistCount is null', () => {
    const bars = buildAngleGradeBars([makeEntry({ ascensionistCount: null })], 'v-grade');
    expect(bars[0].sends).toBe(0);
  });

  it('falls back to displayDifficulty over difficultyAverage, then skips null difficulties', () => {
    const bars = buildAngleGradeBars(
      [
        makeEntry({ angle: 40, displayDifficulty: null, difficultyAverage: 20 }),
        makeEntry({ angle: 45, displayDifficulty: null, difficultyAverage: null }),
      ],
      'v-grade',
    );
    expect(bars.map((bar) => bar.angle)).toEqual([40]);
    expect(bars[0].difficulty).toBe(20);
  });

  it('labels out-of-range difficulties with the rounded numeric value', () => {
    const bars = buildAngleGradeBars([makeEntry({ displayDifficulty: 99.4 })], 'v-grade');
    expect(bars[0].gradeName).toBe('99');
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
