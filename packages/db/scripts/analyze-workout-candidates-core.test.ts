import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLAN_SHAPES,
  allFilterCombos,
  coreGradeBand,
  countByGrade,
  evaluateCatalogue,
  planDemand,
  planFills,
  tierOf,
  type TierGroup,
} from './analyze-workout-candidates-core.js';

const group = (grade: number, climbs: number, overrides: Partial<TierGroup> = {}): TierGroup => ({
  grade,
  ascentsTier: 0,
  ratingTier: 0,
  isBenchmark: false,
  climbs,
  ...overrides,
});

void describe('tierOf', () => {
  void it('returns the index of the highest threshold met', () => {
    assert.equal(tierOf(7, [0, 1, 5, 10]), 2);
    assert.equal(tierOf(10, [0, 1, 5, 10]), 3);
    assert.equal(tierOf(3.4, [0, 2, 3, 3.5]), 2);
  });

  void it('puts a missing value on tier 0 so it only passes the unfiltered threshold', () => {
    assert.equal(tierOf(null, [0, 1, 5]), 0);
  });
});

void describe('countByGrade', () => {
  const groups = [
    group(20, 10),
    group(20, 4, { ascentsTier: 2, ratingTier: 1 }),
    group(20, 2, { ascentsTier: 2, ratingTier: 1, isBenchmark: true }),
  ];

  void it('counts everything at 0/0', () => {
    const counts = countByGrade(groups, { minAscents: 0, minRating: 0, benchmarksOnly: false });
    assert.equal(counts.get(20), 16);
  });

  void it('applies ascents and rating tiers together', () => {
    const counts = countByGrade(groups, { minAscents: 5, minRating: 2, benchmarksOnly: false });
    assert.equal(counts.get(20), 6);
  });

  void it('keeps benchmarks only when asked', () => {
    const counts = countByGrade(groups, { minAscents: 0, minRating: 0, benchmarksOnly: true });
    assert.equal(counts.get(20), 2);
  });

  void it('throws for a threshold outside the measured grid instead of counting everything', () => {
    assert.throws(
      () => countByGrade(groups, { minAscents: 20, minRating: 0, benchmarksOnly: false }),
      /minAscents 20 is not one of the measured thresholds \(0, 1, 5, 10, 50, 100\)/,
    );
    assert.throws(
      () => countByGrade(groups, { minAscents: 5, minRating: 4, benchmarksOnly: false }),
      /minRating 4 is not one of the measured thresholds \(0, 2, 3, 3\.5\)/,
    );
  });
});

const scaleOf = (...ids: number[]) => ids.map((difficulty_id) => ({ difficulty_id }));

void describe('planDemand', () => {
  const [, , pyramid, ladder] = PLAN_SHAPES;

  void it('asks a pyramid for 1 climb at the peak and 2 at each of the two grades below it', () => {
    const scale = scaleOf(10, 11, 12, 13, 14, 15);
    assert.deepEqual(
      [...planDemand(scale, 15, pyramid)].sort(([first], [second]) => first - second),
      [
        [13, 2],
        [14, 2],
        [15, 1],
      ],
    );
  });

  void it('walks the scale by index, so a gap in the grade table moves the demand', () => {
    const scale = scaleOf(10, 12, 14, 16);
    assert.deepEqual(
      [...planDemand(scale, 16, pyramid)].sort(([first], [second]) => first - second),
      [
        [12, 2],
        [14, 2],
        [16, 1],
      ],
    );
  });

  void it('clamps at the bottom of the scale and stacks the demand there', () => {
    const scale = scaleOf(10, 11, 12);
    assert.deepEqual([...planDemand(scale, 10, pyramid)], [[10, 5]]);
  });

  void it('asks a ladder for 2 climbs at each of 5 grades ending at the target', () => {
    const scale = scaleOf(10, 11, 12, 13, 14, 15);
    assert.equal(
      [...planDemand(scale, 15, ladder).values()].every((needed) => needed === 2),
      true,
    );
    assert.equal(planDemand(scale, 15, ladder).size, 5);
  });
});

void describe('planFills', () => {
  const [volume, , pyramid] = PLAN_SHAPES;

  void it('needs the full count at one grade for a volume plan', () => {
    const scale = scaleOf(20);
    assert.equal(planFills(new Map([[20, 19]]), scale, 20, volume), false);
    assert.equal(planFills(new Map([[20, 20]]), scale, 20, volume), true);
  });

  void it('fills a pyramid with 1/2/2 climbs and ignores grades three and four below the peak', () => {
    const scale = scaleOf(11, 12, 13, 14, 15);
    const counts = new Map([
      [13, 2],
      [14, 2],
      [15, 1],
    ]);
    assert.equal(planFills(counts, scale, 15, pyramid), true);
    assert.equal(planFills(new Map([...counts, [14, 1]]), scale, 15, pyramid), false);
  });

  void it('counts a grade in the table that has no climbs as unfilled demand', () => {
    const scale = scaleOf(11, 12, 13);
    const counts = new Map([
      [11, 5],
      [13, 5],
    ]);
    assert.equal(planFills(counts, scale, 13, pyramid), false, 'grade 12 is on the scale with 0 climbs');
  });
});

void describe('evaluateCatalogue', () => {
  void it('keeps a sparse catalogue from filling a volume plan and reports it', () => {
    const groups = [group(10, 30), group(11, 30), group(12, 5, { ascentsTier: 3, ratingTier: 2 })];
    const result = evaluateCatalogue({ boardType: 'x', layoutId: 1, angle: 40 }, groups, scaleOf(10, 11, 12));
    assert.equal(result.results.length, allFilterCombos().length);
    assert.equal(result.unfilteredClimbs, 65);
    assert.equal(result.benchmarkClimbs, 0);
  });

  void it('builds the core band from the 10th to 90th percentile of grades', () => {
    const groups = [group(1, 1), group(2, 98), group(3, 1)];
    assert.deepEqual(coreGradeBand(groups), [2]);
  });
});
