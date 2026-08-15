import type { SqlExecutor } from '../database';
import { DELETIONS_COVERAGE_KEY } from './retention';
import { LOCAL_USER_ID_KEY } from './local-user-owner';
import { BOARD_DATA_TABLES } from './table-config';

export type SyncCheckpoint = {
  updatedAt: string;
  syncSeq: string;
};

/**
 * Checkpoint key for a table. For per-board tables `scope` is the encoded board
 * scope key (`"boardType:layoutId:sizeId"`), so each downloaded board resumes from
 * its own cursor — e.g. `checkpoint:board_climbs:kilter:1:5`.
 */
export function getCheckpointKey(tableName: string, scope?: string): string {
  return scope ? `checkpoint:${tableName}:${scope}` : `checkpoint:${tableName}`;
}

// The single deletions checkpoint key. Deletions are global (a user's own plus
// reference-data deletions), so there is exactly one, not one per table/scope.
// Exported so the snapshot bootstrap can rewind it against a snapshot watermark.
export const DELETIONS_CHECKPOINT_KEY = 'checkpoint:deletions';

/**
 * Order two checkpoints on the composite keyset `(updatedAt, syncSeq)`, the same
 * ordering the sync resolvers page on. `updatedAt` is compared as an instant
 * (Date.parse) rather than lexically — ISO strings with mixed sub-second
 * precision (`…00Z` vs `…00.5Z`) misorder under a raw string compare. `syncSeq`
 * is a decimal string that can exceed Number's safe range, so it is compared via
 * BigInt (a raw string compare would rank `'9'` above `'10'`). Returns <0 when
 * `a` precedes `b`, 0 when equal, >0 when `a` follows `b`. An unparseable
 * `updatedAt` sorts as equal-timestamp so the seq tiebreak still applies; an
 * unparseable `syncSeq` (a corrupt sync_meta row — every server cursor is
 * Zod-validated) sorts as seq 0 rather than crashing the sync cycle.
 */
export function compareCheckpoints(a: SyncCheckpoint, b: SyncCheckpoint): number {
  const aTime = Date.parse(a.updatedAt);
  const bTime = Date.parse(b.updatedAt);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime < bTime ? -1 : 1;
  }
  const aSeq = toSeqBigInt(a.syncSeq);
  const bSeq = toSeqBigInt(b.syncSeq);
  return aSeq < bSeq ? -1 : aSeq > bSeq ? 1 : 0;
}

function toSeqBigInt(rawSeq: string): bigint {
  try {
    return BigInt(rawSeq);
  } catch {
    return 0n;
  }
}

/**
 * Lower the deletions checkpoint to `replayFrom.updatedAt` when it currently sits
 * AHEAD of it, leaving it untouched otherwise. A scope warmed from a snapshot
 * re-introduces board rows from an older database view; if the global deletions
 * cursor had already advanced past that view in an earlier cycle, tombstones
 * consumed while those rows were absent would never re-apply to the freshly
 * imported ones. Rewinding makes the next deletions pull re-scan that window.
 * New artifacts provide a conservative export-transaction boundary; older
 * artifacts use their scoped row watermark. A missing (fresh) deletions
 * checkpoint is already at the epoch, behind either target, so it is left alone.
 *
 * Deletions page on `(deleted_at, sync_deletions.id)`, not board-table
 * `sync_seq`, so the rewind target uses sequence `0` to include every tombstone
 * at the exact snapshot timestamp.
 */
export async function rewindDeletionsCheckpoint(db: SqlExecutor, replayFrom: SyncCheckpoint): Promise<void> {
  const current = await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY);
  const deletionCursorWatermark = { updatedAt: replayFrom.updatedAt, syncSeq: '0' };
  if (!current) return;
  if (compareCheckpoints(current, deletionCursorWatermark) > 0) {
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, deletionCursorWatermark);
  }
}

// Per-scope "initial download finished" marker. A checkpoint proves only that
// the FIRST page landed — a 40k-climb board pulls for minutes, and serving
// local-first reads from a fraction of the catalog (with stats still empty)
// silently truncates search results while fully online. The marker is written
// once every BOARD_DATA_TABLES pull (climbs, stats, and grades) has reached its
// tail; incremental re-syncs keep the data fresh from then on. It is
// deliberately NOT under the `checkpoint:` prefix, so it survives the SELECTIVE
// checkpoint wipe (deleteUserCheckpoints/deleteAllCheckpoints) a forced sign-out
// runs, matching the board rows it describes, which survive there as the shared
// cache. An explicit, confirmed sign-out deletes those rows instead, so it wipes
// sync_meta whole and this marker goes with them — see deleteAllSyncMeta below.
// Package-internal (deliberately NOT re-exported from index.ts): scope-teardown.ts
// must clear this marker in the same transaction as the rows it describes.
export const SCOPE_COMPLETE_PREFIX = 'scope-complete:';

