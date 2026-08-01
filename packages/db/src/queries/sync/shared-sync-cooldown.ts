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

export type SharedSyncClaimToken = string;

/**
 * `last_synchronized_at` is TEXT across this table, holding Aurora's
 * `YYYY-MM-DD HH:MM:SS.ffffff` (no zone, UTC). Synthetic cooldown rows append
 * `#claim:<uuid>` or `#finished:<uuid>` to that timestamp. The UUID is generated
 * by PostgreSQL in the same statement as the marker write, so even callers
 * with identical or badly skewed clocks can never reuse an ownership token.
 * Existing timestamp-only rows remain compatible: every read/cast uses the
 * portion before the first `#`.
 */
function dbCursorValue(kind: 'claim' | 'finished', backdateMs = 0) {
  return sql<string>`to_char(
    (clock_timestamp() at time zone 'utc')
      - make_interval(secs => ${backdateMs / 1000}::double precision),
    'YYYY-MM-DD HH24:MI:SS.US'
  ) || ${`#${kind}:`} || gen_random_uuid()::text`;
}

/**
 * Try to claim the right to run a board-wide sync, returning the exact cursor
 * token only to the caller that wins (and null to every refused caller).
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
  options: {
    boardType: string;
    cursorName: string;
    cooldownMs: number;
    /** @deprecated Ignored. PostgreSQL is the sole clock and identity source. */
    now?: Date;
  },
): Promise<SharedSyncClaimToken | null> {
  const claimToken = dbCursorValue('claim');
  const rows = await db
    .insert(boardSharedSyncs)
    .values({
      boardType: options.boardType,
      tableName: options.cursorName,
      lastSynchronizedAt: claimToken,
    })
    .onConflictDoUpdate({
      target: [boardSharedSyncs.boardType, boardSharedSyncs.tableName],
      // Generate a fresh value on the UPDATE path too. Reusing
      // excluded.last_synchronized_at would still be DB-clock based, but this
      // makes the ownership identity local to the lock-protected winning write.
      set: { lastSynchronizedAt: dbCursorValue('claim') },
      setWhere: sql`${boardSharedSyncs.lastSynchronizedAt} IS NULL
        OR split_part(${boardSharedSyncs.lastSynchronizedAt}, '#', 1)::timestamp
             < (clock_timestamp() at time zone 'utc')
               - make_interval(secs => ${options.cooldownMs / 1000}::double precision)`,
    })
    .returning({ claimToken: boardSharedSyncs.lastSynchronizedAt });

  return rows[0]?.claimToken ?? null;
}

/**
 * Re-stamp the cursor once the run finishes so the next cooldown is measured
 * from the END of the run. The stored value remains a synthetic
 * "last-synchronized" timestamp: a cooldown shorter than the configured full
 * cooldown is represented by backdating the marker by the difference.
 *
 * Finalization is fenced by the exact token returned from
 * {@link claimSharedSyncSlot}. A stalled caller that finishes after another
 * daemon has reclaimed the row cannot overwrite that newer claim. Returning
 * false means ownership changed and the cursor was deliberately left alone.
 *
 * `nextCooldownMs` is clamped to the range 0..`fullCooldownMs`. This keeps an
 * accidental longer value from pushing the synthetic marker into the future,
 * and lets callers safely request a five-minute retry when the configured full
 * cooldown is already shorter than five minutes.
 */
export async function stampSharedSyncFinished(
  db: DrizzleDb,
  options: {
    boardType: string;
    cursorName: string;
    claimToken: SharedSyncClaimToken;
    fullCooldownMs: number;
    nextCooldownMs?: number;
    /** @deprecated Ignored. PostgreSQL is the sole clock source. */
    now?: Date;
  },
): Promise<boolean> {
  const fullCooldownMs = Math.max(0, options.fullCooldownMs);
  const requestedNextCooldownMs = options.nextCooldownMs ?? fullCooldownMs;
  const nextCooldownMs = Math.max(0, Math.min(requestedNextCooldownMs, fullCooldownMs));
  const eligibilityBackdateMs = fullCooldownMs - nextCooldownMs;
  const rows = await db
    .update(boardSharedSyncs)
    .set({ lastSynchronizedAt: dbCursorValue('finished', eligibilityBackdateMs) })
    .where(
      and(
        eq(boardSharedSyncs.boardType, options.boardType),
        eq(boardSharedSyncs.tableName, options.cursorName),
        eq(boardSharedSyncs.lastSynchronizedAt, options.claimToken),
      ),
    )
    .returning({ tableName: boardSharedSyncs.tableName });

  return rows.length > 0;
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
  // Stored as `YYYY-MM-DD HH:MM:SS.ffffff` (space-separated, no zone, UTC),
  // optionally followed by the synthetic marker's unique identity suffix.
  // Restore the 'T' before appending 'Z' so this is real ISO 8601 rather than
  // relying on V8 accepting the space-separated form.
  const timestampText = raw.split('#', 1)[0];
  const parsed = Date.parse(`${timestampText.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
