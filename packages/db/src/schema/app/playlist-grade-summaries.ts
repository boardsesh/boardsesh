import { pgTable, bigint, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { playlists } from './playlists';

/**
 * The grade spread of one playlist's climbs, precomputed so Discover can show
 * "V3–V5" on a card and filter community playlists by grade without a
 * per-request aggregate over `playlist_climbs` x `board_climb_stats`.
 *
 * Every difficulty is a rounded grade id, `ROUND(display_difficulty)`, the
 * same number the climb search's grade filter compares against
 * (`gradeValueSql` in create-climb-filters.ts), so a playlist band and a climb
 * band mean the same thing.
 *
 * Why a side table and not columns on `playlists`: `playlists` feeds the
 * offline sync pull through `playlists_sync_cursor_idx` (updated_at, id). A
 * grade that drifts with an upstream catalog sync would have to bump
 * `updated_at` to be seen, and every device would re-pull a playlist whose
 * name, climbs and colour never changed.
 *
 * One row per playlist with at least one graded climb. A playlist with no
 * graded climb has no row, which is how the grade filter excludes it.
 *
 * Written only through packages/db/src/queries/playlists/grade-summaries.ts:
 * `refreshPlaylistGradeSummariesFor` on every climb add or remove, and
 * `refreshAllPlaylistGradeSummaries` from the backend's daily
 * `playlist-grade-summary-refresh` job, which skips rows whose values did not
 * change. See docs/playlist-grade-summaries.md.
 */
export const playlistGradeSummaries = pgTable('playlist_grade_summaries', {
  playlistId: bigint('playlist_id', { mode: 'bigint' })
    .primaryKey()
    .notNull()
    .references(() => playlists.id, { onDelete: 'cascade' }),
  /** Copy of `playlists.board_type`: which grade scale the ids below are on. */
  boardType: text('board_type').notNull(),
  /** Climbs that had a grade. The summary below covers only these. */
  gradedClimbCount: integer('graded_climb_count').notNull(),
  minDifficulty: integer('min_difficulty').notNull(),
  /** 10th percentile (percentile_disc), the low end of the band Discover shows and filters on. */
  p10Difficulty: integer('p10_difficulty').notNull(),
  medianDifficulty: integer('median_difficulty').notNull(),
  /** 90th percentile (percentile_disc), the high end of the band. */
  p90Difficulty: integer('p90_difficulty').notNull(),
  maxDifficulty: integer('max_difficulty').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type PlaylistGradeSummary = typeof playlistGradeSummaries.$inferSelect;
