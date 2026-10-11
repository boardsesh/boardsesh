import { and, asc, eq, gt, inArray, isNotNull, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbStats, playlistClimbs, playlistGradeSummaries, playlists } from '../../schema/index';

/**
 * Keeps `playlist_grade_summaries` in step with each playlist's climbs and
 * their grades. Two callers:
 *
 *  - The playlist mutations, with the one playlist whose climbs just changed.
 *  - The backend's daily `playlist-grade-summary-refresh` job, with every
 *    playlist in id order, `REFRESH_CHUNK_PLAYLISTS` at a time. Grades drift
 *    when an upstream catalog sync rewrites `display_difficulty`, and the
 *    Aurora and Kilter circuit syncs write `playlist_climbs` without going
 *    through the mutations, so the job is what catches both.
 *
 * Every write is an upsert that skips unchanged rows, plus a delete of the
 * rows whose playlist no longer has a graded climb. A rerun over unchanged
 * data costs reads and no writes (docs/postgres-query-costs.md).
 */

export type PlaylistGradeSummaryDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Playlists per job statement. Private Aurora circuits can run to a few hundred climbs each. */
export const REFRESH_CHUNK_PLAYLISTS = 500;

/** Lower and upper percentile of the band Discover shows and filters on. */
export const GRADE_BAND_LOW_PERCENTILE = 0.1;
export const GRADE_BAND_HIGH_PERCENTILE = 0.9;

export type PlaylistGradeSummaryWriteResult = {
  /** Summaries inserted or updated because a value moved. */
  written: number;
  /** Summaries removed because their playlist has no graded climb left. */
  deleted: number;
};

export type PlaylistGradeSummaryRefreshResult = PlaylistGradeSummaryWriteResult & {
  /** Chunks of up to `REFRESH_CHUNK_PLAYLISTS` playlists the pass finished. */
  chunks: number;
  /** False when `shouldContinue` stopped the pass before the last chunk. */
  completed: boolean;
};

/**
 * The stats row a null-angle playlist climb is graded from.
 *
 * Aurora- and Kilter-synced circuits arrive with `playlist_climbs.angle` NULL:
 * a circuit is a list of climbs, not of climbs-at-an-angle. Skipping those
 * rows would leave most synced circuits with no grade at all, so they take the
 * grade at the climb's most-repeated angle instead (ties to the lower angle).
 * That is the angle the most climbers have actually climbed it at, so it is
 * the grade the crowd knows the climb by. A climb with no graded stats row at
 * any angle stays ungraded.
 */
const fallbackStats = alias(boardClimbStats, 'fallback_stats');

/**
 * The playlist climb's grade id: `ROUND(display_difficulty)` at the row's own
 * angle, which is the number the climb search's grade filter compares
 * (`gradeValueSql`, upstream source), or the most-repeated angle's for a
 * null-angle row. NULL when the climb has no grade.
 */
function climbGradeSql(db: PlaylistGradeSummaryDb): SQL<number | null> {
  const mostRepeatedAngleGrade = db
    .select({ displayDifficulty: fallbackStats.displayDifficulty })
    .from(fallbackStats)
    .where(
      and(
        eq(fallbackStats.boardType, playlists.boardType),
        eq(fallbackStats.climbUuid, playlistClimbs.climbUuid),
        isNotNull(fallbackStats.displayDifficulty),
      ),
    )
    .orderBy(sql`${fallbackStats.ascensionistCount} DESC NULLS LAST`, asc(fallbackStats.angle))
    .limit(1);
  return sql<number | null>`ROUND(COALESCE(
    ${boardClimbStats.displayDifficulty},
    CASE WHEN ${playlistClimbs.angle} IS NULL THEN (${mostRepeatedAngleGrade}) END
  )::numeric, 0)::int`;
}

type ComputedSummary = {
  playlistId: bigint;
  boardType: string;
  gradedClimbCount: number;
  minDifficulty: number;
  p10Difficulty: number;
  medianDifficulty: number;
  p90Difficulty: number;
  maxDifficulty: number;
};

/** Every summary the playlists `playlistScope` selects should have. */
async function computeSummaries(db: PlaylistGradeSummaryDb, playlistScope: SQL): Promise<ComputedSummary[]> {
  const perClimb = db
    .select({
      playlistId: playlistClimbs.playlistId,
      boardType: sql<string>`${playlists.boardType}`.as('board_type'),
      difficulty: climbGradeSql(db).as('difficulty'),
    })
    .from(playlistClimbs)
    .innerJoin(playlists, eq(playlists.id, playlistClimbs.playlistId))
    .leftJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, playlists.boardType),
        eq(boardClimbStats.climbUuid, playlistClimbs.climbUuid),
        eq(boardClimbStats.angle, playlistClimbs.angle),
      ),
    )
    .where(playlistScope)
    .as('per_climb');

  return db
    .select({
      playlistId: perClimb.playlistId,
      boardType: perClimb.boardType,
      gradedClimbCount: sql<number>`count(*)::int`,
      minDifficulty: sql<number>`min(${perClimb.difficulty})`,
      p10Difficulty: sql<number>`percentile_disc(${GRADE_BAND_LOW_PERCENTILE}::float8) WITHIN GROUP (ORDER BY ${perClimb.difficulty})`,
      medianDifficulty: sql<number>`percentile_disc(0.5::float8) WITHIN GROUP (ORDER BY ${perClimb.difficulty})`,
      p90Difficulty: sql<number>`percentile_disc(${GRADE_BAND_HIGH_PERCENTILE}::float8) WITHIN GROUP (ORDER BY ${perClimb.difficulty})`,
      maxDifficulty: sql<number>`max(${perClimb.difficulty})`,
    })
    .from(perClimb)
    .where(isNotNull(perClimb.difficulty))
    .groupBy(perClimb.playlistId, perClimb.boardType);
}

