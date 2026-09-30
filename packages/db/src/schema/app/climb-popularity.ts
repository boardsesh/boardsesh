import { pgTable, text, integer, bigint, doublePrecision, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * The popular sort's ranking key, precomputed: one row per `board_climb_stats`
 * row, carrying the climb's ascent total summed over EVERY angle.
 *
 * The popular sort used to compute that total on every search, with a GROUP BY
 * over every stats row of the board type (419k rows on Kilter) and a hash join
 * of every candidate climb on the layout before it could sort. In production
 * that was a 20 s mean and about 2.4 GB of temp files per call. With this table
 * the search walks `board_climb_popularity_rank_idx` in order and stops after
 * one page, the same way the ascents sort walks the stats covering index.
 *
 * Why a side table and not a column:
 * - Never a column on `board_climbs`: its row trigger bumps `sync_seq`, so a
 *   popularity change would make every device re-pull the climb.
 * - Never a column on `board_climb_stats` either: its trigger bumps `sync_seq`
 *   for the columns devices sync, and the total changes whenever ANY angle of
 *   the climb changes, which would fan one tick out to every angle's row.
 *
 * Rows per angle so the index can start at (board_type, angle) and so
 * `display_difficulty` and `ascensionist_count` (copies of the stats row at that
 * angle) ride along as trailing key columns: a grade band or a minimum-ascents
 * filter is checked inside the index, before any heap or `board_climbs` probe.
 * The search still re-checks the live stats row, so these copies only decide
 * which rows are worth probing.
 *
 * Written only by `refreshClimbPopularity` (the backend's
 * `climb-popularity-refresh` job), which reads `board_climb_stats` through its
 * (board_type, updated_at, sync_seq) cursor index. Every row of one climb is
 * written in the same statement, so all of a climb's rows carry the same total.
 */
export const boardClimbPopularity = pgTable(
  'board_climb_popularity',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    /** COALESCE(SUM(ascensionist_count), 0) over every angle of the climb. */
    totalAscensionistCount: bigint('total_ascensionist_count', { mode: 'number' }).notNull(),
    /** Copy of `board_climb_stats.display_difficulty` at this angle. */
    displayDifficulty: doublePrecision('display_difficulty'),
    /** Copy of `board_climb_stats.ascensionist_count` at this angle. */
    ascensionistCount: bigint('ascensionist_count', { mode: 'number' }),
  },
  (table) => ({
    // Same key as board_climb_stats: the refresh upserts on it, and the
    // fallback reads a climb's total through its (board_type, climb_uuid) prefix.
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.angle] }),
    // The popular sort's read path. `.nullsFirst()` makes the index pathkeys
    // match a bare `DESC` in the ORDER BY (both columns are NOT NULL, so the
    // two forms order identically); a bare `.desc()` emits NULLS LAST and
    // Postgres would stack a Sort on top. The two trailing columns are KEY
    // columns rather than INCLUDE because drizzle-kit cannot express INCLUDE;
    // climb_uuid is unique within (board_type, angle), so they never change
    // the order, and they make the band and minimum-ascents checks index-only.
    rankIdx: index('board_climb_popularity_rank_idx').on(
      table.boardType,
      table.angle,
      table.totalAscensionistCount.desc().nullsFirst(),
      table.climbUuid.desc().nullsFirst(),
      table.displayDifficulty,
      table.ascensionistCount,
    ),
  }),
);

/**
 * One row per board type: how far `refreshClimbPopularity` has read.
 *
 * - `stats_updated_through` is the newest `board_climb_stats.updated_at` the last
 *   run saw. The next run re-reads every climb with a stats row updated at or
 *   after it minus an hour of slack, because `updated_at` is stamped when a
 *   row is written, not when its transaction commits.
 * - `full_built_at` is set once every stats row of the board has been folded in.
 *   The search reads the table for a board only after that, so a deploy that
 *   lands before the first build keeps the old aggregation.
 */
export const boardClimbPopularityRuns = pgTable('board_climb_popularity_runs', {
  boardType: text('board_type').primaryKey().notNull(),
  statsUpdatedThrough: timestamp('stats_updated_through', { mode: 'string' }),
  fullBuiltAt: timestamp('full_built_at', { mode: 'string' }),
  refreshedAt: timestamp('refreshed_at', { mode: 'string' }).defaultNow().notNull(),
});

export type BoardClimbPopularity = typeof boardClimbPopularity.$inferSelect;
export type BoardClimbPopularityRun = typeof boardClimbPopularityRuns.$inferSelect;
