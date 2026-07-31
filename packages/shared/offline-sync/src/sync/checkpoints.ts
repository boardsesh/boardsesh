import type { SqlExecutor } from '../database';
import { DELETIONS_COVERAGE_KEY } from './retention';
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
 * Lower the deletions checkpoint to `watermark.updatedAt` when it currently sits AHEAD of
 * it, leaving it untouched otherwise. A scope warmed from a snapshot re-introduces
 * board rows as of the snapshot's (older) watermark; if the global deletions
 * cursor had already advanced past that point in an earlier cycle, any board-row
 * deletions in the window `(watermark, deletions-head]` were consumed while those
 * rows were absent and would never re-apply to the freshly-imported ones — a
 * stale, already-deleted climb would linger. Rewinding makes the next deletions
 * pull re-scan that window against the imported rows. A missing (fresh) deletions
 * checkpoint is already at the epoch, behind any watermark, so it is left alone.
 *
 * Deletions page on `(deleted_at, sync_deletions.id)`, not board-table
 * `sync_seq`, so the rewind target uses sequence `0` to include every tombstone
 * at the exact snapshot timestamp.
 */
export async function rewindDeletionsCheckpoint(db: SqlExecutor, watermark: SyncCheckpoint): Promise<void> {
  const current = await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY);
  const deletionCursorWatermark = { updatedAt: watermark.updatedAt, syncSeq: '0' };
  if (!current) return;
  if (compareCheckpoints(current, deletionCursorWatermark) > 0) {
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, deletionCursorWatermark);
  }
}

// Per-scope "initial download finished" marker. A checkpoint proves only that
// the FIRST page landed — a 40k-climb board pulls for minutes, and serving
// local-first reads from a fraction of the catalog (with stats still empty)
// silently truncates search results while fully online. The marker is written
// once a scope's board_climbs AND board_climb_stats pulls have both reached
// their tail; incremental re-syncs keep the data fresh from then on. It is
// deliberately NOT under the `checkpoint:` prefix so the sign-out checkpoint
// wipe (deleteUserCheckpoints/deleteAllCheckpoints) leaves it alone, matching
// the board rows it describes, which also survive as the shared cache.
// Package-internal (deliberately NOT re-exported from index.ts): scope-teardown.ts
// must clear this marker in the same transaction as the rows it describes.
export const SCOPE_COMPLETE_PREFIX = 'scope-complete:';

export async function markScopeDownloadComplete(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${SCOPE_COMPLETE_PREFIX}${scopeKey}`,
    '1',
  ]);
}

export async function isScopeDownloadComplete(db: SqlExecutor, scopeKey: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
    `${SCOPE_COMPLETE_PREFIX}${scopeKey}`,
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
  const rows = await db.getAllAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key LIKE ?', [
    `${SCOPE_COMPLETE_PREFIX}%`,
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
}
