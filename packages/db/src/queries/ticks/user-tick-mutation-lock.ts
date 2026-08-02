import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

type AdvisoryLockDb = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, 'execute'>;

/** Shared namespace/seed for both rollout lock keys: ASCII "TICK". */
const USER_TICK_MUTATION_LOCK_NAMESPACE = 0x5449434b;

/**
 * Serialize update/delete with Aurora and Kilter pull writers, including pull
 * inserts as well as mutations of existing logbook rows. Native saveTick
 * inserts and Kilter push-back do not participate in this protocol.
 *
 * This is transaction-scoped: callers must pass an existing transaction and
 * acquire it before selecting or locking any boardsesh_ticks row.
 *
 * Rolling-deploy compatibility requires TWO lock keys in this exact order:
 * first the legacy two-int key used by already-deployed nodes, then the 64-bit
 * extended-hash key new nodes use. Separate awaited statements make acquisition
 * order deterministic; SQL SELECT-list evaluation order must not be relied on.
 * Keep the legacy acquisition until every node capable of running the old
 * helper has drained in a later rollout.
 *
 * The global order is legacy user lock, extended user lock, addressed row, then
 * direct twins in UUID order. A future operation spanning multiple users must
 * acquire both locks for each user in lexicographic user-id order before taking
 * any row lock; current callers each touch one user.
 */
export async function acquireUserTickMutationLock(db: AdvisoryLockDb, userId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${USER_TICK_MUTATION_LOCK_NAMESPACE}, hashtext(${userId}))`);
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${USER_TICK_MUTATION_LOCK_NAMESPACE}::bigint))`,
  );
}
