import type { SqlExecutor } from '../database';
import { parseOfflineBoardKey } from '../offline-board-key';
import { DELETIONS_COVERAGE_KEY } from './retention';
import { LOCAL_USER_ID_KEY } from './local-user-owner';
import { BOARD_DATA_TABLES, boardSyncStreamsFor } from './table-config';

export type SyncCheckpoint = {
  updatedAt: string;
  syncSeq: string;
};

/**
 * Where one board table's PROTECTED stream has got to for one scope (issue
 * #6306). It lives inside the same `sync_meta` row as the reference cursor:
 *
 *     checkpoint:board_climbs:kilter:1:10
 *     { "updatedAt": "...", "syncSeq": "...",
 *       "protected": { "updatedAt": "...", "syncSeq": "...", "complete": true, "revision": 1 } }
 *
 * The top level is the reference cursor, in the exact shape every earlier
 * bundle wrote and reads. `protected` is absent until the stream first writes,
 * and absent means "replay from the epoch, not complete": the direction that
 * costs a few small pages and can never skip a row.
 *
 * ONE ROW, NOT A SECOND KEY, and that is the rollback story. A bundle from
 * before the split knows nothing about `protected`. Its `setCheckpoint` rewrote
 * the whole row, its privacy revalidation deleted `checkpoint:<table>:%`, and
 * its teardown deletes an exact key list. Each of those takes `protected` away
 * with the row it sits in, so whatever an older bundle does, this one finds the
 * cursor absent and replays. A cursor under a key of its own would have
 * survived all three, sitting above rows the older bundle had just deleted.
 */
export type ProtectedCheckpoint = SyncCheckpoint & {
  /**
   * The stream has reached its tail since the cursor was last reset. Sticky: a
   * later delta does not clear it, the way `scope-complete:` outlives the
   * initial download. Only a reset does.
   */
  complete: boolean;
  /**
   * The table's refresh revision this cursor was pulled at, 0 when the table
   * has none. A cursor behind the current revision is replayed from the epoch,
   * which is how the protected stream picks up a newly synced column: it is a
   * few pages, so it needs none of the reference stream's metered-link replay.
   */
  revision: number;
  /**
   * Wall-clock ms at which this stream was last pulled to its tail. Kept only
   * for the streams the pull client rations (protected stats and grades, see
   * `PROTECTED_STATS_AND_GRADES_PULL_INTERVAL_MS`); absent everywhere else, and
   * absent reads as "not pulled recently".
   */
  pulledAt?: number;
};

/**
 * The top level of a row that exists only to carry a protected cursor. The
 * stream it belongs to has no reference cursor: a spray table, or a board table
 * whose reference stream has delivered nothing yet. `referenceUnset` is how this
 * bundle tells that from a reference cursor genuinely stamped at the epoch (an
 * artifact with no row for the scope). An older bundle reads the epoch and
 * replays the table, which is correct for it.
 */
const UNSET_REFERENCE_CURSOR: SyncCheckpoint = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

type StoredCheckpointRow = Partial<Record<'updatedAt' | 'syncSeq' | 'referenceUnset' | 'protected', unknown>>;

function parseStoredCheckpoint(raw: string | null | undefined): StoredCheckpointRow | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as StoredCheckpointRow)
      : null;
  } catch {
    return null;
  }
}

function parseProtectedCheckpoint(row: StoredCheckpointRow | null): ProtectedCheckpoint | null {
  const stored = row?.protected;
  if (typeof stored !== 'object' || stored === null) return null;
  const { updatedAt, syncSeq, complete, revision, pulledAt } = stored as Record<string, unknown>;
  // Anything that is not a cursor this bundle could have written reads as
  // absent, never as a guess: a replay from the epoch is always safe.
  if (
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    typeof syncSeq !== 'string' ||
    !/^\d+$/.test(syncSeq) ||
    typeof complete !== 'boolean' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision)
  ) {
    return null;
  }
  return {
    updatedAt,
    syncSeq,
    complete,
    revision,
    ...(typeof pulledAt === 'number' && Number.isFinite(pulledAt) ? { pulledAt } : {}),
  };
}

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
 * rather than lexically, preserving PostgreSQL microseconds — mixed sub-second
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
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
    // Date.parse truncates below milliseconds. Compare the remaining digits
    // before sync_seq, which need not increase across different timestamps.
    const remainder = (timestamp: string) => (/\.(\d+)/.exec(timestamp)?.[1] ?? '').padEnd(6, '0').slice(3, 6);
    const aRemainder = remainder(a.updatedAt);
    const bRemainder = remainder(b.updatedAt);
    if (aRemainder !== bRemainder) return aRemainder < bRemainder ? -1 : 1;
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

