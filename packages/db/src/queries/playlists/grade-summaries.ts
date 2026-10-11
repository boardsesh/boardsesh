import { and, asc, eq, gt, inArray, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  boardClimbAliases,
  boardClimbStats,
  playlistClimbs,
  playlistGradeSummaries,
  playlists,
} from '../../schema/index';

/**
 * Keeps `playlist_grade_summaries` in step with each playlist's climbs and
 * their grades. Three callers:
 *
 *  - The playlist mutations, with the one playlist whose climbs just changed.
 *  - The backend's daily `playlist-grade-summary-refresh` job, with every
 *    playlist in id order, `REFRESH_CHUNK_PLAYLISTS` at a time. Grades drift
 *    when an upstream catalog sync rewrites `display_difficulty`, and the
 *    Aurora and Kilter circuit syncs write `playlist_climbs` without going
 *    through the mutations, so the job is what catches both.
 *  - The nightly `refresh-recommendations` job, with each cohort playlist it
 *    rewrites, inside the transaction that swaps its climbs.
 *
 * Every write is an upsert that skips unchanged rows, plus a delete of the
 * rows whose playlist no longer has a graded climb. A rerun over unchanged
 * data costs reads and no writes (docs/postgres-query-costs.md).
 */

export type PlaylistGradeSummaryDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Playlists per job transaction. The transaction holds one advisory lock per
 * playlist on top of its relation locks, and Postgres sizes the shared lock
 * table at `max_locks_per_transaction` (64 by default) per connection, so a
 * chunk stays under that: 200 locks per transaction ran the test database out
 * of shared memory beside the other suites.
 */
export const REFRESH_CHUNK_PLAYLISTS = 50;

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
 * The climb a playlist row stands for. `addClimbToPlaylist` keeps the uuid it
 * was sent, which can be a non-canonical alias (a duplicate Kilter uuid folded
 * onto one climb), and `board_climb_stats` is keyed by the canonical uuid, so
 * both grade lookups go through `board_climb_aliases` first. Requires the
 * aliases LEFT JOIN in `computeSummaries`.
 */
const canonicalClimbUuid = sql<string>`COALESCE(${boardClimbAliases.canonicalUuid}, ${playlistClimbs.climbUuid})`;

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
        eq(fallbackStats.climbUuid, canonicalClimbUuid),
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
    // At most one alias row per (board, uuid): its primary key.
    .leftJoin(
      boardClimbAliases,
      and(
        eq(boardClimbAliases.boardType, playlists.boardType),
        eq(boardClimbAliases.aliasUuid, playlistClimbs.climbUuid),
      ),
    )
    .leftJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, playlists.boardType),
        eq(boardClimbStats.climbUuid, canonicalClimbUuid),
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
 * Namespace of the per-playlist write lock (ASCII "PGSL"). The two-int
 * `pg_advisory_xact_lock` overload keys on (namespace, playlist), so this
 * cannot collide with another feature's two-int lock under its own namespace.
 */
const PLAYLIST_GRADE_SUMMARY_LOCK_NAMESPACE = 0x5047534c;

/**
 * Take every playlist's write lock, lowest id first, for the rest of the
 * transaction. The playlist id is folded into the int4 second key; two ids
 * that fold together only ever wait for each other, never write wrong.
 */
