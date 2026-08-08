import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

type AdvisoryLockDb = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, 'execute'>;

/**
 * Seed for the 64-bit lock key: ASCII "TICK". `hashtextextended` folds the user
 * id into a bigint with this seed, so the key can't collide with another
 * feature's per-user hash. The single-bigint `pg_advisory_xact_lock` overload
 * also occupies a different lock space from the two-int overload the
 * climb-duplicate, push-token, and board-link gates use, so those can't collide
 * with this one either.
 */
const USER_TICK_MUTATION_LOCK_SEED = 0x5449434b;

/**
 * Serialize update/delete with Aurora and Kilter pull writers, including pull
 * inserts as well as mutations of existing logbook rows. Native saveTick
 * inserts and Kilter push-back do not participate in this protocol.
 *
 * This is transaction-scoped: callers must pass an existing transaction and
 * acquire it before selecting or locking any boardsesh_ticks row.
 *
 * The global order is user lock, addressed row, then direct twins in UUID
 * order. A future operation spanning multiple users must acquire the lock for
 * each user in lexicographic user-id order before taking any row lock; current
 * callers each touch one user.
 *
 * While this first ships, nodes still running the previous build take no lock
 * at all, so the lock alone can't serialize against them. The pull writers'
 * write-time `updated_at <= *_synced_at` guards cover that window and stay
 * correct once the fleet has drained.
 */
export async function acquireUserTickMutationLock(db: AdvisoryLockDb, userId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${USER_TICK_MUTATION_LOCK_SEED}::bigint))`,
  );
}