/**
 * Recompute the summaries of the playlists `playlistScope` selects, writing
 * only rows whose values moved and deleting the ones that no longer have a
 * graded climb. `summaryScope` must select the same playlists on the summary
 * table, so a playlist outside the scope is never deleted.
 */
async function writeSummaries(
  db: PlaylistGradeSummaryDb,
  playlistScope: SQL,
  summaryScope: SQL,
): Promise<PlaylistGradeSummaryWriteResult> {
  const computed = await computeSummaries(db, playlistScope);

  let written = 0;
  if (computed.length > 0) {
    const rows = await db
      .insert(playlistGradeSummaries)
      .values(computed.map((summary) => ({ ...summary, updatedAt: sql`now()` })))
      .onConflictDoUpdate({
        target: playlistGradeSummaries.playlistId,
        set: {
          boardType: sql`excluded.board_type`,
          gradedClimbCount: sql`excluded.graded_climb_count`,
          minDifficulty: sql`excluded.min_difficulty`,
          p10Difficulty: sql`excluded.p10_difficulty`,
          medianDifficulty: sql`excluded.median_difficulty`,
          p90Difficulty: sql`excluded.p90_difficulty`,
          maxDifficulty: sql`excluded.max_difficulty`,
          updatedAt: sql`now()`,
        },
        // No dead tuple and no updated_at bump for a summary that did not move.
        setWhere: sql`(
          ${playlistGradeSummaries.boardType}, ${playlistGradeSummaries.gradedClimbCount},
          ${playlistGradeSummaries.minDifficulty}, ${playlistGradeSummaries.p10Difficulty},
          ${playlistGradeSummaries.medianDifficulty}, ${playlistGradeSummaries.p90Difficulty},
          ${playlistGradeSummaries.maxDifficulty}
        ) IS DISTINCT FROM (
          excluded.board_type, excluded.graded_climb_count,
          excluded.min_difficulty, excluded.p10_difficulty,
          excluded.median_difficulty, excluded.p90_difficulty,
          excluded.max_difficulty
        )`,
      })
      .returning({ playlistId: playlistGradeSummaries.playlistId });
    written = rows.length;
  }

  const stale = await db
    .delete(playlistGradeSummaries)
    .where(
      and(
        summaryScope,
        computed.length > 0
          ? notInArray(
              playlistGradeSummaries.playlistId,
              computed.map((summary) => summary.playlistId),
            )
          : undefined,
      ),
    )
    .returning({ playlistId: playlistGradeSummaries.playlistId });

  return { written, deleted: stale.length };
}

/**
 * Recompute the summaries of these playlists now. The playlist mutations call
 * this after a climb is added or removed, so the card and the grade filter see
 * the change without waiting for the daily job.
 */
export async function refreshPlaylistGradeSummariesFor(
  db: PlaylistGradeSummaryDb,
  playlistIds: readonly bigint[],
): Promise<PlaylistGradeSummaryWriteResult> {
  if (playlistIds.length === 0) return { written: 0, deleted: 0 };
  const ids = [...playlistIds];
  return writeSummaries(db, inArray(playlists.id, ids), inArray(playlistGradeSummaries.playlistId, ids));
}

/** The playlist id that closes the chunk starting after `after`, or null when the rest fits in one. */
async function nextChunkEnd(db: PlaylistGradeSummaryDb, after: bigint | null): Promise<bigint | null> {
  const [row] = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(after === null ? undefined : gt(playlists.id, after))
    .orderBy(asc(playlists.id))
    .offset(REFRESH_CHUNK_PLAYLISTS - 1)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Walk every playlist in id order and bring its summary up to date. The body
 * of the daily job and of the first backfill after the table ships.
 *
 * Covers private playlists too, not only public ones: a summary says nothing a
 * viewer who can open the playlist could not count for themselves, it is only
 * ever returned attached to a playlist the viewer can already see, and keeping
 * every playlist covered means turning a playlist public needs no recompute.
 * It is one narrow row per playlist.
 */
export async function refreshAllPlaylistGradeSummaries(
  db: PlaylistGradeSummaryDb,
  options: { shouldContinue?: () => boolean } = {},
): Promise<PlaylistGradeSummaryRefreshResult> {
  const shouldContinue = options.shouldContinue ?? (() => true);
  const result: PlaylistGradeSummaryRefreshResult = {
    written: 0,
    deleted: 0,
    chunks: 0,
    completed: false,
  };
  let after: bigint | null = null;
  for (;;) {
    if (!shouldContinue()) return result;
    const end = await nextChunkEnd(db, after);
    // (after, end]: the chunk's playlists, and the same range on the summary
    // table so a summary whose playlist lost its last graded climb is deleted.
    const chunk = await writeSummaries(
      db,
      and(after === null ? undefined : gt(playlists.id, after), end === null ? undefined : lte(playlists.id, end)) ??
        sql`true`,
      and(
        after === null ? undefined : gt(playlistGradeSummaries.playlistId, after),
        end === null ? undefined : lte(playlistGradeSummaries.playlistId, end),
      ) ?? sql`true`,
    );
    result.written += chunk.written;
    result.deleted += chunk.deleted;
    result.chunks += 1;
    if (end === null) {
      result.completed = true;
      return result;
    }
    after = end;
  }
}