async function lockPlaylists(db: PlaylistGradeSummaryDb, playlistIds: readonly bigint[]): Promise<void> {
  const sorted = [...playlistIds].sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));
  for (const playlistId of sorted) {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(${PLAYLIST_GRADE_SUMMARY_LOCK_NAMESPACE}, (${playlistId}::bigint % 2147483647)::int)`,
    );
  }
}

export type PlaylistGradeSummaryWriteOptions = {
  /**
   * Called after the summaries are computed and before they are written, with
   * the locks held. A test seam: it lets a regression test pause an older
   * computation while a newer climb change lands.
   */
  onComputed?: () => Promise<void>;
};

/**
 * Recompute these playlists' summaries in one transaction that holds each
 * playlist's write lock from before the read to after the write: lock, read
 * the climbs, upsert the rows whose values moved, delete the rows of
 * playlists left with no graded climb.
 *
 * Every writer of the table goes through here (the mutations, the daily job
 * and the nightly cohort-playlist rewrite), so two recomputes of one playlist never interleave. The later one
 * reads after the earlier one has written, and a climb change that commits
 * while a recompute is computing is followed by its own recompute, which waits
 * for the lock and reads it. So the last write always reflects the climbs as
 * they stand, whichever writer it came from.
 */
async function writeSummaries(
  db: PlaylistGradeSummaryDb,
  playlistIds: readonly bigint[],
  options: PlaylistGradeSummaryWriteOptions,
): Promise<PlaylistGradeSummaryWriteResult> {
  if (playlistIds.length === 0) return { written: 0, deleted: 0 };
  const ids = [...playlistIds];
  return db.transaction(async (tx) => {
    await lockPlaylists(tx, ids);
    const computed = await computeSummaries(tx, inArray(playlists.id, ids));
    await options.onComputed?.();

    let written = 0;
    if (computed.length > 0) {
      const rows = await tx
        .insert(playlistGradeSummaries)
        .values(computed)
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

    const stale = await tx
      .delete(playlistGradeSummaries)
      .where(
        and(
          inArray(playlistGradeSummaries.playlistId, ids),
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
  });
}

/** Postgres foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Whether `error` is a foreign-key violation, wherever the driver or Drizzle
 * put it: the SQLSTATE on the error or any `cause` below it, or, for a wrapper
 * that kept only the text, Postgres's own message.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 10; depth += 1) {
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (record.code === FOREIGN_KEY_VIOLATION) return true;
    if (typeof record.message === 'string' && record.message.includes('violates foreign key constraint')) return true;
    current = record.cause;
  }
  return false;
}

/**
 * `writeSummaries`, redone once if a playlist was deleted between the read and
 * the upsert. Deleting a playlist does not take its write lock, and the
 * cascade has already removed its summary, so the insert finds no row to
 * update and fails the foreign key, rolling the transaction back. The redo
 * reads again without the deleted playlist.
 */
async function writeSummariesRetryingDeletedPlaylist(
  db: PlaylistGradeSummaryDb,
  playlistIds: readonly bigint[],
  options: PlaylistGradeSummaryWriteOptions,
): Promise<PlaylistGradeSummaryWriteResult> {
  try {
    return await writeSummaries(db, playlistIds, options);
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error;
    return writeSummaries(db, playlistIds, options);
  }
}

/**
 * Recompute the summaries of these playlists now. The playlist mutations call
 * this after a climb is added or removed, so the card and the grade filter see
 * the change without waiting for the daily job.
 */
export async function refreshPlaylistGradeSummariesFor(
  db: PlaylistGradeSummaryDb,
  playlistIds: readonly bigint[],
  options: PlaylistGradeSummaryWriteOptions = {},
): Promise<PlaylistGradeSummaryWriteResult> {
  return writeSummariesRetryingDeletedPlaylist(db, playlistIds, options);
}

/** The next chunk's playlist ids, in order, after `after`. */
async function nextChunk(db: PlaylistGradeSummaryDb, after: bigint | null, chunkPlaylists: number): Promise<bigint[]> {
  const rows = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(after === null ? undefined : gt(playlists.id, after))
    .orderBy(asc(playlists.id))
    .limit(chunkPlaylists);
  return rows.map((row) => row.id);
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
 *
 * A summary whose playlist is deleted goes with it (the foreign key cascades),
 * so the pass only ever needs the playlists that exist.
 */
export async function refreshAllPlaylistGradeSummaries(
  db: PlaylistGradeSummaryDb,
  options: PlaylistGradeSummaryWriteOptions & {
    /** Checked before each chunk; returning false stops the pass where it is. */
    shouldContinue?: () => boolean;
    /** Playlists per chunk. Defaults to `REFRESH_CHUNK_PLAYLISTS`; tests set it small. */
    chunkPlaylists?: number;
  } = {},
): Promise<PlaylistGradeSummaryRefreshResult> {
  const shouldContinue = options.shouldContinue ?? (() => true);
  const chunkPlaylists = options.chunkPlaylists ?? REFRESH_CHUNK_PLAYLISTS;
  const result: PlaylistGradeSummaryRefreshResult = {
    written: 0,
    deleted: 0,
    chunks: 0,
    completed: false,
  };
  let after: bigint | null = null;
  for (;;) {
    if (!shouldContinue()) return result;
    const ids = await nextChunk(db, after, chunkPlaylists);
    if (ids.length === 0) {
      result.completed = true;
      return result;
    }
    const chunk = await writeSummariesRetryingDeletedPlaylist(db, ids, options);
    result.written += chunk.written;
    result.deleted += chunk.deleted;
    result.chunks += 1;
    if (ids.length < chunkPlaylists) {
      result.completed = true;
      return result;
    }
    after = ids[ids.length - 1];
  }
}
