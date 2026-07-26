import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardSharedSyncs } from '../../schema/boards/unified';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Synthetic `board_shared_syncs.table_name` cursors for the piggybacked
 * board-wide syncs. The `__local_*` namespace is the same one the weekly gate
 * uses (queries/sync/weekly-gate.ts) — Aurora's `/sync` never returns a table
 * by that name, so these rows can't collide with a real cursor.
 */
export const SHARED_SYNC_COOLDOWN_CURSOR = '__local_shared_sync__';
export const CATALOG_SYNC_COOLDOWN_CURSOR = '__local_catalog_sync__';

/**
 * `last_synchronized_at` is TEXT across this table, holding Aurora's
 * `YYYY-MM-DD HH:MM:SS.ffffff` (no zone, UTC). We write the `__local_*` rows
 * ourselves in exactly that shape, so the `::timestamp` cast in the CAS below
 * only ever sees values this module produced.
 */
function nowCursorText(now: Date): string {
  return now.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Try to claim the right to run a board-wide sync, returning true only for the
 * caller that wins.
 *
 * Replaces the per-process in-memory cooldown `Map`s both runners used to keep.
 * Those had two failure modes that this fixes: a restart reset the map, so the
 * first cycle after every deploy re-fired a full shared sync per board; and two
 * instances each had their own map, so overlapping containers both ran the same
 * board-wide sync — which is what produced a second full set of "new climbs
 * from <setter>" notifications, since new-climb detection is a pre-read of
 * existing uuids and neither run has committed when the other reads.
 *
 * One statement, so the read and the write cannot be split: `ON CONFLICT DO
 * UPDATE ... WHERE` evaluates the freshness test while holding the row lock,
 * and only the winner gets a row back. This is the correctness guarantee — the
 * daemon lease is only an optimisation and may be held by two instances at once
 * during a stall (see schema/app/sync-daemon-leases.ts).
 */
export async function claimSharedSyncSlot(
  db: DrizzleDb,
  options: { boardType: string; cursorName: string; cooldownMs: number; now?: Date },
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .insert(boardSharedSyncs)
    .values({
      boardType: options.boardType,
      tableName: options.cursorName,
      lastSynchronizedAt: nowCursorText(now),
    })
    .onConflictDoUpdate({
      target: [boardSharedSyncs.boardType, boardSharedSyncs.tableName],
      set: { lastSynchronizedAt: sql`excluded.last_synchronized_at` },
      // The cast on the bind parameter is deliberate: an untyped parameter can
      // arrive as `text` through postgres-js, and make_interval's `secs` is
      // double precision.
      setWhere: sql`${boardSharedSyncs.lastSynchronizedAt} IS NULL
        OR ${boardSharedSyncs.lastSynchronizedAt}::timestamp
             < (now() at time zone 'utc') - make_interval(secs => ${options.cooldownMs / 1000}::double precision)`,
    })
    .returning({ tableName: boardSharedSyncs.tableName });

  return rows.length > 0;
}

/**
 * Re-stamp the cursor once the run finishes, success or failure, so the
 * cooldown is measured from the END of a run. Matches what the in-memory maps
 * did (stamp before, stamp again after) — a slow or permanently failing
 * board-wide sync must not re-fire on the next cycle.
 */
export async function stampSharedSyncFinished(
  db: DrizzleDb,
  options: { boardType: string; cursorName: string; now?: Date },
): Promise<void> {
  await db
    .update(boardSharedSyncs)
    .set({ lastSynchronizedAt: nowCursorText(options.now ?? new Date()) })
    .where(and(eq(boardSharedSyncs.boardType, options.boardType), eq(boardSharedSyncs.tableName, options.cursorName)));
}

/** Read the cursor back — used by tests and by the runners' skip logging. */
export async function readSharedSyncCursor(
  db: DrizzleDb,
  options: { boardType: string; cursorName: string },
): Promise<Date | null> {
  const rows = await db
    .select({ lastSynchronizedAt: boardSharedSyncs.lastSynchronizedAt })
    .from(boardSharedSyncs)
    .where(and(eq(boardSharedSyncs.boardType, options.boardType), eq(boardSharedSyncs.tableName, options.cursorName)));

  const raw = rows[0]?.lastSynchronizedAt;
  if (!raw) return null;
  const parsed = Date.parse(`${raw}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
