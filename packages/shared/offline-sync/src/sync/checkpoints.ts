import type { SqlExecutor } from '../database';

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
// their tail; incremental re-syncs keep the data fresh from then on.
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

/**
 * Drop every row of sync_meta — checkpoints, `scope-complete:`, and the snapshot
 * `bootstrap-done:` / `bootstrap-attempts:` markers alike.
 *
 * Sign-out's wipe (connection.ts's clearLocalData) deletes every table sync_meta
 * describes, board reference rows included, so this is the matching reset: a marker
 * outlasting its rows is the unrecoverable direction. A surviving `scope-complete:`
 * makes isBoardDownloadedLocally serve an empty catalog to local-first search as if
 * it were the whole board, and a surviving checkpoint makes the strict `>` delta pull
 * resume past rows that are gone and never revisit them.
 *
 * A blunt `DELETE FROM sync_meta` rather than a prefix sweep for exactly that reason:
 * the marker families are deliberately spread across three modules and two prefix
 * conventions (see SCOPE_COMPLETE_PREFIX above and snapshot-bootstrap.ts's), so any
 * pattern here is a list someone must remember to extend. `board_climb_grades` fell
 * through precisely that kind of hardcoded list once already. Whole-table is the one
 * form that cannot go stale.
 *
 * Removing ONE scope while others stay is the opposite problem — see
 * scope-teardown.ts's exact-key clearScopeSyncMeta, which must not touch a retained
 * scope's markers or the global `checkpoint:deletions` cursor.
 */
export async function deleteAllSyncMeta(db: SqlExecutor): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta');
}