/**
 * "This device started downloading scope X at wall-clock T." Persisted because
 * the in-memory start map lives for exactly one `pullSync` run, so a download
 * that spans cycles — the normal shape for a 100 MB Kilter artifact on a phone
 * that backgrounds once — used to report only the FINAL cycle's work as
 * `durationMs` (issue #4310). Deliberately NOT under the `checkpoint:` prefix:
 * `deleteAllCheckpoints`' `LIKE 'checkpoint:%'` must not reach it, so every
 * clearing site is explicit (scope completion, scope teardown, sign-out).
 */
export const SCOPE_DOWNLOAD_STARTED_PREFIX = 'scope-download-started:';

/**
 * Anything older than this is not a download, it is a stamp nobody cleared —
 * a crash between the stamp and the completion, an app the user did not open
 * for a week, a clock that moved. Reporting 9 days as a download duration would
 * poison the p50 far worse than reporting nothing, so the caller emits a null
 * duration instead. Same posture as the deletions-coverage plausibility floor.
 */
export const SCOPE_DOWNLOAD_START_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The wall-clock this scope's download started, creating the stamp at `nowMs`
 * when there isn't one. Returns the EFFECTIVE start — the persisted value when
 * it exists, `nowMs` otherwise — so a caller never has to read it back.
 */
export async function ensureScopeDownloadStartedAt(db: SqlExecutor, scopeKey: string, nowMs: number): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    `${SCOPE_DOWNLOAD_STARTED_PREFIX}${scopeKey}`,
  ]);
  const persisted = row ? Number(row.value) : Number.NaN;
  if (Number.isFinite(persisted) && persisted > 0) return persisted;
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${SCOPE_DOWNLOAD_STARTED_PREFIX}${scopeKey}`,
    String(nowMs),
  ]);
  return nowMs;
}

export async function clearScopeDownloadStarted(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`${SCOPE_DOWNLOAD_STARTED_PREFIX}${scopeKey}`]);
}

export async function markScopeDownloadComplete(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${SCOPE_COMPLETE_PREFIX}${scopeKey}`,
    '1',
  ]);
  // The download is over, so the start stamp describes nothing. Clearing it
  // here (rather than only on teardown) is what keeps a later re-download —
  // e.g. after a schema bump forces a fresh crawl — measuring its own time.
  await clearScopeDownloadStarted(db, scopeKey);
}

export async function isScopeDownloadComplete(db: SqlExecutor, scopeKey: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
    `${SCOPE_COMPLETE_PREFIX}${scopeKey}`,
  ]);
  return row !== null;
}

/**
 * The Started half of the download funnel (issue #4316) — the exact mirror of
 * SCOPE_COMPLETE_PREFIX above, and durable for the same reason.
 *
 * Without a marker, Started is neither an upper nor a lower bound on the
 * completion rate, and it fails in BOTH directions. A paged crawl that spans
 * cycles writes a board-table checkpoint on its first page, and
 * `runBootstrapPhase` treats any existing checkpoint as ineligible — so the
 * slow, most-likely-abandoned population would emit Completed with no Started at
 * all. Meanwhile a snapshot scope that fails and retries would emit one Started
 * per cycle. The marker makes it once-ever per scope per download lifecycle,
 * matching what `wasScopeComplete` already gives Completed, so Started →
 * Completed is a real ratio.
 *
 * Same lifecycle rules as the completion marker, for the same reasons: NOT under
 * the `checkpoint:` prefix, so the sign-out wipe leaves it alone (matching the
 * board rows, which survive as a shared cache), and package-internal so
 * scope-teardown can clear it in the same transaction as those rows — removing
 * and re-adding a board must start a fresh funnel.
 */
export const SCOPE_STARTED_PREFIX = 'scope-started:';

