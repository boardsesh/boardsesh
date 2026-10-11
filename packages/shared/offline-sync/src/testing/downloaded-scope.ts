// Test-only: put a board scope in the state a finished download leaves it in.
//
// A scope is readable from the device once two things are true: its
// `scope-complete:` marker is down, and every one of its protected streams has
// reached its tail since the last privacy event (issue #6306). The engine sets
// both at the end of a real download. A test that seeds rows by hand has to set
// both too, and a suite that only wrote the marker would be testing a scope in
// the middle of a protected replay.

import type { SqlExecutor } from '../database';
import { parseOfflineBoardKey } from '../offline-board-key';
import { getCheckpointKey, markScopeDownloadComplete, setProtectedCheckpoint } from '../sync/checkpoints';
import { BOARD_DATA_TABLES, boardSyncStreamsFor, refreshRevisionFor } from '../sync/table-config';

/** Stamp every protected stream of a scope as pulled to its tail, at the current revision. */
export async function markScopeProtectedComplete(db: SqlExecutor, scopeKey: string): Promise<void> {
  const boardType = parseOfflineBoardKey(scopeKey)?.boardType;
  if (!boardType) throw new Error(`Not a board scope key: ${scopeKey}`);
  for (const tableName of BOARD_DATA_TABLES) {
    if (!boardSyncStreamsFor(tableName, boardType).includes('protected')) continue;
    await setProtectedCheckpoint(db, getCheckpointKey(tableName, scopeKey), {
      updatedAt: '1970-01-01T00:00:00.000Z',
      syncSeq: '0',
      complete: true,
      revision: refreshRevisionFor(tableName, boardType) ?? 0,
    });
  }
}

/** The `scope-complete:` marker plus every protected stream at its tail. */
export async function markScopeDownloaded(db: SqlExecutor, scopeKey: string): Promise<void> {
  await markScopeDownloadComplete(db, scopeKey);
  await markScopeProtectedComplete(db, scopeKey);
}
