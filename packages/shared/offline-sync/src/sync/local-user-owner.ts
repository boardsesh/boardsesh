import type { SqlExecutor } from '../database';

/**
 * Who the local user-data tables belong to, and whether they are complete
 * enough to read from.
 *
 * Sign-out already wipes `boardsesh_ticks`, `playlists`, `user_favorites` and
 * friends (`clearUserData` → `USER_DATA_TABLES_TO_CLEAR`), but that wipe is
 * best-effort: the call swallows failures with a dev-only warning, and a
 * logged-out cold start skips it entirely. A locked database (#4314) or a crash
 * mid-sign-out therefore leaves one climber's rows on disk for the next account
 * — and the shipped local search reads ticks with no user predicate at all, so
 * that already shows user A's send glyphs to user B.
 *
 * The stamp is the defence that survives a failed wipe. It is a single
 * `sync_meta` row naming the account whose rows are on disk; every user-scoped
 * local read requires it to match the signed-in user before it serves anything,
 * and rows are additionally filtered to the stamped owner.
 *
 * It is deliberately NOT a per-table column: `playlists` and `playlist_climbs`
 * sync through a server-side ownership join and carry no user column locally,
 * so per-table predicates could never cover them. One global stamp can.
 */

/** `sync_meta` key holding the account whose user-data rows are on disk. */
export const LOCAL_USER_ID_KEY = 'local_user_id';

/**
 * "Every user-data table has been pulled to its tail at least once."
 *
 * Under the `checkpoint:` prefix on purpose, so `deleteUserCheckpoints` clears
 * it on sign-out for free. A checkpoint alone proves only that the FIRST page
 * landed, which is the same reason `markScopeDownloadComplete` exists for board
 * scopes: serving a logbook from a fraction of the rows is worse than not
 * serving one.
 *
 * Note what this is NOT gated on: a board download. User tables sync on every
 * cycle for every authenticated user regardless of which boards are downloaded,
 * so gating a tick read on a downloaded board would refuse to answer from a
 * fully synced table.
 */
export const USER_DATA_COMPLETE_KEY = 'checkpoint:user_data_complete';

export type LocalUserOwnership =
  /** The stamp names the signed-in user; user-scoped local reads may proceed. */
  | 'ok'
  /**
   * No stamp yet (fresh install, pre-upgrade database, never synced), and no
   * user row on disk names another account.
   */
  | 'unstamped'
  /**
   * The stamp names somebody else, or there is no stamp but user rows on disk
   * name another account. Do not serve; wipe and re-stamp.
   */
  | 'mismatch';

export async function getLocalUserId(db: SqlExecutor): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    LOCAL_USER_ID_KEY,
  ]);
  return row?.value ?? null;
}

export async function stampLocalUserId(db: SqlExecutor, userId: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [LOCAL_USER_ID_KEY, userId]);
}

export async function clearLocalUserId(db: SqlExecutor): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [LOCAL_USER_ID_KEY]);
}

/**
 * Whether `currentUserId` owns the user-data rows on this device.
 *
 * A missing `currentUserId` (signed out, or the JWT decode failed) can never be
 * `'ok'`: with nobody signed in there is no one to serve, and treating "unknown"
 * as a match is exactly how a shared phone leaks a logbook.
 */
export async function assertLocalUserDataOwner(
  db: SqlExecutor,
  currentUserId: string | null | undefined,
): Promise<LocalUserOwnership> {
  const stampedUserId = await getLocalUserId(db);
  if (stampedUserId === null) {
    return currentUserId && (await holdsAnotherAccountsRows(db, currentUserId)) ? 'mismatch' : 'unstamped';
  }
  if (!currentUserId) return 'mismatch';
  return stampedUserId === currentUserId ? 'ok' : 'mismatch';
}

/**
 * Whether the stamp names `userId`: the check the engine runs before it SENDS or
 * PULLS for an account (#6824).
 *
 * Stricter than `assertLocalUserDataOwner` on purpose. That one answers
 * `unstamped` for a database nobody has claimed yet, which is right for a reader
 * deciding whether to wipe. A sender cannot use it: the outbox carries no owner
 * column, and the server files every replayed write under the token that carries
 * it, so a row on an unclaimed database could belong to anyone. Only a stamp
 * that names this account says the queued writes are its own. `OfflineSyncBridge`
 * writes the stamp once the signed-in account has claimed the device, after any
 * wipe of a previous account's rows.
 */
export async function isLocalDataStampedFor(db: SqlExecutor, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return (await getLocalUserId(db)) === userId;
}

/**
 * Whether an unstamped database already holds user rows that name an account
 * other than `currentUserId`. A database restored from a backup, carried over by
 * a reinstall, or migrated from a bundle that never stamped can hold another
 * climber's synced ticks with no stamp to say so; stamping it for the signed-in
 * account would hand them over. Answering `'mismatch'` instead makes readers
 * decline and `OfflineSyncBridge` run the account wipe.
 *
 * Only `boardsesh_ticks` and `user_favorites` carry a user column, so only they
 * can tell. Rows with no `user_id` say nothing either way: they are this
 * device's own offline writes made before the stamp existed, which must survive,
 * or a legacy row from before the writer stamped `user_id`, which cannot be told
 * apart. Playlists, follows and the outbox carry no user column at all.
 */
async function holdsAnotherAccountsRows(db: SqlExecutor, currentUserId: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ found: number }>(
    `SELECT (
       EXISTS (SELECT 1 FROM boardsesh_ticks WHERE user_id IS NOT NULL AND user_id <> ?)
       OR EXISTS (SELECT 1 FROM user_favorites WHERE user_id IS NOT NULL AND user_id <> ?)
     ) AS found`,
    [currentUserId, currentUserId],
  );
  return Boolean(row?.found);
}

export async function markUserDataComplete(db: SqlExecutor): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [USER_DATA_COMPLETE_KEY, '1']);
}

export async function isUserDataComplete(db: SqlExecutor): Promise<boolean> {
  const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
    USER_DATA_COMPLETE_KEY,
  ]);
  return row !== null;
}

/**
 * The gate every user-scoped local reader shares: the rows are complete AND
 * they belong to the signed-in climber. Anything else declines, and the caller
 * falls through to the network rather than fabricating an answer.
 */
export async function canServeLocalUserData(
  db: SqlExecutor,
  currentUserId: string | null | undefined,
): Promise<boolean> {
  if ((await assertLocalUserDataOwner(db, currentUserId)) !== 'ok') return false;
  return isUserDataComplete(db);
}
