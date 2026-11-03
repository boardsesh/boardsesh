import { and, eq, inArray, notExists, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder, type AnyPgColumn, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { userDeletedUpstreamPlaylists, type UpstreamPlaylistSource } from '../../schema/app/deleted-upstream-playlists';

type DeletedUpstreamDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
type AdvisoryLockDb = Pick<DeletedUpstreamDb, 'execute'>;

/**
 * Deleted-circuit bookkeeping (#7240): `deletePlaylist` records the upstream
 * ids of a playlist the climber deleted, and every circuit writer skips them.
 * Table, rule and re-import policy: schema/app/deleted-upstream-playlists.ts.
 *
 * Shared here, not in either sync package, because three callers need the
 * identical rows and the identical lock: the backend resolver that writes
 * them, and kilter-sync's applyCircuits and aurora-sync's circuits case that
 * read them.
 */

/** How many upstream ids to probe per statement, the bound the owner lookup uses. */
const DELETED_LOOKUP_CHUNK = 500;

/**
 * Seed for the per-user lock key: ASCII "PLST". Distinct from the tick
 * mutation lock's "TICK", so the two per-user hashes never share a key.
 */
const UPSTREAM_PLAYLIST_LOCK_SEED = 0x504c5354;

/**
 * Serialize a delete of an upstream-backed playlist with that user's circuit
 * sync. Transaction-scoped: pass a transaction.
 *
 * Without it a delete can land while a sync is mid-batch. The writer read the
 * deleted list before the delete committed, finds no playlist row when it
 * reaches that circuit, and inserts it again: the #7240 bug in a smaller
 * window. Kilter's circuits phase holds its transaction for the whole
 * snapshot, so the window is seconds, every 5 minutes.
 *
 * Order: writers take it before they read the deleted list and before they
 * write any playlist row; the resolver takes it before it reads the playlist
 * it is about to delete. Nothing that holds it then waits on a lock a writer
 * could hold while waiting for it, so the two cannot deadlock.
 */
export async function acquireUpstreamPlaylistLock(db: AdvisoryLockDb, userId: string): Promise<void> {
  await db.execute(upstreamPlaylistLockStatement(userId));
}

/**
 * The statement `acquireUpstreamPlaylistLock` executes. Exported so the sync
 * packages' stub transactions can tell it apart from the Aurora per-circuit
 * locks, whose order their tests pin.
 *
 * @internal
 */
export function upstreamPlaylistLockStatement(userId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${UPSTREAM_PLAYLIST_LOCK_SEED}::bigint))`;
}

/** `playlists.board_type` of a Kilter playlist: kilter-sync's KILTER_BOARD_TYPE. */
const KILTER_BOARD_TYPE = 'kilter';

/**
 * The (source, id) pairs `recordDeletedUpstreamPlaylist` writes for one
 * deleted playlist. Pure, so a unit test can pin every case.
 *
 * - `kilter_id` gives `('kilter', kilter_id)`.
 * - `aurora_id` gives `('aurora', aurora_id)`: an adopted Kilter playlist
 *   carries both ids, and either sync could bring it back.
 * - On a Kilter playlist, `aurora_id` ALSO gives `('kilter', aurora_id)`. A
 *   pre-split Kilter playlist that Kilter has not adopted yet carries only an
 *   `aurora_id`, and aurora-sync never syncs a Kilter credential, so the
 *   `aurora` row alone is never read. Grips kept the circuit uuid (the tier-1
 *   adoption in applyCircuits), so the same id comes back as a `kilter_id`:
 *   without this row the next Kilter cycle finds nothing to adopt and inserts
 *   a fresh playlist. A JSON import's `json-import-…` id never matches a Grips
 *   uuid, so the extra row is inert there.
 *
 * Deduped: a tier-1 adopted row has `kilter_id = aurora_id`, and one
 * `ON CONFLICT DO UPDATE` statement may not touch the same row twice.
 */
export function deletedUpstreamPlaylistKeys(input: {
  boardType: string;
  kilterId: string | null;
  auroraId: string | null;
}): Array<{ upstreamSource: UpstreamPlaylistSource; upstreamId: string }> {
  const keys = new Map<string, { upstreamSource: UpstreamPlaylistSource; upstreamId: string }>();
  const add = (upstreamSource: UpstreamPlaylistSource, upstreamId: string | null) => {
    if (upstreamId) keys.set(`${upstreamSource}:${upstreamId}`, { upstreamSource, upstreamId });
  };
  add('kilter', input.kilterId);
  add('aurora', input.auroraId);
  if (input.boardType === KILTER_BOARD_TYPE) add('kilter', input.auroraId);
  return Array.from(keys.values());
}

/**
 * Remember that `userId` deleted a playlist carrying these upstream ids: one
 * row per pair `deletedUpstreamPlaylistKeys` returns.
 *
 * A repeat delete (a JSON re-import, then a second delete) refreshes the row.
 */
export async function recordDeletedUpstreamPlaylist(
  db: DeletedUpstreamDb,
  input: { userId: string; boardType: string; kilterId: string | null; auroraId: string | null },
): Promise<void> {
  const rows = deletedUpstreamPlaylistKeys(input).map((key) => ({
    userId: input.userId,
    boardType: input.boardType,
    ...key,
  }));
  if (rows.length === 0) return;

  await db
    .insert(userDeletedUpstreamPlaylists)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        userDeletedUpstreamPlaylists.userId,
        userDeletedUpstreamPlaylists.upstreamSource,
        userDeletedUpstreamPlaylists.upstreamId,
      ],
      set: { boardType: sql`excluded.board_type`, deletedAt: sql`now()` },
    });
}

/**
 * The lookup for one chunk. `selectDeletedUpstreamPlaylistIds` awaits exactly
 * this; split out so a unit test can render it with `.toSQL()`, since the sync
 * packages' stub transactions ignore SQL and would stay green with the
 * `user_id` filter deleted, which is the filter that keeps one climber's
 * delete from hiding another climber's circuit.
 */
export function deletedUpstreamPlaylistIdsQuery(
  db: DeletedUpstreamDb,
  userId: string,
  upstreamSource: UpstreamPlaylistSource,
  upstreamIds: string[],
) {
  return db
    .select({ upstreamId: userDeletedUpstreamPlaylists.upstreamId })
    .from(userDeletedUpstreamPlaylists)
    .where(
      and(
        eq(userDeletedUpstreamPlaylists.userId, userId),
        eq(userDeletedUpstreamPlaylists.upstreamSource, upstreamSource),
        inArray(userDeletedUpstreamPlaylists.upstreamId, upstreamIds),
      ),
    );
}

/**
 * Which of `upstreamIds` this user deleted in Boardsesh. A circuit writer skips
 * every id in the result: no insert, no adoption, no update, no climbs.
 *
 * Chunked so a 500-plus circuit snapshot stays under Postgres' parameter
 * ceiling. Sequential, not Promise.all: callers pass a transaction, which rides
 * one connection PgBouncer cannot multiplex.
 */
export async function selectDeletedUpstreamPlaylistIds(
  db: DeletedUpstreamDb,
  userId: string,
  upstreamSource: UpstreamPlaylistSource,
  upstreamIds: string[],
): Promise<Set<string>> {
  const deleted = new Set<string>();
  // drizzle's inArray([]) emits invalid `IN ()` SQL that throws at the DB.
  if (upstreamIds.length === 0) return deleted;

  for (let offset = 0; offset < upstreamIds.length; offset += DELETED_LOOKUP_CHUNK) {
    const chunk = upstreamIds.slice(offset, offset + DELETED_LOOKUP_CHUNK);
    const rows = await deletedUpstreamPlaylistIdsQuery(db, userId, upstreamSource, chunk);
    for (const row of rows) deleted.add(row.upstreamId);
  }
  return deleted;
}

/**
 * Correlated `NOT EXISTS` for "this user has not deleted the playlist mirroring
 * `upstreamIdColumn`". For a statement that scans circuits rather than taking
 * a list of ids: aurora-sync's ownership-conflict state query uses it so a
 * circuit the climber deleted, which a second Boardsesh account linked to the
 * same Aurora account may since have claimed, is not reported as a
 * duplicate-account conflict.
 */
export function notDeletedUpstreamPlaylistGuard(
  userId: string,
  upstreamSource: UpstreamPlaylistSource,
  upstreamIdColumn: AnyPgColumn,
): SQL {
  return notExists(
    new QueryBuilder()
      .select({ upstreamId: userDeletedUpstreamPlaylists.upstreamId })
      .from(userDeletedUpstreamPlaylists)
      .where(
        and(
          eq(userDeletedUpstreamPlaylists.userId, userId),
          eq(userDeletedUpstreamPlaylists.upstreamSource, upstreamSource),
          eq(userDeletedUpstreamPlaylists.upstreamId, upstreamIdColumn),
        ),
      ),
  );
}

/**
 * Forget every deleted circuit for one user and board. Called when the climber
 * unlinks that board's account: a later re-link is a fresh start and imports
 * every circuit the account has, deleted ones included.
 */
export async function clearDeletedUpstreamPlaylists(
  db: DeletedUpstreamDb,
  userId: string,
  boardType: string,
): Promise<void> {
  await db
    .delete(userDeletedUpstreamPlaylists)
    .where(and(eq(userDeletedUpstreamPlaylists.userId, userId), eq(userDeletedUpstreamPlaylists.boardType, boardType)));
}
