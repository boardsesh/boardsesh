import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

type AdvisoryLockDb = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, 'execute'>;

/** Two-key advisory-lock namespace: ASCII "TICK". */
const USER_TICK_MUTATION_LOCK_NAMESPACE = 0x5449434b;

/**
 * Serialize every writer that can mutate a user's logbook identity/payload.
 *
 * This is transaction-scoped: callers must pass an existing transaction and
 * acquire it before selecting or locking any boardsesh_ticks row. The global
 * order is advisory user lock first, then the addressed row, then direct twins
 * in UUID order. A future operation spanning multiple users must acquire these
 * locks in lexicographic user-id order before taking any row lock; current
 * callers each touch one user.
 */
export async function acquireUserTickMutationLock(db: AdvisoryLockDb, userId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${USER_TICK_MUTATION_LOCK_NAMESPACE}, hashtext(${userId}))`);
}
