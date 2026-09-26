import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardSharedSyncs } from '../../schema/boards/unified';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Synthetic `board_shared_syncs` cursor: when the last COMPLETE Aurora shared
 * sync of a board started. Same `__local_*` namespace as the cooldown and weekly
 * cursors, so it can never collide with a table name Aurora returns.
 *
 * Why it exists: the Aurora climb_stats upsert used to restamp
 * board_climb_stats.upstream_synced_at on every row Aurora re-sent, so the row
 * stamp doubled as "an upstream pass ran". The upsert now skips rows whose values
 * did not change, and an unchanged row keeps its old stamp. This per-board marker
 * keeps the "a pass ran, and our copy matched Aurora as of then" fact, one row
 * per board instead of one write per stats row.
 *
 * The value is the pass START, not its end. Every row the pass wrote carries a
 * stamp taken after that start, so GREATEST(row stamp, this marker) equals the
 * row stamp for every row the pass re-sent and changed.
 */
export const CLIMB_STATS_PASS_CURSOR = '__local_climb_stats_pass__';

/** `YYYY-MM-DD HH:MM:SS.fff`, zoneless UTC: the text format this table already uses. */
function toCursorText(isoTimestamp: string): string {
  return new Date(isoTimestamp).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Record that a shared sync that started at `passStartedAt` (ISO string) ran to
 * Aurora's `_complete`. Never moves the marker backward, so a slow pass that
 * finishes after a newer one cannot rewind it. The fixed-width text sorts in time
 * order, so the comparison needs no cast.
 */
export async function markClimbStatsPassCompleted(
  db: DrizzleDb,
  boardType: string,
  passStartedAt: string,
): Promise<void> {
  await db
    .insert(boardSharedSyncs)
    .values({ boardType, tableName: CLIMB_STATS_PASS_CURSOR, lastSynchronizedAt: toCursorText(passStartedAt) })
    .onConflictDoUpdate({
      target: [boardSharedSyncs.boardType, boardSharedSyncs.tableName],
      set: { lastSynchronizedAt: sql`excluded.last_synchronized_at` },
      setWhere: sql`${boardSharedSyncs.lastSynchronizedAt} IS NULL
        OR ${boardSharedSyncs.lastSynchronizedAt} < excluded.last_synchronized_at`,
    });
}

/** When the board's last complete shared sync started, or null if none has been recorded. */
export async function readClimbStatsPassStartedAt(db: DrizzleDb, boardType: string): Promise<Date | null> {
  const rows = await db
    .select({ lastSynchronizedAt: boardSharedSyncs.lastSynchronizedAt })
    .from(boardSharedSyncs)
    .where(and(eq(boardSharedSyncs.boardType, boardType), eq(boardSharedSyncs.tableName, CLIMB_STATS_PASS_CURSOR)));
  const raw = rows[0]?.lastSynchronizedAt;
  if (!raw) return null;
  const parsed = Date.parse(`${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
