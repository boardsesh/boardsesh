import { lt } from 'drizzle-orm';
import { syncDeletions } from '@boardsesh/db/schema';
import { SYNC_DELETIONS_RETENTION_DAYS } from '@boardsesh/offline-sync';
import { db, type Database } from '../db/client';

/**
 * Retention window for sync-deletion tombstones. Mirrors the schema doc on
 * `sync_deletions` (packages/db/src/schema/app/sync-deletions.ts): tombstones
 * older than this are pruned by the daily job in server.ts.
 *
 * The value is OWNED by @boardsesh/offline-sync (sync/retention.ts) and
 * re-exported here under its long-standing name. The client's staleness guard
 * compares its deletions-coverage marker against the same number minus a
 * margin, and forces a from-scratch user-data resync when the window is blown
 * (issue #3474) — if the two sides ever forked, the gap this job opens would go
 * undetected on device again. Keep the single definition.
 *
 * Careful when LOWERING it: a client only picks up the new value with its next
 * OTA bundle, so shortening the server window strands older clients comparing
 * against the old one.
 */
export { SYNC_DELETIONS_RETENTION_DAYS };

export async function pruneSyncDeletions(database: Database = db): Promise<number> {
  const cutoff = new Date(Date.now() - SYNC_DELETIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // postgres.js RowList: `count` is the affected-row count for DELETE.
  const result = await database.delete(syncDeletions).where(lt(syncDeletions.deletedAt, cutoff));
  return result.count ?? 0;
}
