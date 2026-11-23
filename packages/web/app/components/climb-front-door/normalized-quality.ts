import type { ClimbStatsForAngle } from '@/app/lib/data/queries';

/**
 * Rating bounds. `board_climb_stats.quality_average` is the canonical 1-5 blend
 * — but only on rows where `quality_normalized` is true (Aurora reports 1-3).
 */
export const WORST_QUALITY = 1;
export const BEST_QUALITY = 5;

export type NormalizedQuality = { average: number; ratingCount: number };

/**
 * A climb's quality at one angle, or null when it cannot honestly be shown as
 * "out of 5". Every surface that prints a star rating on the climb page goes
 * through this, and so does the meta description (`climbQualityRating` in
 * `app/lib/seo/search-description.ts`), so the page and its search snippet
 * can't disagree about whether a climb has one.
 *
 * Three conditions, all required, and the negative cases are the point:
 *
 *  1. `quality_normalized` — otherwise the value is on Aurora's raw 1-3 scale
 *     and showing it against 5 understates the climb. ~235k JSON-imported
 *     Kilter tick rows are still on that scale.
 *  2. `quality_average` is present and lands inside [1, 5]. A missing average
 *     used to print as "rated 0 of 5".
 *  3. The rating count is at least 1, and it is the *blend's own denominator*,
 *     not `ascensionist_count`. Stated precisely, because the loose version
 *     ("never ascents") is not a promise this expression can make: on a climb
 *     whose quality came from Aurora and which has no native ratings yet, the
 *     denominator is `upstream_ascensionist_count` — and that is correct, since
 *     Aurora's average IS taken over the ascents that rated it. What is excluded
 *     is the Boardsesh ascent count, and the upstream ascents of a climb upstream
 *     never rated at all (`upstream_quality_average IS NULL` → 0).
 */
export function normalizedQuality(
  stats: Pick<ClimbStatsForAngle, 'quality_normalized' | 'quality_average' | 'rating_count'> | undefined,
): NormalizedQuality | null {
  if (!stats || !stats.quality_normalized) return null;

  const average = stats.quality_average === null ? Number.NaN : Number(stats.quality_average);
  if (!Number.isFinite(average) || average < WORST_QUALITY || average > BEST_QUALITY) return null;

  const ratingCount = Number(stats.rating_count);
  if (!Number.isFinite(ratingCount) || ratingCount < 1) return null;

  return { average, ratingCount: Math.trunc(ratingCount) };
}