/**
 * The scopes with an OPEN download funnel: a `scope-started:` marker and no
 * `scope-complete:` twin (issue #4452).
 *
 * `removeBoardScopeData` can ask this question one scope at a time because it
 * already knows which board is going away. The paths this exists for cannot: a
 * sign-out ends EVERY download at once, and the launch backstop is looking for
 * markers whose board nobody named at the time. Both need the whole open set
 * before they act, because the act is what destroys the evidence — the sign-out
 * wipe deletes sync_meta wholesale, and de-listing a board means the pull
 * client's `boardScopes` loop never visits that scope again.
 *
 * Two GLOB reads and a set difference rather than a `NOT EXISTS` subquery, so it
 * keeps the literal-prefix index range-scan `getDownloadedScopeKeys` relies on
 * (SQLite's default case-insensitive LIKE would scan the table instead).
 */
export async function getUnfinishedDownloadScopeKeys(db: SqlExecutor): Promise<string[]> {
  const startedRows = await db.getAllAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key GLOB ?', [
    `${SCOPE_STARTED_PREFIX}*`,
  ]);
  if (startedRows.length === 0) return [];
  const completedScopeKeys = new Set(await getDownloadedScopeKeys(db));
  return startedRows
    .map((row) => row.key.slice(SCOPE_STARTED_PREFIX.length))
    .filter((scopeKey) => !completedScopeKeys.has(scopeKey));
}

/**
 * Close one scope's funnel without touching anything else it owns (issue #4452).
 *
 * The de-listing paths — the My Boards toggle-off, and the selective sign-out
 * that empties `syncEnabledBoards` — delete no catalog rows at all: the rows and
 * their checkpoints stay so a re-enable resumes instantly. Only the funnel's own
 * bookkeeping has to go, and only once a terminal event has been emitted for it.
 * Left behind, the marker is what makes abandonment unmeasurable: this
 * download's Started stays open forever, and the NEXT download emits Completed
 * with no Started of its own.
 *
 * `scope-complete:` is deliberately NOT here — it describes rows that still
 * exist, and dropping it would make `isBoardDownloadedLocally` deny a catalog
 * sitting on disk. Neither is any `checkpoint:` key, for the same reason. An
 * exact key list, like scope-teardown's `clearScopeSyncMeta`, never a prefix
 * sweep.
 */
export async function clearScopeDownloadFunnelMarkers(db: SqlExecutor, scopeKey: string): Promise<void> {
  const keys = [`${SCOPE_STARTED_PREFIX}${scopeKey}`, `${SCOPE_DOWNLOAD_STARTED_PREFIX}${scopeKey}`];
  await db.runAsync(`DELETE FROM sync_meta WHERE key IN (${keys.map(() => '?').join(', ')})`, keys);
}

/**
 * The cursor stored at the top level of a checkpoint row. For a board table
 * that is the REFERENCE stream's cursor; for a user table and the deletions
 * stream it is the only cursor there is.
 *
 * Null when the row is missing, unreadable, or exists only to carry a protected
 * cursor (`referenceUnset`). So "no checkpoint" keeps meaning what every caller
 * already takes it to mean: this stream has consumed nothing.
 */
export async function getCheckpoint(db: SqlExecutor, key: string): Promise<SyncCheckpoint | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return parseTopLevelCheckpoint(row?.value);
}

