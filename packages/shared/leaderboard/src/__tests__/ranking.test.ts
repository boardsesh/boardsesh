import { describe, expect, it } from 'vitest';
import {
  MIN_COHORT_FOR_PERCENTILE,
  MIN_TIE_FOR_SUPPRESSING_PERCENTILE,
  isTied,
  nextRankGap,
  shouldShowPercentile,
  tiedWithCount,
} from '../ranking';

describe('shouldShowPercentile', () => {
  it('shows a percentile on a healthy cohort where the climber is not buried in a tie', () => {
    expect(shouldShowPercentile({ cohortSize: 645, tieSize: 1 })).toBe(true);
    expect(shouldShowPercentile({ cohortSize: 645, tieSize: 9 })).toBe(true);
  });

  it('suppresses it inside a large tie, where it describes the crowd rather than the climber', () => {
    // The measured common case: 1,026 of 1,203 globally active climbers sit in
    // a tie block of 10+, so this branch is the main path, not an edge case.
    expect(shouldShowPercentile({ cohortSize: 1203, tieSize: MIN_TIE_FOR_SUPPRESSING_PERCENTILE })).toBe(false);
    expect(shouldShowPercentile({ cohortSize: 1203, tieSize: 48 })).toBe(false);
  });

  it('suppresses it on a small cohort, where one climb moves it twenty points', () => {
    expect(shouldShowPercentile({ cohortSize: MIN_COHORT_FOR_PERCENTILE - 1, tieSize: 1 })).toBe(false);
    // The biggest real physical board in production has 17 climbers.
    expect(shouldShowPercentile({ cohortSize: 17, tieSize: 1 })).toBe(false);
    // And a solo wall, which is 660 of 808 active real boards.
    expect(shouldShowPercentile({ cohortSize: 1, tieSize: 1 })).toBe(false);
  });

  it('is inclusive at the cohort threshold and exclusive at the tie threshold', () => {
    expect(shouldShowPercentile({ cohortSize: MIN_COHORT_FOR_PERCENTILE, tieSize: 1 })).toBe(true);
    expect(shouldShowPercentile({ cohortSize: MIN_COHORT_FOR_PERCENTILE, tieSize: 9 })).toBe(true);
    expect(shouldShowPercentile({ cohortSize: MIN_COHORT_FOR_PERCENTILE, tieSize: 10 })).toBe(false);
  });
});

describe('tie helpers', () => {
  it('reports a solo rank as untied', () => {
    expect(isTied({ tieSize: 1 })).toBe(false);
    expect(tiedWithCount({ tieSize: 1 })).toBe(0);
  });

  it('counts the OTHER climbers on the rank, not the whole block', () => {
    // "612th, with 47 other climbers" — the block is 48.
    expect(isTied({ tieSize: 48 })).toBe(true);
    expect(tiedWithCount({ tieSize: 48 })).toBe(47);
  });

  it('never reports a negative count on a malformed tie size', () => {
    expect(tiedWithCount({ tieSize: 0 })).toBe(0);
  });
});

describe('nextRankGap', () => {
  it('returns the climbs needed to reach the next distinct score, and the rank it earns', () => {
    // Viewer on 17 at rank 88. Scores above: …, 19, 21.
    const gap = nextRankGap({ rank: 88, score: 17 }, [21, 19, 19, 25]);
    expect(gap).toEqual({ climbsNeeded: 2, rank: 3 });
  });

  it('treats a group of tied climbers above as ONE step, not one per person', () => {
    // Four climbers all on 19: passing them is a single 2-climb step, and
    // RANK() puts you level with them rather than between them.
    const gap = nextRankGap({ rank: 40, score: 17 }, [19, 19, 19, 19]);
    expect(gap).toEqual({ climbsNeeded: 2, rank: 1 });
  });

  it('returns null at the top of the board', () => {
    expect(nextRankGap({ rank: 1, score: 181 }, [])).toBeNull();
    expect(nextRankGap({ rank: 1, score: 181 }, [181, 181])).toBeNull();
  });

  it('returns null when the viewer is tied with everyone above them, so there is no gap to name', () => {
    // Rank 5 shared with others on 8; nothing strictly above in the sample.
    expect(nextRankGap({ rank: 5, score: 8 }, [8, 8, 8])).toBeNull();
  });

  it('ignores scores at or below the viewer', () => {
    const gap = nextRankGap({ rank: 88, score: 17 }, [17, 16, 3, 18]);
    expect(gap).toEqual({ climbsNeeded: 1, rank: 1 });
  });
});
