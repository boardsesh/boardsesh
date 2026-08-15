/**
 * Display rules for a ranked list.
 *
 * These do NOT gate whether a leaderboard renders — every scope shows its
 * ordered list, however few people are on it. They gate how much *precision*
 * the list claims, which is a different question: a percentile computed over
 * six climbers, or over a tie block of forty-eight, is a number that looks
 * authoritative and means nothing.
 *
 * Both thresholds come from measured production data (2026-08-14, 30-day
 * window, sends only, excluding the frozen import).
 */

/**
 * Below this many climbers in a scope, a percentile is precision theatre — one
 * climb can move you twenty points. The ordered list still renders.
 */
export const MIN_COHORT_FOR_PERCENTILE = 30;

/**
 * At or above this many climbers sharing your exact score, a percentile stops
 * describing you and starts describing the crowd. Measured: **1,026 of 1,203
 * globally active climbers (85.3%) sit in a tie block of 10 or more**, and the
 * global board has only 84 distinct scores across those 1,203 people. So this
 * is the common path, not an edge case.
 */
export const MIN_TIE_FOR_SUPPRESSING_PERCENTILE = 10;

export type ViewerStanding = {
  /** RANK(): shared by everyone on the same score. Not dense, not unique. */
  rank: number;
  /** Distinct climbs topped in the window. */
  score: number;
  /** How many climbers share this exact score, including the viewer. */
  tieSize: number;
  /** Total climbers in the scope, i.e. the denominator. */
  cohortSize: number;
  /** 0-1, share of the cohort at or below this score. */
  percentile: number;
};

/**
 * Whether the viewer card should show a percentile bar at all.
 *
 * Suppressed on a small cohort (the number is noise) and inside a large tie
 * (the number describes the crowd, not the climber). In the second case the
 * honest line is the tie size itself — "612th, with 47 other climbers" — which
 * also happens to be the most motivating thing on the screen, because one climb
 * breaks you out of a crowd of 47.
 */
export function shouldShowPercentile(standing: Pick<ViewerStanding, 'cohortSize' | 'tieSize'>): boolean {
  if (standing.cohortSize < MIN_COHORT_FOR_PERCENTILE) return false;
  if (standing.tieSize >= MIN_TIE_FOR_SUPPRESSING_PERCENTILE) return false;
  return true;
}

/** Is this climber sharing their rank with anyone? */
export function isTied(standing: Pick<ViewerStanding, 'tieSize'>): boolean {
  return standing.tieSize > 1;
}

/** How many others share the rank. The UI pluralizes; this just does the arithmetic. */
export function tiedWithCount(standing: Pick<ViewerStanding, 'tieSize'>): number {
  return Math.max(0, standing.tieSize - 1);
}

export type RankGap = {
  /** Additional distinct climbs needed to reach `rank`. Always >= 1. */
  climbsNeeded: number;
  /** The rank those climbs would earn. */
  rank: number;
};

/**
 * "Two more and you're 81st."
 *
 * Deliberately names a *rank*, never a person. Two of the design concepts
 * printed "2 more and you pass Priya S." — into a room where Priya is standing.
 *
 * `scoresAbove` is every distinct score above the viewer's, in any order. Only
 * distinct scores matter: passing four people tied on 19 is one step, not four.
 * Returns null when the viewer is already at the top, or when nothing is above
 * them to aim at.
 */
export function nextRankGap(standing: Pick<ViewerStanding, 'rank' | 'score'>, scoresAbove: number[]): RankGap | null {
  if (standing.rank <= 1) return null;

  const strictlyAbove = scoresAbove.filter((score) => score > standing.score);
  if (strictlyAbove.length === 0) return null;

  // The nearest score above is the one to aim at.
  const target = Math.min(...strictlyAbove);
  const climbsNeeded = target - standing.score;
  if (climbsNeeded <= 0) return null;

  // Reaching that score ties you with everyone already on it, and RANK() gives
  // ties the same number — so the rank earned is that group's rank, which is
  // 1 + however many distinct scores sit strictly above the target.
  const distinctAboveTarget = new Set(strictlyAbove.filter((score) => score > target)).size;
  return { climbsNeeded, rank: distinctAboveTarget + 1 };
}