/**
 * `getCheckpoint`'s reading of a stored value, for a caller that already holds
 * the row (the My Boards metadata batch), so the two cannot disagree about
 * whether a row is a cursor.
 */
export function parseTopLevelCheckpoint(raw: string | null | undefined): SyncCheckpoint | null {
  const stored = parseStoredCheckpoint(raw);
  if (!stored || stored.referenceUnset === true) return null;
  if (typeof stored.updatedAt !== 'string' || typeof stored.syncSeq !== 'string') return null;
  return { updatedAt: stored.updatedAt, syncSeq: stored.syncSeq };
}

/**
 * Write the top-level cursor, keeping a protected cursor the row already holds.
 *
 * One upsert rather than a read and a write, so it stays atomic for the callers
 * that run it outside a transaction. `CASE` and not `AND`: SQLite evaluates the
 * arms of a `CASE` in order, so `json_type` is never handed a value
 * `json_valid` has just rejected, which would fail the statement, and with it
 * the page it belongs to.
 */
export async function setCheckpoint(db: SqlExecutor, key: string, checkpoint: SyncCheckpoint): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = CASE WHEN json_valid(sync_meta.value) THEN
       CASE WHEN json_type(sync_meta.value, '$.protected') = 'object'
         THEN json_set(excluded.value, '$.protected', json(json_extract(sync_meta.value, '$.protected')))
         ELSE excluded.value END
       ELSE excluded.value END`,
    [key, JSON.stringify({ updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq })],
  );
}

/** The protected stream's cursor for one board table and scope, or null when it must replay. */
export async function getProtectedCheckpoint(db: SqlExecutor, key: string): Promise<ProtectedCheckpoint | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return parseProtectedCheckpoint(parseStoredCheckpoint(row?.value));
}

/**
 * Write the protected cursor, leaving the reference cursor beside it untouched.
 * A row that does not exist yet (or holds something that is not a checkpoint) is
 * created with an unset reference cursor.
 */
export async function setProtectedCheckpoint(
  db: SqlExecutor,
  key: string,
  checkpoint: ProtectedCheckpoint,
): Promise<void> {
  const protectedCursor = {
    updatedAt: checkpoint.updatedAt,
    syncSeq: checkpoint.syncSeq,
    complete: checkpoint.complete,
    revision: checkpoint.revision,
    ...(checkpoint.pulledAt === undefined ? {} : { pulledAt: checkpoint.pulledAt }),
  };
  await db.runAsync(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = CASE WHEN json_valid(sync_meta.value) THEN
       CASE WHEN json_type(sync_meta.value) = 'object'
         THEN json_set(sync_meta.value, '$.protected', json(?))
         ELSE excluded.value END
       ELSE excluded.value END`,
    [
      key,
      JSON.stringify({ ...UNSET_REFERENCE_CURSOR, referenceUnset: true, protected: protectedCursor }),
      JSON.stringify(protectedCursor),
    ],
  );
}

/** The checkpoint keys of the tables one scope pulls a protected stream for. */
function protectedCheckpointKeys(scopeKey: string): string[] {
  const boardType = parseOfflineBoardKey(scopeKey)?.boardType;
  if (!boardType) return [];
  return BOARD_DATA_TABLES.filter((tableName) => boardSyncStreamsFor(tableName, boardType).includes('protected')).map(
    (tableName) => getCheckpointKey(tableName, scopeKey),
  );
}

/**
 * Whether every protected stream of a scope has reached its tail since it was
 * last reset: the device holds every protected row the server currently lets
 * this viewer see.
 *
 * False after a privacy event until the replay finishes, and for a scope whose
 * key cannot be parsed. Read gates and the holds index use it; a scope's
 * `scope-complete:` marker does not depend on it once the first download is
 * done, because a catalogue board is still worth serving from its reference
 * rows and the climber's own.
 */
