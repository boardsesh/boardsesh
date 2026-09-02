import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client';

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run a seed inside a transaction that may supply its own sync cursors.
 *
 * Migration 0205 makes the catalog cursors database-owned: BEFORE INSERT
 * triggers stamp `board_climbs.updated_at`/`sync_seq`,
 * `board_climb_stats.updated_at`/`sync_seq`,
 * `board_climb_grades.computed_at`/`sync_seq` and `sync_deletions.deleted_at`
 * from the transaction timestamp, overwriting whatever the statement passed.
 * Tests that need historical or hand-ordered cursors turn on the superuser-only
 * restore hatch with `SET LOCAL`, so the bypass dies with the transaction
 * instead of leaking into the rest of the suite (which must keep exercising the
 * production stamping path).
 *
 * UPDATE statements are deliberately NOT covered — restore mode preserves
 * INSERT history only, matching the trigger contract.
 */
export async function withRestoredSyncCursors<T>(seed: (tx: TransactionClient) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL boardsesh.snapshot_cursor_restore = 'on'`);
    return seed(tx);
  });
}

/** `withRestoredSyncCursors` for the common case: a few INSERTs, in order. */
export async function seedWithRestoredSyncCursors(...statements: SQL[]): Promise<void> {
  await withRestoredSyncCursors(async (tx) => {
    for (const statement of statements) {
      await tx.execute(statement);
    }
  });
}
