import { type SQL, sql } from 'drizzle-orm';
import { boardClimbs } from '../../schema/index';
import { effectiveDifficultySql, gradeValueSql } from './create-climb-filters';
import { effectiveStatsColumn } from './effective-stats';
import type { ClimbSearchParams } from './types';

export type ClimbSortColumnOptions = {
  /** Whether the stats were joined for cross-angle reads (see ./effective-stats). */
  crossAngle: boolean;
  /** Which grade the difficulty sort keys on. */
  gradeSource: ClimbSearchParams['gradeSource'];
  /** Whether the personal-grade subquery is joined (`buildPersonalGradeJoinTarget`). */
  personalGrades: boolean;
};

/**
 * The sort keys a climb list ranks on, read from the same stats row the filters
 * read. Shared by the Climbs search (`runStandardSearch`) and a playlist's view,
 * so the two lists cannot rank one climb two ways.
 *
 * Every stats key assumes `board_climb_stats` (and, under cross-angle, the
 * set-angle alias) is joined; the Boardsesh-source difficulty also reads the
 * joined `board_climb_grades` row, and personal grades the `my_grade` subquery.
 */
export function climbSortColumns(options: ClimbSortColumnOptions): {
  ascents: SQL;
  difficulty: SQL;
  name: SQL;
  quality: SQL;
  creation: SQL;
} {
  const statsCol = (key: Parameters<typeof effectiveStatsColumn>[0]) => effectiveStatsColumn(key, options.crossAngle);

  // Under the Boardsesh source the sort keys on the grade the row is labelled
  // with, the same value the grade-range filter reads (issue #5643). The upstream
  // sort is unchanged: no fallback, so stats-less climbs keep sorting last.
  const crowdDifficultySort =
    options.gradeSource === 'boardsesh'
      ? gradeValueSql(statsCol('displayDifficulty'), 'boardsesh')
      : sql`ROUND(${statsCol('displayDifficulty')}::numeric, 0)`;

  return {
    ascents: sql`${statsCol('ascensionistCount')}`,
    // With personal grades on the difficulty sort orders by COALESCE(my clamped
    // grade, the crowd sort above) — so a climb the climber re-graded to V10
    // lands among the V10s instead of staying with the V0s (#4828). Climbs they
    // never graded keep their crowd position, so the list is one ordered
    // sequence, not two interleaved ones.
    difficulty: options.personalGrades ? effectiveDifficultySql(crowdDifficultySort) : crowdDifficultySort,
    name: sql`${boardClimbs.name}`,
    quality: sql`${statsCol('qualityAverage')}`,
    creation: sql`${boardClimbs.createdAt}`,
  };
}

/**
 * The shuffle key: the climb uuid hashed with a per-shuffle seed, so one shuffle
 * is stable across OFFSET-paginated pages while a new seed reshuffles. An empty
 * seed falls back to a constant salt (md5 is never NULL, so pagination is still
 * stable).
 *
 * Perf: md5(uuid || seed) is non-SARGable — no index satisfies it, so this is a
 * full scan + sort of the filtered set (the whole board when unfiltered). That's
 * inherent to "shuffle everything"; the LIMIT keeps the returned rows small but
 * the sort still touches every matching row. It bypasses the SSR cache (see the
 * web cachedSearchClimbs guard), so each request re-sorts. Acceptable at current
 * catalog sizes; if it ever bites, gate on a filter threshold or a sampling
 * strategy (e.g. TABLESAMPLE / a precomputed random column) rather than md5.
 */
export function randomSortKeySql(sortSeed: string | undefined): SQL {
  return sql`md5(${boardClimbs.uuid} || ${sortSeed || 'boardsesh'})`;
}

/**
 * A sort key with its direction. Ascending puts NULLs (a climb with no stats
 * row) first and descending puts them last, the order the Climbs list has
 * always used.
 */
export function directedSortSql(sortColumn: SQL, sortOrder: string): SQL {
  return sortOrder === 'asc' ? sql`${sortColumn} ASC NULLS FIRST` : sql`${sortColumn} DESC NULLS LAST`;
}