export async function markScopeDownloadStarted(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${SCOPE_STARTED_PREFIX}${scopeKey}`,
    '1',
  ]);
}

export async function isScopeDownloadStarted(db: SqlExecutor, scopeKey: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
    `${SCOPE_STARTED_PREFIX}${scopeKey}`,
  ]);
  return row !== null;
}

/**
 * The encoded board scope keys ("boardType:layoutId:sizeId") whose initial
 * download completed — both reference tables pulled to the tail. Used by the
 * My Boards UI as the per-scope "available offline" signal (a completed
 * cycle's global lastSyncedAt can't tell one board from another, and a mere
 * checkpoint only proves the first page landed).
 */
export async function getDownloadedScopeKeys(db: SqlExecutor): Promise<string[]> {
  // GLOB preserves the literal-prefix range optimization on sync_meta's binary
  // primary-key index; SQLite's default case-insensitive LIKE scans the table.
  const rows = await db.getAllAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key GLOB ?', [
    `${SCOPE_COMPLETE_PREFIX}*`,
  ]);
  return rows.map((row) => row.key.slice(SCOPE_COMPLETE_PREFIX.length));
}

export async function getCheckpoint(db: SqlExecutor, key: string): Promise<SyncCheckpoint | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SyncCheckpoint;
  } catch {
    return null;
  }
}

export async function setCheckpoint(db: SqlExecutor, key: string, checkpoint: SyncCheckpoint): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, JSON.stringify(checkpoint)]);
}

export async function deleteCheckpoint(db: SqlExecutor, key: string): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [key]);
}

export async function deleteAllCheckpoints(db: SqlExecutor): Promise<void> {
  await db.runAsync("DELETE FROM sync_meta WHERE key LIKE 'checkpoint:%'");
}

/**
 * Drop every row of sync_meta — checkpoints, `scope-complete:`, the snapshot
 * `bootstrap-done:` / `bootstrap-attempts:` markers and the deletions-coverage key
 * alike.
 *
 * This is the reset that belongs with a wipe of every table sync_meta describes,
 * board reference rows included (mobile's `purgeLocalDataForSignOut`, issue #3621).
 * A marker outliving its rows is the unrecoverable direction: a surviving
 * `scope-complete:` makes `isBoardDownloadedLocally` serve an empty catalog to
 * local-first search as though it were the whole board, and a surviving checkpoint
 * makes the strict `>` delta pull resume past rows that are gone and never revisit
 * them.
 *
 * Deliberately a blunt `DELETE FROM sync_meta` rather than a prefix sweep, for
 * exactly that reason: the marker families sit across three modules and two prefix
 * conventions (SCOPE_COMPLETE_PREFIX above, snapshot-bootstrap.ts's BOOTSTRAP_*),
 * so any pattern here is a list someone must remember to extend, and
 * `board_climb_grades` fell through precisely that kind of hardcoded list once
 * already. Whole-table is the one form that cannot go stale.
 *
 * `schema_version` is its own table, not a sync_meta key, so the migration state
 * survives this untouched.
 *
 * Removing ONE scope while others stay is the opposite problem — see
 * scope-teardown.ts's exact-key `clearScopeSyncMeta`, which must not touch a
 * retained scope's markers or the global `checkpoint:deletions` cursor. A forced
 * sign-out is the middle case and keeps `deleteUserCheckpoints`.
 */
export async function deleteAllSyncMeta(db: SqlExecutor): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta');
}

/**
 * Reset only the user-scoped checkpoints (user tables + deletions), preserving every
 * board reference table's checkpoint — currently `checkpoint:board_climbs:*`,
 * `checkpoint:board_climb_stats:*`, and `checkpoint:board_climb_grades:*` (see
 * BOARD_DATA_TABLES in table-config.ts, derived from each TABLE_CONFIGS entry's
 * `isPerBoard` flag). Used on sign-out: the board rows survive as the shared cache
 * (connection.ts's USER_DATA_TABLES_TO_CLEAR excludes them), so their checkpoints
 * must survive too — otherwise the next sign-in re-crawls hundreds of thousands of
 * rows from epoch for every board table.
 *
 * The exclusion list is built FROM BOARD_DATA_TABLES rather than hardcoded per table,
 * so adding a new per-board reference table (isPerBoard: true in TABLE_CONFIGS)
 * automatically preserves its checkpoint here too — no second place to remember to
 * update. board_climb_grades previously fell through this exact gap (its rows are
 * board reference data and are never cleared, but its checkpoint wasn't on the
 * hardcoded NOT-LIKE list, so it was wiped on every sign-out).
 *
 * The deletions-coverage marker goes too, even though it is not a `checkpoint:`
 * key. It describes how much of the tombstone stream THIS account consumed, and
 * sign-out rewinds the deletions cursor to the epoch, so it describes nothing
 * afterwards. Left behind, a departing user's stale marker would trip the
 * coverage guard on the NEXT account's first pull: a wasted network probe and a
 * reset of tables sign-out already emptied, reported as a
 * `OfflineSyncCoverageResetForced` with `rowsCleared: 0`. The new account
 * re-stamps it when its own first deletions pull reaches the tail.
 */
export async function deleteUserCheckpoints(db: SqlExecutor): Promise<void> {
  const preserveBoardTableClauses = BOARD_DATA_TABLES.map(() => 'AND key NOT LIKE ?').join('\n       ');
  const preserveBoardTableParams = BOARD_DATA_TABLES.map((tableName) => `checkpoint:${tableName}:%`);
  await db.runAsync(
    `DELETE FROM sync_meta
     WHERE key LIKE 'checkpoint:%'
       ${preserveBoardTableClauses}`,
    preserveBoardTableParams,
  );
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [DELETIONS_COVERAGE_KEY]);
  // The owner stamp goes too, for the same reason as the coverage marker: it
  // describes the departing account's rows, which this sign-out is deleting.
  // Left behind, it would vouch for a wipe that may have partly failed. Its
  // companion `checkpoint:user_data_complete` is `checkpoint:`-prefixed and is
  // therefore already covered by the DELETE above.
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [LOCAL_USER_ID_KEY]);
  // Every in-flight download start stamp goes too. It is not a `checkpoint:`
  // key, so the DELETE above cannot reach it, and a stamp left behind by the
  // departing account would be read months later by the next one — reporting a
  // multi-week `durationMs` for a download that took two minutes. GLOB keeps
  // the literal-prefix range scan on sync_meta's binary primary key.
  await db.runAsync('DELETE FROM sync_meta WHERE key GLOB ?', [`${SCOPE_DOWNLOAD_STARTED_PREFIX}*`]);
}