export async function isScopeProtectedComplete(db: SqlExecutor, scopeKey: string): Promise<boolean> {
  const keys = protectedCheckpointKeys(scopeKey);
  if (keys.length === 0) return false;
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM sync_meta WHERE key IN (${keys.map(() => '?').join(', ')})`,
    keys,
  );
  const completeKeys = new Set(
    rows
      .filter((row) => parseProtectedCheckpoint(parseStoredCheckpoint(row.value))?.complete === true)
      .map((row) => row.key),
  );
  return keys.every((key) => completeKeys.has(key));
}

// Both statements guard `json_*` behind `json_valid` in a `CASE`, for the reason
// on `setCheckpoint`: an unreadable row must be skipped, not fail the caller's
// transaction. For the privacy revalidation that would mean a purge that can
// never commit.
const DELETE_PROTECTED_ONLY_ROWS = `CASE WHEN json_valid(value) THEN json_extract(value, '$.referenceUnset') END = 1`;
const HOLDS_PROTECTED_CURSOR = `CASE WHEN json_valid(value) THEN json_type(value, '$.protected') END IS NOT NULL`;

/**
 * Forget how far every protected stream has got, on every board, so the next
 * pull replays them from the epoch. Reference cursors are left exactly where
 * they are.
 *
 * Mobile's privacy revalidation runs this in the SAME transaction that deletes
 * other climbers' rows. A protected cursor that outlived those rows would skip
 * them for good, because the pull is a strict `>` keyset.
 *
 * A row that only ever carried a protected cursor is deleted outright rather
 * than left as an empty shell. GLOB, not LIKE: `_` is a wildcard to LIKE, and
 * GLOB keeps the prefix range scan on `sync_meta`'s primary key.
 */
export async function resetProtectedSyncState(db: SqlExecutor): Promise<void> {
  for (const tableName of BOARD_DATA_TABLES) {
    const scopedKeys = `checkpoint:${tableName}:*`;
    await db.runAsync(`DELETE FROM sync_meta WHERE key GLOB ? AND ${DELETE_PROTECTED_ONLY_ROWS}`, [scopedKeys]);
    await db.runAsync(
      `UPDATE sync_meta SET value = json_remove(value, '$.protected') WHERE key GLOB ? AND ${HOLDS_PROTECTED_CURSOR}`,
      [scopedKeys],
    );
  }
}

/**
 * The same reset for ONE scope. The snapshot import runs it in its final
 * checkpoint transaction: reconciling against an artifact removes local rows the
 * artifact does not carry, and a few of those can be protected rows this device
 * cannot tell apart from stale reference ones. Replaying the scope's protected
 * streams puts them back.
 */
export async function resetScopeProtectedSyncState(db: SqlExecutor, scopeKey: string): Promise<void> {
  const keys = BOARD_DATA_TABLES.map((tableName) => getCheckpointKey(tableName, scopeKey));
  const keyList = keys.map(() => '?').join(', ');
  await db.runAsync(`DELETE FROM sync_meta WHERE key IN (${keyList}) AND ${DELETE_PROTECTED_ONLY_ROWS}`, keys);
  await db.runAsync(
    `UPDATE sync_meta SET value = json_remove(value, '$.protected') WHERE key IN (${keyList}) AND ${HOLDS_PROTECTED_CURSOR}`,
    keys,
  );
}

/**
 * Set once mobile's privacy revalidation has blanked the first-ascent names an
 * earlier bundle stored. Those came through the single stream, where the server
 * filled each name in for whoever was asking; the protected stream ships none.
 *
 * It sits under the stats checkpoint prefix on purpose, with a scope part no
 * real scope key can equal (a scope key always has two colons). A bundle from
 * before the split deletes `checkpoint:board_climb_stats:%` on every
 * revalidation and then pulls stats again with viewer-dependent names. Taking
 * this row with them is what makes the scrub run again when a newer bundle
 * returns. Nothing reads it as a checkpoint.
 */
export const LEGACY_FIRST_ASCENT_SCRUB_KEY = getCheckpointKey('board_climb_stats', 'legacy-first-ascent-scrub');

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
  // The board rows survive as a shared cache, and so do their reference cursors.
  // A protected cursor says how far THIS account's authorized rows were pulled,
  // so it goes with the account: the next one replays from the epoch.
  await resetProtectedSyncState(db);
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
